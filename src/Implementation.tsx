import { useCallback, useEffect, useRef, useState } from "react";
import type { Capture } from "../shared/schema";
import type { ImplementationOptions, ImplementationSummary } from "../shared/t3";
import { api } from "./api";

export function useImplementation(
  item: Capture,
  settingsSection: string | null,
  onReload: () => Promise<void>,
) {
  const [options, setOptions] = useState<ImplementationOptions | null>(null);
  const [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const suggested = useRef<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const { id, kind } = item;
    if (kind !== "commitment") return;
    const current = ++request.current;
    setLoading(true);
    setError("");
    await api<ImplementationOptions>(`/items/${id}/implementation`)
      .then((next) => {
        if (current === request.current) {
          setOptions(next);
          const previousSuggestion = suggested.current;
          setRepositoryId((selected) =>
            !selected ||
            selected === previousSuggestion ||
            !next.repositories.some((repo) => repo.id === selected)
              ? (next.suggestedRepositoryId ?? "")
              : selected,
          );
          suggested.current = next.suggestedRepositoryId;
        }
      })
      .catch((reason) => {
        if (current === request.current)
          setError(
            reason instanceof Error ? reason.message : "Could not load implementation settings.",
          );
      })
      .finally(() => {
        if (current === request.current) setLoading(false);
      });
  }, [item]);
  useEffect(() => {
    if (!settingsSection) void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, settingsSection]);
  const start = async (saved: Capture) => {
    setError("");
    try {
      const result = await api<ImplementationSummary>(`/items/${saved.id}/implementation`, "POST", {
        revision: saved.revision,
        repositoryId: repositoryId || undefined,
        ...(options?.latest?.state === "submitted" ? { previousAttemptId: options.latest.id } : {}),
      });
      setOptions((current) => current && { ...current, latest: result });
      await onReload();
      await refresh();
    } catch (reason) {
      await refresh();
      setError(reason instanceof Error ? reason.message : "Could not send this task to T3 Code.");
    }
  };
  return { options, repositoryId, setRepositoryId, error, loading, start, refresh };
}
