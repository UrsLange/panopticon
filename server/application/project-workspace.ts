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
  refreshRemote(path: string): Promise<void>;
  insights(url: string): Promise<ProjectInsights>;
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
  let lastLocal = 0;
  let lastScope = "";
  let errors: string[] = [];
  const busy = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  function withLatestVisibility(project: Project): Project {
    const current = deps.records.projects(project.profileRoot).find((p) => p.id === project.id);
    return { ...project, hidden: current?.hidden ?? project.hidden };
  }
  const snapshot = (): ProjectWorkspace => {
    const { profile, roots } = deps.scope();
    return {
      projects: deps.records.projects(profile).filter((p) => roots.includes(p.root)),
      refreshing: !!active,
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
    const insights = new Map<string, Promise<ProjectInsights>>();
    const seen = new Set(queue.map((p) => p.id));
    for (const old of previous) {
      if (roots.includes(old.root) && !seen.has(old.id))
        deps.records.saveProject(
          withLatestVisibility({ ...old, error: "Checkout unavailable. Check its directory." }),
        );
    }
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
          if (busy.has(entry.id)) continue;
          const old = previous.find((p) => p.id === entry.id);
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
          busy.add(project.id);
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
              project.remoteError = null;
            }
            if (remote && project.git.remote) {
              try {
                await deps.io.refreshRemote(project.path);
                project.git = await deps.io.inspect(project.path);
                project.remoteCheckedAt = deps.now();
                project.remoteError = null;
              } catch {
                project.remoteError =
                  "Remote check failed. Check network access and Git credentials, then retry.";
              }
              if (project.git.repositoryUrl) {
                const url = project.git.repositoryUrl;
                const request = insights.get(url) ?? deps.io.insights(url);
                insights.set(url, request);
                project.insights = await request;
              }
            }
          } catch {
            project.error = "Cannot inspect this checkout. Check repository access, then refresh.";
          }
          try {
            deps.records.saveProject(withLatestVisibility(project));
          } finally {
            busy.delete(project.id);
          }
        }
      }),
    );
    lastLocal = Date.parse(deps.now());
  }
  function request(remote: boolean) {
    if (!active) {
      lastScope = JSON.stringify(deps.scope());
      active = refresh(remote)
        .catch(() => {
          errors = ["Project refresh failed. Check directory and profile access."];
        })
        .finally(() => {
          active = null;
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
    try {
      await deps.io.validate(project);
      const git = await deps.io.inspect(project.path);
      const changes = await deps.io.changes(project.path);
      const next = withLatestVisibility({ ...project, git, error: null, checkedAt: deps.now() });
      if (!busy.has(id)) deps.records.saveProject(next);
      return { project: next, changes };
    } catch {
      const next = withLatestVisibility({
        ...project,
        git: null,
        error: "Checkout unavailable. Check its directory and refresh.",
      });
      if (!busy.has(id)) deps.records.saveProject(next);
      return { project: next, changes: { files: [], diff: "", commits: [] } };
    }
  }
  async function perform(id: string, input: ProjectAction) {
    if (busy.has(id))
      throw new ApplicationError("conflict", "An action is already running for this project.");
    const project = find(id);
    busy.add(id);
    try {
      await deps.io.validate(project);
      const git = await deps.io.inspect(project.path);
      if (git.version !== input.version)
        throw new ApplicationError(
          "conflict",
          "The checkout changed. Refresh and review it before trying again.",
        );
      await deps.io.execute(project.path, input, git);
    } finally {
      busy.delete(id);
      try {
        await detail(id);
      } catch {
        /* The checkout can become unavailable while Git is running. */
      }
    }
    return detail(id);
  }
  return {
    async list() {
      if (active) return snapshot();
      if (
        lastScope !== JSON.stringify(deps.scope()) ||
        Date.parse(deps.now()) - lastLocal > 15000
      ) {
        request(false);
        await active;
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
      if (
        (active || busy.has(id)) &&
        (fields.returnToDefault !== undefined || fields.document !== undefined)
      )
        throw new ApplicationError(
          "conflict",
          "Wait for the current project refresh or action to finish.",
        );
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
