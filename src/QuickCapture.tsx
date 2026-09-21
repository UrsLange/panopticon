import { ArrowRight, Check, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { PanopticonMark, Wordmark } from "./Brand";

declare global {
  interface Window {
    quickCapture?: { hide: () => void };
  }
}

export function QuickCapture() {
  const [text, setText] = useState(() => localStorage.getItem("quick-capture-draft") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      setSaved(false);
    };
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    localStorage.setItem("quick-capture-draft", text);
  }, [text]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.quickCapture?.hide();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api("/captures", "POST", { text });
      localStorage.removeItem("quick-capture-draft");
      setText("");
      setSaved(true);
      window.quickCapture?.hide();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Not saved. Your draft is still here.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <main className="quick-capture">
      <div className="quick-heading">
        <span className="quick-mark">
          <PanopticonMark />
        </span>
        <div>
          <h1>
            <Wordmark />
          </h1>
          <p>Keep the thought. Get back to your day.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss capture"
          onClick={() => window.quickCapture?.hide()}
        >
          <X size={18} />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <textarea
          ref={input}
          aria-label="Quick capture"
          rows={3}
          maxLength={30000}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="An idea, a promise, something to come back to…"
        />
        <div className="quick-footer">
          <span>
            {error ? (
              <span className="quick-error" role="alert">
                {error}
              </span>
            ) : saved ? (
              <span className="quick-saved" role="status">
                <Check size={14} />
                Saved to your inbox.
              </span>
            ) : (
              "⌘ Enter to capture · Esc to dismiss"
            )}
          </span>
          <button type="submit" className="primary" disabled={!text.trim() || saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            {saving ? "Saving…" : "Capture"}
          </button>
        </div>
      </form>
    </main>
  );
}
