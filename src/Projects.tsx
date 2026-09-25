import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  BookOpen,
  ExternalLink,
  EyeOff,
  FilePenLine,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Workflow,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type Project,
  type ProjectAction,
  type ProjectAttention,
  type ProjectDetail,
  type ProjectWorkspace,
  projectAttention,
  projectAttentionOrder,
  projectNeedsAttention,
} from "../shared/projects";
import type { ProfileDocument, Settings } from "../shared/schema";
import { api } from "./api";
import { useUnsavedSettings } from "./useUnsavedSettings";
import "./projects.css";

const icons = {
  local: FilePenLine,
  incoming: ArrowDownToLine,
  branch: GitBranch,
  reviews: GitPullRequest,
  security: ShieldAlert,
  pipelines: Workflow,
};
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "Not checked yet";

export function Projects({
  active,
  settings,
  documents,
  onProfileSave,
  onSettings,
}: {
  active: boolean;
  settings: Settings;
  documents: ProfileDocument[];
  onProfileSave(): Promise<void>;
  onSettings(): void;
}) {
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("attention");
  const [showHidden, setShowHidden] = useState(false);
  const [root, setRoot] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [action, setAction] = useState<{ kind: ProjectAttention; detail: ProjectDetail } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profileDirty, setProfileDirty] = useState(false);
  const modal = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const refreshDetail = useRef(false);
  const detailId = useRef<string | null>(null);
  const lastRemoteCheck = useRef(0);
  const report = useCallback(
    (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not update projects."),
    [],
  );
  const reload = useCallback(async () => {
    setWorkspace(await api<ProjectWorkspace>("/project-workspace"));
  }, []);
  const refresh = useCallback(async () => {
    setError("");
    lastRemoteCheck.current = Date.now();
    setWorkspace(await api<ProjectWorkspace>("/project-workspace/refresh", "POST", {}));
  }, []);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<ProjectWorkspace>("/project-workspace");
        if (stopped) return;
        setWorkspace(next);
        if (refreshDetail.current && !next.refreshing) {
          refreshDetail.current = false;
          const current = request.current;
          const selected = detailId.current;
          if (selected) {
            const fresh = await api<ProjectDetail>(`/project-workspace/${selected}`);
            if (!stopped && current === request.current)
              setDetail((value) => (value?.project.id === selected ? fresh : value));
          }
        }
        if (Date.now() - lastRemoteCheck.current > 10 * 60 * 1000) {
          await refresh();
        }
      } catch (reason) {
        if (!stopped) report(reason);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, refresh, report]);
  useEffect(() => {
    detailId.current = detail?.project.id ?? null;
  }, [detail?.project.id]);
  useEffect(() => {
    if (action && !modal.current?.open) modal.current?.showModal();
  }, [action]);
  const closeAction = () => {
    if (busy) return;
    modal.current?.close();
    setAction(null);
  };
  const open = async (project: Project, kind?: ProjectAttention) => {
    if (profileDirty && !window.confirm("Discard your unsaved profile edits?")) return;
    const current = ++request.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await api<ProjectDetail>(`/project-workspace/${project.id}`);
      if (current !== request.current) return;
      if (kind) setAction({ kind, detail: next });
      else {
        setDetail(next);
        setProfileDirty(false);
      }
    } catch (reason) {
      report(reason);
    } finally {
      if (current === request.current) setLoading(false);
    }
  };
  const perform = async (project: Project, input: Omit<ProjectAction, "version">, push = false) => {
    if (!project.git || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    let committed = false;
    try {
      let next = await api<ProjectDetail>(`/project-workspace/${project.id}/actions`, "POST", {
        ...input,
        version: project.git.version,
      });
      committed = input.action === "commit";
      if (push && next.project.git)
        next = await api<ProjectDetail>(`/project-workspace/${project.id}/actions`, "POST", {
          action: "push",
          version: next.project.git.version,
        });
      setDetail((current) => (current?.project.id === project.id ? next : current));
      setAction(null);
      modal.current?.close();
      setNotice(
        `${project.name}: ${push ? "committed and pushed" : { commit: "committed", pull: "updated", push: "pushed", merge: "merged", switch: "switched to the default branch" }[input.action]}.`,
      );
      await reload();
    } catch (reason) {
      setError(
        `${committed ? "The commit succeeded, but publishing did not. " : ""}${reason instanceof Error ? reason.message : "Git action failed."}`,
      );
      try {
        const next = await api<ProjectDetail>(`/project-workspace/${project.id}`);
        setDetail((current) => (current?.project.id === project.id ? next : current));
        setAction((current) =>
          current?.detail.project.id === project.id ? { ...current, detail: next } : current,
        );
        await reload();
      } catch {
        /* Keep the original operation error if the checkout is unavailable. */
      }
    } finally {
      setBusy(false);
    }
  };
  const actFromTile = (project: Project, kind: ProjectAttention) => {
    const git = project.git;
    if (
      kind === "incoming" &&
      git &&
      !project.remoteError &&
      project.remoteCheckedAt &&
      git.behind &&
      !git.dirty &&
      !git.ahead &&
      !git.operation
    )
      void perform(project, { action: "pull" });
    else if (
      kind === "branch" &&
      git?.defaultBranch &&
      git.branch &&
      !git.dirty &&
      !git.ahead &&
      (git.upstream || !git.remote) &&
      !git.operation
    )
      void perform(project, { action: "switch" });
    else void open(project, kind);
  };
  const included = workspace?.projects.filter((project) => showHidden || !project.hidden) ?? [];
  const attention = included.filter(projectNeedsAttention).length;
  const search = query.trim().toLowerCase();
  const visible = included
    .filter(
      (project) =>
        (!root || project.root === root) &&
        (search
          ? `${project.name} ${project.path}`.toLowerCase().includes(search)
          : filter === "all" || projectNeedsAttention(project)),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const changeProject = async (fields: {
    returnToDefault?: boolean;
    document?: string | null;
    hidden?: boolean;
  }) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const project = await api<Project>(
        `/project-workspace/${detail.project.id}`,
        "PATCH",
        fields,
      );
      setDetail({ ...detail, project });
      await reload();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };
  const project = detail?.project;
  const linkedDocument = documents.find((doc) => doc.path === project?.document);
  return (
    <section className="projects-page" aria-label="Projects workspace">
      <div className="projects-heading">
        <div>
          {detail && (
            <button
              type="button"
              className="text-button projects-back"
              onClick={() => {
                if (profileDirty && !window.confirm("Discard your unsaved profile edits?")) return;
                setDetail(null);
                setProfileDirty(false);
                setError("");
              }}
            >
              <ArrowLeft size={16} />
              Projects
            </button>
          )}
          <h1>{project?.name ?? "Projects"}</h1>
          <p>
            {project
              ? project.path
              : workspace
                ? `${attention} ${attention === 1 ? "project needs" : "projects need"} your attention.`
                : "Finding your projects…"}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy || workspace?.refreshing}
          onClick={() => {
            refreshDetail.current = !!detail;
            void refresh().catch(report);
          }}
        >
          {workspace?.refreshing ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <RefreshCw size={16} />
          )}{" "}
          {workspace?.refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>
      {!action && error && (
        <div role="alert" className="banner error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="project-notice">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="muted-text">
          Opening project…
        </p>
      )}
      {workspace?.errors.map((message) => (
        <p role="alert" className="warning-text" key={message}>
          {message}
        </p>
      ))}
      {!detail ? (
        <>
          <div className="projects-toolbar">
            <div className="projects-filters">
              <button
                type="button"
                aria-pressed={filter === "attention" && !search}
                onClick={() => {
                  setFilter("attention");
                  setQuery("");
                }}
              >
                Attention <span>{attention}</span>
              </button>
              <button
                type="button"
                aria-pressed={filter === "all" && !search}
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                All projects <span>{included.length}</span>
              </button>
            </div>
            <div className="projects-searches">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                Show hidden projects
              </label>
              {settings.projectRoots.length > 1 && (
                <select
                  aria-label="Filter project directory"
                  value={root}
                  onChange={(event) => setRoot(event.target.value)}
                >
                  <option value="">All directories</option>
                  {settings.projectRoots.map((path) => (
                    <option value={path} key={path}>
                      {path}
                    </option>
                  ))}
                </select>
              )}
              <label className="projects-search">
                <Search size={16} />
                <input
                  aria-label="Search all projects"
                  placeholder="Search all projects"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="projects-grid">
            {visible.map((project) => {
              const actions = projectAttention(project);
              return (
                <article className="project-tile" key={project.id} aria-label={project.name}>
                  <button
                    type="button"
                    className="project-name"
                    title={`${project.name}\n${project.path}`}
                    disabled={busy || loading}
                    onClick={() => void open(project)}
                  >
                    {project.name}
                  </button>
                  <div className="project-branch" title={project.git?.branch ?? "Detached HEAD"}>
                    {project.hidden && <EyeOff size={13} aria-label="Hidden project" />}
                    <GitBranch size={13} />
                    <span>
                      {project.git?.branch ??
                        (project.git ? "Detached HEAD" : "Checkout unavailable")}
                    </span>
                  </div>
                  <div className="project-icon-slots">
                    {projectAttentionOrder.map((kind) => {
                      const label = actions[kind];
                      const Icon =
                        kind === "local" && !project.git?.dirty && project.git?.ahead
                          ? ArrowUpFromLine
                          : icons[kind];
                      const links =
                        kind === "reviews"
                          ? project.insights?.reviews
                          : kind === "security"
                            ? project.insights?.findings
                            : kind === "pipelines"
                              ? project.insights?.pipelines?.failures
                              : undefined;
                      const className = `project-slot ${(kind === "security" || kind === "pipelines") && links?.length ? "project-risk" : ""}`;
                      return !label ? (
                        <span className="project-slot-empty" aria-hidden="true" key={kind} />
                      ) : (
                        <span className="project-action-tip" key={kind}>
                          {links?.length === 1 ? (
                            <a
                              className={className}
                              href={links[0].url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`${label}: ${project.name}`}
                            >
                              <Icon size={18} />
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={className}
                              disabled={busy || loading}
                              aria-label={`${label}: ${project.name}`}
                              onClick={() => actFromTile(project, kind)}
                            >
                              <Icon size={18} />
                            </button>
                          )}
                          <span className="project-tooltip" role="tooltip">
                            {label}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          {workspace && !visible.length && (
            <div className="projects-empty">
              <FolderGit2 size={28} />
              <h2>
                {search || root
                  ? "No matching projects"
                  : !included.length && workspace.projects.length
                    ? "All projects are hidden"
                    : workspace.projects.length
                      ? "Nothing needs your attention"
                      : "No projects detected"}
              </h2>
              <p>
                {search || root
                  ? "Try another name or directory."
                  : !included.length && workspace.projects.length
                    ? "Enable Show hidden projects to find and restore a project."
                    : workspace.projects.length
                      ? "Search to open any project, or show all projects."
                      : "Choose directories containing your Git repositories in Settings."}
              </p>
              {!workspace.projects.length && (
                <button type="button" className="secondary" onClick={onSettings}>
                  Configure directories
                </button>
              )}
            </div>
          )}
          <details className="project-icon-guide">
            <summary>Action icon guide</summary>
            <div>
              {projectAttentionOrder.map((kind) => {
                const Icon = icons[kind];
                return (
                  <span key={kind}>
                    <Icon size={16} />
                    {
                      {
                        local: "Commit & push",
                        incoming: "Incoming changes",
                        branch: "Return to default branch",
                        reviews: "Requested reviews",
                        security: "Dependabot alerts",
                        pipelines: "Failing default-branch pipelines",
                      }[kind]
                    }
                  </span>
                );
              })}
            </div>
            <p>
              Positions stay fixed. A missing icon means no known action. Access failures remain
              visible.
            </p>
          </details>
        </>
      ) : (
        <div className="project-details">
          <section className="project-info-panel">
            <div className="section-title">
              <h2>Checkout</h2>
              {project?.git?.repositoryUrl && (
                <a
                  className="text-button"
                  href={project.git.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Repository <ExternalLink size={14} />
                </a>
              )}
            </div>
            <dl className="project-facts">
              <div>
                <dt>Branch</dt>
                <dd>{project?.git?.branch ?? "Detached HEAD"}</dd>
              </div>
              <div>
                <dt>Default branch</dt>
                <dd>{project?.git?.defaultBranch ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Upstream</dt>
                <dd>{project?.git?.upstream ?? "Not configured"}</dd>
              </div>
              <div>
                <dt>Remote checked</dt>
                <dd>{date(project?.remoteCheckedAt)}</dd>
              </div>
            </dl>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!project?.hidden}
                disabled={busy}
                onChange={(event) => void changeProject({ hidden: event.target.checked })}
              />
              Hide project from dashboard
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!project?.returnToDefault}
                disabled={busy || workspace?.refreshing}
                onChange={(event) => void changeProject({ returnToDefault: event.target.checked })}
              />{" "}
              Remind me to return to the default branch
            </label>
            <GitControls detail={detail} busy={busy} onAction={perform} />
          </section>
          <section className="project-info-panel">
            <h2>Local changes & commits</h2>
            <ProjectChangeForm
              key={`${detail.project.id}:${detail.project.git?.version}`}
              detail={detail}
              busy={busy}
              onAction={perform}
            />
          </section>
          <section className="project-info-panel">
            <h2>Repository insights</h2>
            <RepositoryInformation project={detail.project} />
          </section>
          <section className="project-info-panel project-profile-panel">
            <div className="section-title">
              <h2>
                <BookOpen size={18} /> Profile description
              </h2>
            </div>
            <label className="field">
              Linked profile page
              <select
                value={project?.document ?? ""}
                disabled={busy || profileDirty || workspace?.refreshing}
                onChange={(event) => void changeProject({ document: event.target.value || null })}
              >
                <option value="">No profile page assigned</option>
                {documents.map((doc) => (
                  <option key={doc.path} value={doc.path}>
                    {doc.title}
                  </option>
                ))}
              </select>
            </label>
            {linkedDocument ? (
              <ProjectProfile
                key={linkedDocument.path}
                document={linkedDocument}
                onSave={onProfileSave}
                onDirty={setProfileDirty}
                report={report}
              />
            ) : (
              <p className="muted-text">
                Assign an existing profile page, or generate a project description through project
                discovery in Settings.
              </p>
            )}
          </section>
        </div>
      )}
      {action && (
        <dialog
          ref={modal}
          className="editor-modal project-action-dialog"
          onCancel={(event) => {
            event.preventDefault();
            closeAction();
          }}
        >
          <div className="modal-top">
            <h2>{action.detail.project.name}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close project action"
              disabled={busy}
              onClick={closeAction}
            >
              <X size={20} />
            </button>
          </div>
          {error && (
            <div role="alert" className="banner error">
              {error}
            </div>
          )}
          {action.kind === "reviews" ||
          action.kind === "security" ||
          action.kind === "pipelines" ? (
            <RepositoryInformation project={action.detail.project} kind={action.kind} />
          ) : (
            <>
              <GitControls detail={action.detail} busy={busy} onAction={perform} />
              <ProjectChangeForm
                key={action.detail.project.git?.version}
                detail={action.detail}
                busy={busy}
                onAction={perform}
              />
              {(action.detail.project.remoteError || !action.detail.project.remoteCheckedAt) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={workspace?.refreshing}
                  onClick={() => {
                    closeAction();
                    void refresh().catch(report);
                  }}
                >
                  Check remote
                </button>
              )}
            </>
          )}
        </dialog>
      )}
    </section>
  );
}

type ActionProps = {
  detail: ProjectDetail;
  busy: boolean;
  onAction(project: Project, input: Omit<ProjectAction, "version">, push?: boolean): Promise<void>;
};

function GitControls({ detail: { project }, busy, onAction }: ActionProps) {
  const git = project.git;
  if (!git)
    return <p className="warning-text">{project.error ?? "This checkout is unavailable."}</p>;
  const blocked = busy || git.dirty || git.conflicts || git.operation || !git.branch;
  return (
    <div className="project-git-controls">
      {project.error && <p className="warning-text">{project.error}</p>}
      {project.remoteError && <p className="warning-text">{project.remoteError}</p>}
      {(git.conflicts || git.operation) && (
        <p className="warning-text">
          Resolve the active merge, rebase, or conflicts in your editor, then refresh. No operation
          will be discarded automatically.
        </p>
      )}
      {!git.branch && (
        <p className="warning-text">
          This checkout has a detached HEAD. Check out a branch in Git before making changes here.
        </p>
      )}
      {git.remote && !git.upstream && (
        <p className="muted-text">
          Publishing creates {git.remote}/{git.branch} and sets it as this branch’s upstream.
        </p>
      )}
      {!git.remote && (
        <p className="muted-text">
          This is a local repository. Add a remote in Git to publish or check incoming changes.
        </p>
      )}
      {git.behind > 0 && (
        <p className="muted-text">
          {git.behind} incoming {git.behind === 1 ? "commit" : "commits"}.
          {git.dirty
            ? " Commit local changes before integrating."
            : git.ahead
              ? " Both sides have new commits; merging may require resolving conflicts."
              : " Ready for a fast-forward update."}
        </p>
      )}
      <div className="project-inline-actions">
        {git.behind > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={blocked || !git.upstream}
            onClick={() => void onAction(project, { action: git.ahead ? "merge" : "pull" })}
          >
            <ArrowDownToLine size={16} />
            {git.ahead ? "Merge incoming commits" : "Pull updates"}
          </button>
        )}
        {(git.ahead > 0 || (git.remote && git.head && !git.upstream)) && (
          <button
            type="button"
            className="secondary"
            disabled={blocked || !!git.behind}
            onClick={() => void onAction(project, { action: "push" })}
          >
            <ArrowUpFromLine size={16} />
            {git.upstream
              ? `Push ${git.ahead} ${git.ahead === 1 ? "commit" : "commits"}`
              : "Publish branch"}
          </button>
        )}
        {git.defaultBranch && git.branch !== git.defaultBranch && (
          <button
            type="button"
            className="secondary"
            disabled={blocked || !!git.ahead || (!!git.remote && !git.upstream)}
            onClick={() => void onAction(project, { action: "switch" })}
          >
            <GitBranch size={16} />
            Switch to {git.defaultBranch}
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectChangeForm({ detail, busy, onAction }: ActionProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const { project, changes } = detail;
  const git = project.git;
  const disabled =
    busy || !git?.branch || git.conflicts || git.operation || !files.length || !message.trim();
  const commit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const push = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "push";
    void onAction(project, { action: "commit", files, message }, push);
  };
  return (
    <>
      {changes.files.length ? (
        <form onSubmit={commit}>
          <p className="muted-text">
            Choose the files to commit. Unselected staged work stays untouched.
          </p>
          <div className="project-file-list">
            {changes.files.map((file) => (
              <label key={file.path} className="project-file">
                <input
                  type="checkbox"
                  checked={files.includes(file.path)}
                  disabled={busy}
                  onChange={(event) =>
                    setFiles((current) =>
                      event.target.checked
                        ? [...current, file.path]
                        : current.filter((path) => path !== file.path),
                    )
                  }
                />
                <code>{file.status}</code>
                <span>{file.path}</span>
              </label>
            ))}
          </div>
          {changes.diff && (
            <details className="project-diff">
              <summary>View diff</summary>
              <pre>{changes.diff}</pre>
            </details>
          )}
          {changes.files.some((file) => file.status === "??") && (
            <p className="muted-text">
              New untracked files are listed above; inspect their contents in your editor before
              selecting them.
            </p>
          )}
          <label className="field">
            Commit message
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={2000}
              placeholder="feat: describe the change"
              disabled={busy}
            />
          </label>
          <div className="project-inline-actions">
            <button type="submit" className="secondary" disabled={disabled}>
              Commit selected files
            </button>
            {git?.remote && !git.behind && (
              <button type="submit" value="push" className="primary" disabled={disabled}>
                Commit & push
              </button>
            )}
          </div>
        </form>
      ) : (
        <p className="muted-text">No uncommitted changes.</p>
      )}
      {changes.commits.length > 0 && (
        <div className="project-commits">
          <h3>Incoming & outgoing commits</h3>
          <p className="muted-text">Up to 100 commits in each direction.</p>
          {changes.commits.map((commit) => (
            <div key={`${commit.direction}:${commit.hash}`}>
              <span>
                {commit.direction === "incoming" ? (
                  <ArrowDownToLine size={14} aria-label="Incoming" />
                ) : (
                  <ArrowUpFromLine size={14} aria-label="Outgoing" />
                )}
              </span>
              <code>{commit.hash}</code>
              <span>{commit.subject}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RepositoryInformation({
  project,
  kind,
}: {
  project: Project;
  kind?: "reviews" | "security" | "pipelines";
}) {
  const insights = project.insights;
  if (!insights)
    return (
      <p className="muted-text">
        {project.git?.repositoryUrl
          ? "Refresh to check requested reviews, Dependabot alerts, and pipelines. GitHub repositories use your local GitHub CLI sign-in."
          : "No supported remote repository is linked."}
      </p>
    );
  return (
    <div className="project-repository-information">
      {(!kind || kind === "reviews") && (
        <>
          <h3>Reviews requested from you</h3>
          {insights.reviewError && <p className="warning-text">{insights.reviewError}</p>}
          {insights.reviews.map((pr) => (
            <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer">
              <GitPullRequest size={16} />
              <span>
                #{pr.number} {pr.title}
              </span>
              <ExternalLink size={14} />
            </a>
          ))}
          {!insights.reviews.length && !insights.reviewError && (
            <p className="muted-text">No reviews requested.</p>
          )}
        </>
      )}
      {(!kind || kind === "security") && (
        <>
          <h3>Dependabot alerts</h3>
          {insights.securityErrors.map((error) => (
            <p className="warning-text" key={error}>
              {error}
            </p>
          ))}
          {insights.findings.map((finding) => (
            <a key={finding.url} href={finding.url} target="_blank" rel="noreferrer">
              <ShieldAlert size={16} />
              <span>
                {finding.title}
                <small>
                  {finding.source} · {finding.severity}
                </small>
              </span>
              <ExternalLink size={14} />
            </a>
          ))}
          {!insights.findings.length && !insights.securityErrors.length && (
            <p className="muted-text">No open Dependabot alerts.</p>
          )}
        </>
      )}
      {(!kind || kind === "pipelines") && (
        <>
          <h3>
            Default-branch pipelines
            {insights.pipelines?.branch ? ` · ${insights.pipelines.branch}` : ""}
          </h3>
          {!insights.pipelines ? (
            <p className="muted-text">Refresh to check pipelines.</p>
          ) : (
            <>
              <p className="muted-text">
                Latest run of each active GitHub Actions workflow on the remote default branch.
              </p>
              {insights.pipelines.error && (
                <p className="warning-text">{insights.pipelines.error}</p>
              )}
              {insights.pipelines.failures.map((run) => (
                <a key={run.url} href={run.url} target="_blank" rel="noreferrer">
                  <Workflow size={16} />
                  <span>
                    {run.title}
                    <small>Failed · Open run and logs</small>
                  </span>
                  <ExternalLink size={14} />
                </a>
              ))}
              {insights.pipelines.pending > 0 && (
                <p className="muted-text">
                  {insights.pipelines.pending} workflows awaiting a result.
                </p>
              )}
              {!insights.pipelines.error && !insights.pipelines.failures.length && (
                <p className="muted-text">
                  {insights.pipelines.checked
                    ? "No failing pipelines detected."
                    : "No active workflows."}
                </p>
              )}
            </>
          )}
        </>
      )}
      <p className="muted-text">
        Checked {date(insights.checkedAt)}. Opening an item does not mark it resolved.
      </p>
    </div>
  );
}

function ProjectProfile({
  document,
  onSave,
  onDirty,
  report,
}: {
  document: ProfileDocument;
  onSave(): Promise<void>;
  onDirty(value: boolean): void;
  report(reason: unknown): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(document.content);
  const [hash, setHash] = useState(document.hash);
  const [busy, setBusy] = useState(false);
  const dirty = editing && draft !== document.content;
  useUnsavedSettings(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const body = document.content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/<!-- project-summary:(?:start|end) -->/g, "")
    .trim();
  return (
    <>
      <p className="muted-text">
        {document.title} · {document.path}
      </p>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void api<ProfileDocument>("/profile", "PUT", {
              path: document.path,
              content: draft,
              hash,
            })
              .then(async (saved) => {
                setHash(saved.hash);
                setEditing(false);
                onDirty(false);
                await onSave();
              })
              .catch(report)
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            Project profile document
            <textarea
              rows={14}
              maxLength={50000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="project-inline-actions">
            <button type="submit" className="primary" disabled={busy || !dirty}>
              Save description
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (!dirty || window.confirm("Discard your unsaved profile edits?")) {
                  setEditing(false);
                  onDirty(false);
                }
              }}
            >
              Cancel
            </button>
          </div>
          <p className="muted-text">
            Saves to your profile. Profile changes are not committed or pushed automatically.
          </p>
        </form>
      ) : (
        <>
          <div className="project-profile-text">{body}</div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft(document.content);
              setHash(document.hash);
              setEditing(true);
            }}
          >
            Edit description
          </button>
        </>
      )}
    </>
  );
}
