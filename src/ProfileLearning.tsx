import { useEffect, useState } from "react";
import type { ProfileLearningStatus } from "../shared/profile-learning";
import { api } from "./api";

export function ProfileLearning() {
  const [status, setStatus] = useState<ProfileLearningStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const next = await api<ProfileLearningStatus>("/profile/learning");
        if (mounted) {
          setStatus(next);
          setError("");
        }
      } catch (reason) {
        if (mounted) setError((reason as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  const run = async () => {
    setSubmitting(true);
    setError("");
    try {
      setStatus(await api<ProfileLearningStatus>("/profile/learning", "POST"));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="settings-card" aria-labelledby="profile-learning-title">
      <div className="settings-section-heading">
        <h3 id="profile-learning-title">Daily profile learning</h3>
        <button
          type="button"
          className="secondary"
          disabled={!status || submitting || status.running}
          onClick={() => void run()}
        >
          {status?.running || submitting ? "Learning…" : "Learn from recent activity"}
        </button>
      </div>
      <p className="muted-text">
        Your captures, clarification answers, conversations, and work outcomes help keep your
        profile current. Useful facts and supported implications are retained; uncertain
        observations stay separate. Changes are committed locally for you to review.
      </p>
      {status?.lastSuccess ? (
        <p>Last successful pass: {new Date(status.lastSuccess).toLocaleString()}.</p>
      ) : (
        <p>The next daily pass will run while the app’s server is running.</p>
      )}
      {status?.summary && <p>{status.summary}</p>}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </section>
  );
}
