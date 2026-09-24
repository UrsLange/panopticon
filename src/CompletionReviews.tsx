import { useCallback, useEffect, useRef, useState } from "react";
import type { CompletionReview } from "../shared/t3";
import { api } from "./api";

export function CompletionReviews({ onChange }: { onChange(): Promise<void> }) {
  const [reviews, setReviews] = useState<CompletionReview[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const submitting = useRef(false);
  const reviewKey = (review: CompletionReview) => `${review.implementationId}:${review.head}`;
  const current = reviews.find((review) => queue.includes(reviewKey(review)));
  const remaining = reviews.filter((review) => queue.includes(reviewKey(review))).length;
  const load = useCallback(async (open = false) => {
    const sequence = ++request.current;
    const next = await api<CompletionReview[]>("/completion-reviews");
    if (sequence !== request.current) return;
    setReviews(next);
    if (open && !document.querySelector("dialog[open]"))
      setQueue(next.map((review) => `${review.implementationId}:${review.head}`));
  }, []);

  useEffect(() => {
    const report = (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not load completion suggestions.");
    void load(true).catch(report);
    const interval = setInterval(() => void load().catch(report), 5000);
    const revisit = () => {
      if (document.visibilityState === "visible") void load(true).catch(report);
    };
    document.addEventListener("visibilitychange", revisit);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", revisit);
      request.current++;
    };
  }, [load]);

  useEffect(() => {
    const element = dialog.current;
    if (current) {
      element?.showModal();
      if (!busy && !element?.contains(document.activeElement))
        element?.querySelector<HTMLButtonElement>("button")?.focus();
    } else element?.close();
  }, [current, busy]);

  const decide = async (decision: "confirm" | "keep_open") => {
    if (!current || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    request.current++;
    try {
      await api(`/items/${current.itemId}/completion-review`, "POST", {
        implementationId: current.implementationId,
        head: current.head,
        revision: current.revision,
        decision,
      });
      setQueue((pending) => pending.filter((key) => key !== reviewKey(current)));
      setReviews((pending) => pending.filter((review) => reviewKey(review) !== reviewKey(current)));
      await onChange();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your decision.");
      await load().catch(() => {});
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {reviews.length > 0 && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setError("");
            setQueue(reviews.map(reviewKey));
          }}
        >
          {reviews.length} {reviews.length === 1 ? "task" : "tasks"} ready for review
        </button>
      )}
      {error && !current && <p role="alert">{error}</p>}
      <dialog
        ref={dialog}
        className="editor-modal completion-review"
        aria-labelledby="completion-review-title"
        aria-describedby="completion-review-reason"
        onCancel={(event) => {
          event.preventDefault();
          if (!submitting.current) setQueue([]);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Tab") {
            const buttons =
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && event.target === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && event.target === last) {
              event.preventDefault();
              first.focus();
            }
          }
          if (
            event.repeat ||
            event.nativeEvent.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const key = event.key.toLowerCase();
          if (key === "c" || key === "k") {
            event.preventDefault();
            void decide(key === "c" ? "confirm" : "keep_open");
          }
        }}
      >
        {current && (
          <>
            <p className="eyebrow">
              {remaining} {remaining === 1 ? "TASK" : "TASKS"} TO REVIEW
            </p>
            <h2 id="completion-review-title">Is “{current.title}” complete?</h2>
            <p id="completion-review-reason">{current.reason}</p>
            <p className="muted-text">This task stays unresolved until you confirm completion.</p>
            {error && <p role="alert">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setQueue((pending) => pending.filter((key) => key !== reviewKey(current)))
                }
              >
                Decide later
              </button>
              <button
                type="button"
                disabled={busy}
                aria-keyshortcuts="K"
                onClick={() => void decide("keep_open")}
              >
                Keep open <kbd>K</kbd>
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                aria-keyshortcuts="C"
                onClick={() => void decide("confirm")}
              >
                Confirm completion <kbd>C</kbd>
              </button>
            </div>
            <p className="muted-text">
              Press C to confirm, K to keep open, or Escape to review the rest later.
            </p>
          </>
        )}
      </dialog>
    </>
  );
}
