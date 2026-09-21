import { stringify } from "yaml";
import { ApplicationError, ProfileCommitError } from "./errors.js";
import {
  type ExplorationDiagnostic,
  ExplorationError,
  type ExplorationProgress,
} from "./exploration.js";
import { parseConcept } from "./profile-document.js";
import { dueSlot, end, metadata, start, summary } from "./project-documents.js";
import type { DiscoveryPorts, DiscoverySettings, RepositoryIdentity } from "./project-ports.js";

export type ProjectStatus = {
  id: string;
  path: string;
  root: string;
  name: string;
  availability: "available" | "missing";
  error: string | null;
  document: string | null;
  phase?: "queued" | "checking" | "done" | "interrupted" | ExplorationProgress["phase"];
  outcome?: "updated" | "unchanged" | "failed" | "unverified";
  lastSuccess?: string;
  startedAt?: string;
  finishedAt?: string;
  previousError?: string | null;
  model?: string;
  sessionId?: string;
  filesRead?: number;
  diagnostic?: ExplorationDiagnostic;
};
export type ScanStatus = {
  running: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  completedSlot: string | null;
  error: string | null;
  projects: ProjectStatus[];
  phase: "idle" | "discovering" | "reviewing";
  completed: number;
  total: number;
  lastFinished: string | null;
  nextRetry: string | null;
};

