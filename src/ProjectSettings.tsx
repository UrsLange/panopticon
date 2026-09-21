import { useEffect, useState } from "react";
import type { ProjectStatus, ScanStatus } from "../server/application/projects";
import type { ProfileDocument, Settings } from "../shared/schema";
import { api } from "./api";

const phases = {
  queued: "Queued",
  checking: "Checking for changes",
  connecting: "Connecting to OpenCode",
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
  const [roots, setRoots] = useState(settings.projectRoots.join("\n"));
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
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
  const current = status?.projects.find(
    (project) => project.phase && !["done", "queued", "interrupted"].includes(project.phase),
  );
  return (
    <section className="settings-card project-settings">
      <h2>Development environment & projects</h2>
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
          disabled={busy || !status || status.running || !settings.projectRoots.length}
          onClick={() => void scan()}
        >
          Scan now
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || status?.running || !failed.length}
          onClick={() => void scan(failed.map((project) => project.id))}
        >
          Retry failed projects
        </button>
      </div>
      <p className="muted-text">
        Daily at 8:00 a.m. ({settings.timezone}), with overdue scans after login or wake. Failed
        scans retry 15 minutes after completion.
      </p>
      <details className="project-configuration" open={!settings.projectRoots.length}>
        <summary>Directories & provider setup</summary>
        <p>
          Choose the folders containing your Git projects. Only direct child repositories are
          discovered, including Git worktrees.
        </p>
        <p>
          OpenCode uses its own provider connection and the model selected in Settings. Install it
          with mise install and configure its provider before scanning. Repository commands are
          blocked.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const next = await api<Settings>("/settings/projects", "PUT", {
                roots: roots
                  .split("\n")
                  .map((root) => root.trim())
                  .filter(Boolean),
              });
              setRoots(next.projectRoots.join("\n"));
              onChange(next);
              setNotice("Project directories saved. Automatic discovery is enabled.");
            });
          }}
        >
          <label className="field">
            Project root directories
            <textarea
              rows={4}
              required
              value={roots}
              placeholder="One absolute directory path per line"
              onChange={(event) => setRoots(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary" disabled={busy || status?.running}>
            Save project directories
          </button>
        </form>
      </details>
      {status && (
        <>
          <label className="project-filter">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(event) => setErrorsOnly(event.target.checked)}
            />{" "}
            Errors only
          </label>
          <div className="project-index">
            {status.projects
              .filter((project) => !errorsOnly || project.error || project.previousError)
              .map((project) => (
                <article key={project.id}>
                  <div className="project-heading">
                    <strong>{project.name}</strong>
                    <span className={project.error ? "warning-text" : "muted-text"}>
                      {projectLabel(project)}
                    </span>
                  </div>
                  <p className="repository-path muted-text">{project.path}</p>
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
                            const selected = docs.find((doc) => doc.path === project.document);
                            if (!selected)
                              throw new Error("The profile document is no longer available.");
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
                        disabled={busy || status.running}
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
                      <dt>OpenCode session</dt>
                      <dd>{project.sessionId || "Not recorded"}</dd>
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
                          {project.diagnostic.exitCode !== undefined && (
                            <>
                              <dt>Exit status</dt>
                              <dd>{project.diagnostic.exitCode}</dd>
                            </>
                          )}
                          {project.diagnostic.signal && (
                            <>
                              <dt>Signal</dt>
                              <dd>{project.diagnostic.signal}</dd>
                            </>
                          )}
                        </>
                      )}
                    </dl>
                    {!project.startedAt && (
                      <p className="muted-text">
                        Detailed diagnostics were not recorded for this older attempt. Retry to
                        collect them.
                      </p>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void run(async () => {
                          await navigator.clipboard.writeText(JSON.stringify(project, null, 2));
                          setNotice(`Diagnostics copied for ${project.name}.`);
                        })
                      }
                    >
                      Copy diagnostics
                    </button>
                  </details>
                </article>
              ))}
            {errorsOnly &&
              !status.projects.some((project) => project.error || project.previousError) && (
                <p>No project errors.</p>
              )}
            {!status.projects.length && (
              <p>No projects discovered yet. Configure your directories and scan to begin.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
