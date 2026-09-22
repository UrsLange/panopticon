import { Fragment, useEffect, useState } from "react";
import type { ProjectStatus, ScanStatus } from "../server/application/projects";
import type { ProfileDocument, Settings } from "../shared/schema";
import { api } from "./api";
import { useUnsavedSettings } from "./useUnsavedSettings";

const phases = {
  queued: "Queued",
  checking: "Checking for changes",
  connecting: "Connecting to model provider",
  reading: "Reading repository",
  updating: "Updating summary",
  validating: "Validating summary",
  interrupted: "Interrupted",
  done: "Finished",
};
const outcomes = {
  updated: "Updated",
  unchanged: "Unchanged",
  failed: "Failed",
  unverified: "Saved, but update incomplete",
};
function projectLabel(project: ProjectStatus) {
  if (project.availability === "missing") return "Unavailable · existing knowledge retained";
  if (project.phase && project.phase !== "done") return phases[project.phase];
  if (project.outcome) return outcomes[project.outcome];
  if (project.error) return "Previous attempt failed";
  return project.document ? "Document available · review status unknown" : "Awaiting review";
}
function date(value?: string | null) {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Not yet";
}
function duration(start: string, end: string | undefined, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ProjectSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  const [roots, setRoots] = useState(() =>
    settings.projectRoots.map((path) => ({ id: crypto.randomUUID(), path })),
  );
  const [editing, setEditing] = useState(!settings.projectRoots.length);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const dirty =
    JSON.stringify(roots.map((root) => root.path)) !== JSON.stringify(settings.projectRoots);
  useUnsavedSettings(dirty);
  const [document, setDocument] = useState<ProfileDocument | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const value = await api<ScanStatus>("/projects");
        if (active) {
          setStatus(value);
          setLoadError("");
        }
      } catch {
        if (active)
          setLoadError("Could not refresh scan status. Displayed results may be out of date.");
      }
    };
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const scan = (projectIds?: string[]) =>
    run(async () => {
      setStatus(await api<ScanStatus>("/projects/scan", "POST", { projectIds }));
      setNow(Date.now());
    });
  const failed = status?.projects.filter((project) => project.error) ?? [];
  const visible =
    status?.projects.filter(
      (project) =>
        `${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "attention"
            ? project.error || project.previousError || project.availability === "missing"
            : project.outcome === filter)),
    ) ?? [];
  const choose = (index?: number) =>
    run(async () => {
      const result = await api<{ path: string | null }>("/settings/directory", "POST", {});
      if (result.path !== null) {
        const path = result.path.replace(/\/$/, "") || "/";
        setRoots((current) =>
          index === undefined
            ? [...current, { id: crypto.randomUUID(), path }]
            : current.map((root, i) => (i === index ? { ...root, path } : root)),
        );
      }
    });
  const current = status?.projects.find(
    (project) => project.phase && !["done", "queued", "interrupted"].includes(project.phase),
  );
  return (
    <section className="settings-card project-settings">
      <h2>Projects</h2>
      {(error || loadError) && (
        <p role="alert" className="warning-text">
          {error || loadError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {status ? (
        <>
          <div className="project-progress" aria-live="polite">
            <strong>
              {status.running
                ? status.phase === "discovering"
                  ? "Discovering projects…"
                  : `${status.completed} of ${status.total} projects reviewed`
                : status.error
                  ? "Scan needs attention"
                  : status.lastFinished
                    ? `Scan finished · ${failed.length} ${failed.length === 1 ? "project needs" : "projects need"} attention`
                    : "Project sync"}
            </strong>
            {status.running && (
              <>
                <progress
                  aria-label="Project scan progress"
                  max={status.total || 1}
                  value={status.phase === "discovering" ? undefined : status.completed}
                />
                <p>
                  {current
                    ? `${current.name} · ${projectLabel(current)}`
                    : status.phase === "discovering"
                      ? "Finding repositories in your configured directories"
                      : "Preparing the next project"}
                  {status.lastAttempt &&
                    ` · ${duration(status.lastAttempt, undefined, now)} elapsed`}
                </p>
                {current?.filesRead ? (
                  <p className="muted-text">{current.filesRead} files read</p>
                ) : null}
                {status.phase === "discovering" && (
                  <p className="muted-text">
                    Project rows below show the previous attempt until discovery finishes.
                  </p>
                )}
              </>
            )}
            <p className="muted-text">
              Last successful full scan: {date(status.lastSuccess)}
              <br />
              {status.running ? "Started" : "Last attempt"}: {date(status.lastAttempt)}
              {status.nextRetry && (
                <>
                  <br />
                  Next automatic retry: {date(status.nextRetry)}
                </>
              )}
            </p>
          </div>
          {status.error && (
            <p role="alert" className="warning-text">
              {status.error}
            </p>
          )}
        </>
      ) : (
        <p>Loading project status…</p>
      )}
      <div className="project-actions">
        <button
          className="primary"
          type="button"
          disabled={busy || dirty || !status || status.running || !settings.projectRoots.length}
          onClick={() => void scan()}
        >
          Scan now
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || dirty || status?.running || !failed.length}
          onClick={() => void scan(failed.map((project) => project.id))}
        >
          Retry failed projects
        </button>
      </div>
      <p className="muted-text">
        Daily at 8:00 a.m. ({settings.timezone}), with overdue scans after login or wake. Failed
        scans retry 15 minutes after completion.
      </p>
      <div className="project-configuration">
        <div className="settings-section-heading">
          <h3>Project groups</h3>
          {!editing && (
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Edit directories
            </button>
          )}
        </div>
        {!editing && (
          <ul className="directory-summary">
            {settings.projectRoots.map((root) => (
              <li key={root}>{root}</li>
            ))}
          </ul>
        )}
        {editing && (
          <>
            <p>
              Choose the folders containing your Git projects. Only direct child repositories are
              discovered, including Git worktrees.
            </p>
            <p>
              Project discovery uses the endpoint, API key and model configured in Settings. It
              reads repository files to update project summaries. Repository commands are blocked.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const next = await api<Settings>("/settings/projects", "PUT", {
                    roots: roots.map((root) => root.path.trim()).filter(Boolean),
                  });
                  setRoots(next.projectRoots.map((path) => ({ id: crypto.randomUUID(), path })));
                  setEditing(false);
                  onChange(next);
                  setNotice("Project directories saved. Automatic discovery is enabled.");
                });
              }}
            >
              <fieldset disabled={busy || status?.running}>
                {roots.map((root, index) => (
                  <div className="directory-row" key={root.id}>
                    <label className="field">
                      Directory {index + 1}
                      <input
                        required
                        value={root.path}
                        placeholder="Absolute directory path"
                        onChange={(event) =>
                          setRoots(
                            roots.map((value, i) =>
                              i === index ? { ...value, path: event.target.value } : value,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Browse directory ${index + 1}`}
                      onClick={() => void choose(index)}
                    >
                      Browse…
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Remove directory ${index + 1}`}
                      onClick={() => setRoots(roots.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className="project-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={roots.length >= 30}
                    onClick={() => void choose()}
                  >
                    Choose directory…
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={roots.length >= 30}
                    onClick={() => setRoots([...roots, { id: crypto.randomUUID(), path: "" }])}
                  >
                    Enter path manually
                  </button>
                </div>
                <p className="muted-text">
                  Choose a folder on this Mac. Selection is only applied when you save.
                </p>
                <div className="settings-save-bar">
                  <span>{dirty ? "Unsaved changes" : ""}</span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setRoots(
                        settings.projectRoots.map((path) => ({ id: crypto.randomUUID(), path })),
                      );
                      setEditing(false);
                      setError("");
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={!dirty || !roots.length}>
                    Save project directories
                  </button>
                </div>
              </fieldset>
            </form>
          </>
        )}
      </div>
      {status && (
        <>
          <div className="field-grid project-filters">
            <label className="field">
              Search projects
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or directory"
              />
            </label>
            <label className="field">
              Project status
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">All projects</option>
                <option value="attention">Needs attention</option>
                <option value="updated">Updated</option>
                <option value="unchanged">Unchanged</option>
              </select>
            </label>
          </div>
          <p className="muted-text">
            {visible.length} of {status.projects.length} projects
          </p>
          <div className="project-table-wrapper">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((project) => (
                  <Fragment key={project.id}>
                    <tr>
                      <td>
                        <strong>{project.name}</strong>
                        <small className="repository-path muted-text">{project.path}</small>
                      </td>
                      <td>
                        <span className={project.error ? "warning-text" : "muted-text"}>
                          {projectLabel(project)}
                        </span>
                      </td>
                      <td>
                        <button
                          className="secondary"
                          type="button"
                          aria-label={`Details for ${project.name}`}
                          aria-expanded={expanded === project.id}
                          aria-controls={`project-${project.id}`}
                          onClick={() => setExpanded(expanded === project.id ? null : project.id)}
                        >
                          {expanded === project.id ? "Close" : "Details"}
                        </button>
                      </td>
                    </tr>
                    {expanded === project.id && (
                      <tr>
                        <td colSpan={3} id={`project-${project.id}`}>
                          <p className="muted-text">
                            Last accepted review: {date(project.lastSuccess)}
                            {project.startedAt && (
                              <> · {duration(project.startedAt, project.finishedAt, now)}</>
                            )}
                          </p>
                          {project.previousError && project.phase !== "done" && (
                            <p className="muted-text">Previous attempt: {project.previousError}</p>
                          )}
                          {project.error && <p className="warning-text">{project.error}</p>}
                          <div className="project-actions">
                            {project.document && (
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    const docs = await api<ProfileDocument[]>("/profile");
                                    const selected = docs.find(
                                      (doc) => doc.path === project.document,
                                    );
                                    if (!selected)
                                      throw new Error(
                                        "The profile document is no longer available.",
                                      );
                                    setDocument(selected);
                                  })
                                }
                              >
                                Open document
                              </button>
                            )}
                            {project.error && (
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy || dirty || status.running}
                                onClick={() => void scan([project.id])}
                              >
                                Retry project
                              </button>
                            )}
                          </div>
                          {document?.path === project.document && (
                            <section
                              className="project-document"
                              aria-label={`Profile document: ${document.title}`}
                            >
                              <div className="project-heading">
                                <strong>{document.path}</strong>
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => setDocument(null)}
                                >
                                  Close document
                                </button>
                              </div>
                              <pre>{document.content}</pre>
                            </section>
                          )}
                          <details className="project-diagnostics">
                            <summary>Diagnostics</summary>
                            <dl>
                              <dt>Attempt</dt>
                              <dd>{date(project.startedAt)}</dd>
                              <dt>Finished</dt>
                              <dd>{date(project.finishedAt)}</dd>
                              <dt>Model</dt>
                              <dd>{project.model || "Not recorded"}</dd>
                              <dt>Model response</dt>
                              <dd>{project.responseId || "Not recorded"}</dd>
                              <dt>Files read</dt>
                              <dd>{project.filesRead ?? "Not recorded"}</dd>
                              {project.diagnostic && (
                                <>
                                  <dt>Failure category</dt>
                                  <dd>{project.diagnostic.category}</dd>
                                  <dt>Cause</dt>
                                  <dd>{project.diagnostic.message}</dd>
                                  {project.diagnostic.statusCode !== undefined && (
                                    <>
                                      <dt>Provider status</dt>
                                      <dd>HTTP {project.diagnostic.statusCode}</dd>
                                    </>
                                  )}
                                </>
                              )}
                            </dl>
                            {!project.startedAt && (
                              <p className="muted-text">
                                Detailed diagnostics were not recorded for this older attempt. Retry
                                to collect them.
                              </p>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              onClick={() =>
                                void run(async () => {
                                  await navigator.clipboard.writeText(
                                    JSON.stringify(project, null, 2),
                                  );
                                  setNotice(`Diagnostics copied for ${project.name}.`);
                                })
                              }
                            >
                              Copy diagnostics
                            </button>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <p>
                {status.projects.length
                  ? "No projects match your search and filter."
                  : "No projects discovered yet. Configure your directories and scan to begin."}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