export class ProjectScanner {
  private state: ScanStatus;
  private active: Promise<void> | null = null;
  constructor(
    private settings: DiscoverySettings,
    private io: DiscoveryPorts,
    private now = () => new Date(),
  ) {
    const saved = io.loadStatus();
    this.state = {
      lastAttempt: null,
      lastSuccess: null,
      completedSlot: null,
      error: null,
      projects: [],
      completed: 0,
      total: 0,
      lastFinished: null,
      nextRetry: null,
      ...saved,
      running: false,
      phase: "idle",
    };
    if (saved.running) {
      this.state.error = "The previous scan was interrupted. Retry to finish reviewing projects.";
      for (const project of this.state.projects) {
        if (project.phase && project.phase !== "done") project.phase = "interrupted";
      }
    }
  }
  status() {
    return this.state;
  }
  isRunning() {
    return !!this.active;
  }
  async close() {
    await this.active;
  }
  reset() {
    this.state = {
      running: false,
      lastAttempt: null,
      lastSuccess: null,
      completedSlot: null,
      error: null,
      projects: [],
      phase: "idle",
      completed: 0,
      total: 0,
      lastFinished: null,
      nextRetry: null,
    };
    this.persist();
  }
  invalidate() {
    this.state.completedSlot = null;
    this.state.lastAttempt = null;
    this.state.nextRetry = null;
    this.persist();
  }
  request(scheduled = false, projectIds?: string[]) {
    if (
      projectIds?.some(
        (id) =>
          !this.status().projects.some(
            (project) => project.id === id && this.settings.projectRoots.includes(project.root),
          ),
      )
    )
      throw new ApplicationError("invalid", "Choose projects from the configured directories.");
    void this.run(scheduled, projectIds);
    return this.status();
  }
  run(scheduled = false, projectIds?: string[]) {
    if (this.active) return this.active;
    if (!this.settings.projectRoots.length && !this.io.profileExists(this.settings.profilePath))
      return Promise.resolve();
    const slot = dueSlot(this.now(), this.settings.timezone);
    const skipReview =
      scheduled &&
      (this.state.completedSlot === slot ||
        (this.state.nextRetry && this.now().getTime() < Date.parse(this.state.nextRetry)));
    this.active = (async () => {
      if (skipReview) {
        const profile = this.io.profile(this.settings.profilePath);
        if (!profile.isGit()) throw new Error("Profile unavailable");
        profile.refresh();
        if (this.state.error?.startsWith("Profile index reconciliation failed:")) {
          this.state.error = null;
          this.state.nextRetry = null;
        }
      } else {
        await this.scan(slot, projectIds);
      }
    })()
      .catch((error: Error) => {
        this.state.error =
          error instanceof ProfileCommitError ||
          error.message.startsWith("Profile index reconciliation failed:")
            ? error.message
            : "Project scan failed. Check profile access and retry.";
        if (skipReview) {
          this.state.completedSlot = null;
          this.state.nextRetry ??= new Date(this.now().getTime() + 15 * 60000).toISOString();
        }
      })
      .finally(() => {
        this.state.running = false;
        this.state.phase = "idle";
        if (!skipReview) {
          this.state.lastFinished = this.now().toISOString();
          this.state.nextRetry =
            this.state.error || this.state.projects.some((project) => project.error)
              ? new Date(this.now().getTime() + 15 * 60000).toISOString()
              : null;
        }
        if (this.state.nextRetry) this.state.completedSlot = null;
        this.active = null;
        try {
          this.persist();
        } catch {
          this.state.error = "Cannot save scan status. Check local data directory access.";
        }
      });
    return this.active;
  }
  private persist() {
    this.io.saveStatus(this.state);
  }
  private async scan(slot: string, projectIds?: string[]) {
    this.state.running = true;
    this.state.lastAttempt = this.now().toISOString();
    this.state.error = null;
    this.state.phase = "discovering";
    this.state.completed = 0;
    this.state.total = 0;
    this.state.nextRetry = null;
    this.persist();
    const profile = this.io.profile(this.settings.profilePath);
    if (!profile.isGit()) throw new Error("Profile unavailable");
    const records = profile
      .documents()
      .filter((doc) => metadata(doc).data.project_discovery === true);
    const seen = new Set<string>();
    const scannedRoots = new Set<string>();
    const problems: string[] = [];
    const rootProblems: string[] = [];
    const projects: ProjectStatus[] = [];
    const previousProjects = [...this.state.projects];
    for (const root of this.settings.projectRoots) {
      let children: RepositoryIdentity[];
      try {
        children = await this.io.repositories(root);
        scannedRoots.add(root);
      } catch {
        rootProblems.push(`Cannot read project root: ${root}`);
        continue;
      }
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const { path, id } = child;
        if (seen.has(id)) continue;
        seen.add(id);
        const doc = records.find((doc) => metadata(doc).data.repository_id === id);
        const project: ProjectStatus = {
          ...previousProjects.find((item) => item.id === id),
          id,
          path,
          root,
          name: child.name,
          availability: "available",
          error: previousProjects.find((item) => item.id === id)?.error ?? null,
          document: doc?.path ?? null,
        };
        projects.push(project);
      }
    }
    this.state.projects = projects;
    const selected = projects.filter((project) => !projectIds || projectIds.includes(project.id));
    for (const project of selected) {
      project.previousError = project.error;
      project.error = null;
      project.phase = "queued";
      project.outcome = undefined;
      project.startedAt = undefined;
      project.finishedAt = undefined;
      project.sessionId = undefined;
      project.diagnostic = undefined;
      project.filesRead = 0;
    }
    this.state.total = selected.length;
    this.state.phase = "reviewing";
    this.persist();
    for (const project of selected) {
      const { path, id } = project;
      const doc = records.find((doc) => metadata(doc).data.repository_id === id);
      project.phase = "checking";
      project.startedAt = this.now().toISOString();
      project.model = this.settings.connection().model;
      this.persist();
      let documentChanged = false;
      try {
        if (await this.io.isProfileRepository(path, profile.root)) {
          projects.splice(projects.indexOf(project), 1);
          this.state.total--;
          continue;
        }
        const file = doc?.path ?? `project-${id}.md`;
        project.document = file;
        if (!doc)
          profile.add(
            file,
            `---\n${stringify({ type: "Project", title: project.name, description: `Discovered Git project: ${project.name}`, project_discovery: true, repository_id: id, repository_name: project.name, availability: "available" })}---\n\n${start}\n${end}\n\n## Personal notes\n\n`,
          );
        const snapshot = await this.io.snapshot(path);
        const before = profile.documents().find((item) => item.path === file);
        if (!before) throw new Error("Profile document unavailable");
        const old = metadata(before);
        let current = before;
        if (old.data.repository_fingerprint !== snapshot.fingerprint) {
          const draft = await this.io.explore({
            repository: path,
            document: before,
            model: this.settings.connection().model,
            onProgress: (progress) => {
              Object.assign(project, progress);
            },
          });
          project.phase = "validating";
          try {
            current = { ...before, ...parseConcept(draft, file) };
          } catch (error) {
            throw new Error(
              `OpenCode produced invalid profile content: ${(error as Error).message}`,
            );
          }
          if (JSON.stringify(metadata(current).data) !== JSON.stringify(old.data))
            throw new Error(
              "OpenCode changed protected profile metadata. The draft was rejected; retry the scan.",
            );
          this.persist();
          const previousBody = old.body;
          const currentBody = metadata(current).body;
          summary(before);
          if (
            previousBody.split(start)[0] !== currentBody.split(start)[0] ||
            previousBody.split(end)[1]?.replace(/[\r\n]+$/, "") !==
              currentBody.split(end)[1]?.replace(/[\r\n]+$/, "") ||
            !summary(current)
          )
            throw new Error(
              "OpenCode changed protected profile content or produced an empty summary. The draft was rejected; retry the scan.",
            );
          if (previousBody.split(end)[1] !== currentBody.split(end)[1]) {
            const restored =
              current.content.slice(0, current.content.indexOf(end) + end.length) +
              previousBody.split(end)[1];
            current = { ...before, ...parseConcept(restored, file) };
          }
          if ((await this.io.snapshot(path)).fingerprint !== snapshot.fingerprint)
            throw new Error("Repository changed during review; retry the scan.");
        }
        const knowledgeChanged =
          !doc || summary(current) !== summary(before) || old.data.availability !== "available";
        const data = {
          ...metadata(current).data,
          repository_fingerprint: snapshot.fingerprint,
          availability: "available",
          updated_at: knowledgeChanged ? this.now().toISOString() : old.data.updated_at,
        };
        const content = `---\n${stringify(data)}---\n${metadata(current).body}`;
        profile.apply(before, content, () => {
          documentChanged = true;
        });
        project.outcome = knowledgeChanged ? "updated" : "unchanged";
        project.lastSuccess = this.now().toISOString();
        project.previousError = null;
      } catch (error) {
        project.error =
          error instanceof Error &&
          (error instanceof ProfileCommitError ||
            /changed during|markers|OpenCode|Profile document/.test(error.message))
            ? error.message
            : "Could not review this project. Check repository access and model settings, then retry.";
        project.outcome = "failed";
        if (documentChanged) project.outcome = "unverified";
        project.diagnostic =
          error instanceof ExplorationError
            ? error.diagnostic
            : {
                category:
                  (project as ProjectStatus).phase === "validating" ? "validation" : "review",
                message: project.error,
                exitCode: (error as { code?: string | number })?.code,
              };
        problems.push(project.name);
      } finally {
        project.phase = "done";
        project.finishedAt = this.now().toISOString();
        if (projects.includes(project)) this.state.completed++;
        this.persist();
      }
    }
    for (const doc of records) {
      const data = metadata(doc).data;
      if (typeof data.repository_name !== "string" || data.repository_name.includes("/")) continue;
      for (const root of this.settings.projectRoots) {
        const { path, id } = this.io.identity(root, data.repository_name);
        if (id === data.repository_id && !previousProjects.some((item) => item.id === id))
          previousProjects.push({
            id,
            path,
            root,
            name: data.repository_name,
            availability: "available",
            document: doc.path,
            error: null,
          });
      }
    }
    for (const previous of previousProjects) {
      if (seen.has(previous.id) || !this.settings.projectRoots.includes(previous.root)) continue;
      if (!scannedRoots.has(previous.root)) {
        projects.push(previous);
        continue;
      }
      const doc = records.find((doc) => metadata(doc).data.repository_id === previous.id);
      if (doc) {
        const { data, body } = metadata(doc);
        if (data.availability !== "missing")
          profile.markMissing(
            doc,
            `---\n${stringify({ ...data, availability: "missing", updated_at: this.now().toISOString() })}---\n${body}`,
          );
      }
      projects.push({ ...previous, availability: "missing", error: null });
    }
    this.state.projects = projects;
    profile.refresh();
    if (problems.length || rootProblems.length)
      this.state.error = [
        ...(problems.length
          ? [
              `${problems.length} project${problems.length === 1 ? "" : "s"} could not be updated. See the project diagnostics below.`,
            ]
          : []),
        ...rootProblems,
      ].join(" ");
    else if (!projectIds) {
      this.state.lastSuccess = this.now().toISOString();
      this.state.completedSlot = slot;
    }
  }
}
