import type {
  Project,
  ProjectAction,
  ProjectChanges,
  ProjectGit,
  ProjectInsights,
  ProjectWorkspace,
} from "../../shared/projects.js";
import type { ProfileDocument } from "../../shared/schema.js";
import { ApplicationError } from "./errors.js";
import { metadata } from "./project-documents.js";

export interface ProjectWorkspaceIO {
  discover(
    roots: string[],
    profile: string,
  ): Promise<{
    repositories: { id: string; name: string; path: string; root: string }[];
    errors: string[];
  }>;
  validate(project: Project): Promise<void>;
  inspect(path: string): Promise<ProjectGit>;
  refreshRemote(path: string, git: ProjectGit): Promise<void>;
  insights(
    url: string,
    options?: {
      force?: boolean;
      previous?: ProjectInsights | null;
      onUpdate?(insights: ProjectInsights): void;
    },
  ): Promise<ProjectInsights>;
  changes(path: string): Promise<ProjectChanges>;
  execute(path: string, action: ProjectAction, git: ProjectGit): Promise<void>;
}

export function createProjectWorkspace(deps: {
  records: { projects(profile: string): Project[]; saveProject(project: Project): void };
  scope(): { profile: string; roots: string[] };
  documents(): ProfileDocument[];
  io: ProjectWorkspaceIO;
  now(): string;
}) {
  let active: Promise<void> | null = null;
  let foreground = false;
  let lastLocal = 0;
  let lastScope = "";
  let errors: string[] = [];
  const busy = new Set<string>();
  const refreshing = new Set<string>();
  const checking = new Set<string>();
  const generations = new Map<string, number>();
  const fetching = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  function withLatestVisibility(project: Project): Project {
    const current = deps.records.projects(project.profileRoot).find((p) => p.id === project.id);
    return { ...project, hidden: current?.hidden ?? project.hidden };
  }
  const snapshot = (): ProjectWorkspace => {
    const { profile, roots } = deps.scope();
    return {
      projects: deps.records.projects(profile).filter((p) => roots.includes(p.root)),
      refreshing: foreground || refreshing.size > 0,
      refreshingIds: [...refreshing],
      errors,
    };
  };
  async function refresh(remote: boolean) {
    const { profile, roots } = deps.scope();
    const previous = deps.records.projects(profile);
    const discovered = await deps.io.discover(roots, profile);
    errors = discovered.errors;
    const documents = deps.documents();
    const documentPaths = new Map<string, string>();
    for (const document of documents) {
      const id = metadata(document).data?.repository_id;
      if (typeof id === "string") documentPaths.set(id, document.path);
    }
    const queue = [...discovered.repositories];
    const seen = new Set(queue.map((p) => p.id));
    for (const old of previous) {
      if (roots.includes(old.root) && !seen.has(old.id)) {
        if (!checking.has(old.id)) refreshing.delete(old.id);
        deps.records.saveProject(
          withLatestVisibility({ ...old, error: "Checkout unavailable. Check its directory." }),
        );
      }
    }
    for (const entry of queue) {
      if (busy.has(entry.id) || checking.has(entry.id)) continue;
      const generation = generations.get(entry.id) ?? 0;
      const canSave = () => !busy.has(entry.id) && (generations.get(entry.id) ?? 0) === generation;
      if (remote || !previous.some((project) => project.id === entry.id)) refreshing.add(entry.id);
      const job = (async () => {
        const old = deps.records.projects(profile).find((p) => p.id === entry.id);
        const project: Project = {
          profileRoot: profile,
          document: null,
          documentSource: "discovery",
          returnToDefault: true,
          hidden: false,
          git: null,
          insights: null,
          checkedAt: null,
          remoteCheckedAt: null,
          remoteError: null,
          ...old,
          ...entry,
          error: null,
        };
        project.document =
          project.documentSource === "manual"
            ? documents.some((doc) => doc.path === project.document)
              ? project.document
              : null
            : (documentPaths.get(project.id) ?? null);
        checking.add(project.id);
        try {
          await deps.io.validate(project);
          project.git = await deps.io.inspect(project.path);
          project.checkedAt = deps.now();
          if (
            old?.git?.repositoryUrl !== project.git.repositoryUrl ||
            old?.git?.remote !== project.git.remote
          ) {
            project.insights = null;
            project.remoteCheckedAt = null;
            project.remoteAttemptedAt = undefined;
            project.remoteError = null;
          }
          if (canSave()) deps.records.saveProject(withLatestVisibility(project));
          await Promise.all([
            (async () => {
              const attempted = project.remoteAttemptedAt ?? project.remoteCheckedAt;
              if (
                !canSave() ||
                !project.git?.remote ||
                (!remote && attempted && Date.parse(deps.now()) - Date.parse(attempted) < 5 * 60000)
              )
                return;
              project.remoteAttemptedAt = deps.now();
              if (canSave()) deps.records.saveProject(withLatestVisibility(project));
              try {
                const fetch = deps.io.refreshRemote(project.path, project.git);
                fetching.set(project.id, fetch);
                try {
                  await fetch;
                } finally {
                  fetching.delete(project.id);
                }
                project.git = await deps.io.inspect(project.path);
                project.remoteCheckedAt = deps.now();
                project.remoteError = null;
              } catch {
                project.remoteError =
                  "Remote check failed. Check network access and Git credentials, then retry.";
              }
              if (canSave()) deps.records.saveProject(withLatestVisibility(project));
            })(),
            (async () => {
              const url = project.git?.repositoryUrl;
              if (!url) return;
              project.insights = await deps.io.insights(url, {
                force: remote,
                previous: project.insights,
                onUpdate: (insights) => {
                  project.insights = insights;
                  if (canSave()) deps.records.saveProject(withLatestVisibility(project));
                },
              });
            })(),
          ]);
        } catch {
          project.error = "Cannot inspect this checkout. Check repository access, then refresh.";
        }
        try {
          if (canSave()) deps.records.saveProject(withLatestVisibility(project));
        } finally {
          checking.delete(project.id);
          refreshing.delete(project.id);
        }
      })();
      pending.add(job);
      void job.finally(() => pending.delete(job)).catch(() => {});
    }
    lastLocal = Date.parse(deps.now());
  }
  function request(remote: boolean) {
    if (!active) {
      foreground = remote || !snapshot().projects.length;
      lastScope = JSON.stringify(deps.scope());
      if (remote) for (const project of snapshot().projects) refreshing.add(project.id);
      active = refresh(remote)
        .catch(() => {
          errors = ["Project refresh failed. Check directory and profile access."];
        })
        .finally(() => {
          active = null;
          foreground = false;
          for (const id of refreshing) if (!checking.has(id)) refreshing.delete(id);
        });
    }
    return snapshot();
  }
  function find(id: string) {
    const project = snapshot().projects.find((p) => p.id === id);
    if (!project)
      throw new ApplicationError("not-found", "Project not found in configured directories.");
    return project;
  }
  async function detail(id: string) {
    const project = find(id);
    const generation = generations.get(id) ?? 0;
    try {
      await deps.io.validate(project);
      const git = await deps.io.inspect(project.path);
      const changes = await deps.io.changes(project.path);
      const next = withLatestVisibility({ ...find(id), git, error: null, checkedAt: deps.now() });
      if (!busy.has(id) && (generations.get(id) ?? 0) === generation)
        deps.records.saveProject(next);
      return { project: next, changes };
    } catch {
      const next = withLatestVisibility({
        ...project,
        git: null,
        error: "Checkout unavailable. Check its directory and refresh.",
      });
      if (!busy.has(id) && (generations.get(id) ?? 0) === generation)
        deps.records.saveProject(next);
      return { project: next, changes: { files: [], diff: "", commits: [] } };
    }
  }
  async function perform(id: string, input: ProjectAction) {
    if (busy.has(id))
      throw new ApplicationError("conflict", "An action is already running for this project.");
    const project = find(id);
    busy.add(id);
    generations.set(id, (generations.get(id) ?? 0) + 1);
    try {
      await fetching.get(id)?.catch(() => {});
      await deps.io.validate(project);
      const git = await deps.io.inspect(project.path);
      if (git.version !== input.version)
        throw new ApplicationError(
          "conflict",
          "The checkout changed. Refresh and review it before trying again.",
        );
      await deps.io.execute(project.path, input, git);
    } finally {
      try {
        const next = await detail(id);
        deps.records.saveProject(withLatestVisibility(next.project));
      } catch {
        /* The checkout can become unavailable while Git is running. */
      } finally {
        busy.delete(id);
      }
    }
    return detail(id);
  }
  return {
    async list() {
      if (active) return snapshot();
      if (
        lastScope !== JSON.stringify(deps.scope()) ||
        Date.parse(deps.now()) - lastLocal >= 15000
      ) {
        request(false);
      }
      return snapshot();
    },
    refresh: () => request(true),
    detail,
    action(id: string, input: ProjectAction) {
      const job = perform(id, input);
      pending.add(job);
      void job.finally(() => pending.delete(job)).catch(() => {});
      return job;
    },
    update(
      id: string,
      fields: { returnToDefault?: boolean; document?: string | null; hidden?: boolean },
    ) {
      const project = find(id);
      if (fields.document && !deps.documents().some((doc) => doc.path === fields.document))
        throw new ApplicationError("invalid", "Choose an existing profile document.");
      if (busy.has(id) && (fields.returnToDefault !== undefined || fields.document !== undefined))
        throw new ApplicationError("conflict", "Wait for the current project action to finish.");
      if (fields.returnToDefault !== undefined || fields.document !== undefined)
        generations.set(id, (generations.get(id) ?? 0) + 1);
      const next = {
        ...project,
        ...fields,
        ...(fields.document !== undefined ? { documentSource: "manual" as const } : {}),
      };
      deps.records.saveProject(next);
      return next;
    },
    async close() {
      await active;
      await Promise.allSettled(pending);
    },
  };
}
