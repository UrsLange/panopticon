import { useEffect, useState } from "react";
import type { Item } from "../shared/schema";
import type { ImplementationOptions, ImplementationSummary } from "../shared/t3";
import { api } from "./api";

export function Implementation({
  item,
  dirty,
  busy,
  run,
}: {
  item: Item;
  dirty: boolean;
  busy: boolean;
  run(action: () => Promise<void>): Promise<void>;
}) {
  const [options, setOptions] = useState<ImplementationOptions | null>(null);
  const [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api<ImplementationOptions>(`/items/${item.id}/implementation`)
      .then((next) => {
        if (current) {
          setOptions(next);
          setRepositoryId(next.suggestedRepositoryId ?? "");
        }
      })
      .catch((reason) => {
        if (current)
          setError(
            reason instanceof Error ? reason.message : "Could not load implementation settings.",
          );
      });
    return () => {
      current = false;
    };
  }, [item.id]);
  if (error) return <p className="warning-text">{error}</p>;
  if (!options?.configured && !options?.latest) return null;
  const latest = options.latest;
  const pending = latest?.state === "pending";
  const resolvedRepository = options.repositories.find(
    (repository) => repository.id === options.suggestedRepositoryId,
  );
  const ready =
    item.processing === "ready" &&
    !item.processingError &&
    !!item.prompt.trim() &&
    ["open", "waiting"].includes(item.status);
  const start = () =>
    run(async () => {
      try {
        const result = await api<ImplementationSummary>(
          `/items/${item.id}/implementation`,
          "POST",
          {
            revision: item.revision,
            repositoryId: repositoryId || undefined,
            ...(latest?.state === "submitted" ? { previousAttemptId: latest.id } : {}),
          },
        );
        setOptions({ ...options, latest: result });
      } finally {
        setOptions(await api<ImplementationOptions>(`/items/${item.id}/implementation`));
      }
    });
  return (
    <section className="implementation">
      <h3>Implementation</h3>
      {latest && (
        <p>
          {latest.state === "submitted" ? "Sent to T3 Code" : "Handoff needs retry"} · revision{" "}
          {latest.revision}
          {latest.revision !== item.revision && " (earlier saved version)"} ·{" "}
          <a href={latest.url} target="_blank" rel="noreferrer">
            Open in T3 Code
          </a>
        </p>
      )}
      {latest?.error && <p className="warning-text">{latest.error}</p>}
      {options.configured && (
        <>
          {!pending && resolvedRepository && (
            <p className="muted-text">Implementation repository: {resolvedRepository.path}</p>
          )}
          {!pending && !resolvedRepository && (
            <label className="field">
              Implementation repository
              <select
                aria-label="Implementation repository"
                value={repositoryId}
                disabled={busy}
                onChange={(event) => setRepositoryId(event.target.value)}
              >
                <option value="">Choose a repository</option>
                {options.repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name} — {repository.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted-text">
            {pending
              ? "Retry checks the same thread and preserves the original saved task, even if this commitment has changed."
              : dirty
                ? "Save your changes before implementing."
                : !ready
                  ? "Complete refinement and resolve processing errors before implementing an open commitment."
                  : !options.repositories.length
                    ? "Add a project root and discover repositories in Settings first."
                    : "Starts an agent immediately in a new worktree from the current commit. Uncommitted changes are not included. Review approvals and progress in T3 Code."}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || (!pending && (dirty || !ready || !repositoryId))}
            onClick={() => {
              void start();
            }}
          >
            {busy
              ? "Please wait…"
              : pending
                ? "Retry implementation"
                : latest
                  ? "Start another implementation"
                  : "Implement"}
          </button>
        </>
      )}
    </section>
  );
}
