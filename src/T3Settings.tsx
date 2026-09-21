import { useEffect, useState } from "react";
import type { T3Status } from "../shared/t3";
import { api } from "./api";

export function T3Settings() {
  const [status, setStatus] = useState<T3Status | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState("");
  const [instanceId, setInstanceId] = useState("codex");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void api<T3Status>("/settings/t3")
      .then((next) => {
        setStatus(next);
        setEndpoint(next.endpoint);
        setInstanceId(next.defaultModel.instanceId);
        setModel(next.defaultModel.model);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Could not load T3 Code settings."),
      );
  }, []);
  const run = async (action: () => Promise<T3Status>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setStatus(await action());
      setCredential("");
      setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect to T3 Code.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card t3-settings">
      <h2>T3 Code</h2>
      <p>
        Start implementation from a commitment using T3 Code on this machine. Each task opens a new
        thread in its own Git worktree, with approvals handled in T3 Code.
      </p>
      {status?.configured && (
        <p>
          Saved connection: {status.endpoint} · T3 Code {status.serverVersion}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () => api<T3Status>("/settings/t3", "PUT", { endpoint, credential, instanceId, model }),
            "T3 Code connected and saved.",
          );
        }}
      >
        <label className="field">
          T3 Code endpoint
          <input
            type="url"
            required
            placeholder="http://127.0.0.1:3773"
            value={endpoint}
            disabled={busy || !status}
            onChange={(event) => {
              setEndpoint(event.target.value);
              setCredential("");
            }}
          />
        </label>
        <label className="field">
          T3 Code pairing token
          <input
            type="password"
            autoComplete="off"
            value={credential}
            disabled={busy || !status}
            placeholder="Leave blank to reuse this endpoint's saved connection"
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
        <p className="muted-text">
          Enable network access in T3 Code’s connection settings and create a pairing token, or run
          t3 pair on the host. Credentials stay on Panopticon’s backend.
        </p>
        <div className="field-grid">
          <label className="field">
            T3 Code default provider instance
            <input
              required
              value={instanceId}
              disabled={busy || !status}
              onChange={(event) => setInstanceId(event.target.value)}
            />
          </label>
          <label className="field">
            T3 Code default model
            <input
              required
              value={model}
              disabled={busy || !status}
              placeholder="Model ID configured in T3 Code"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
        </div>
        <p className="muted-text">
          Existing projects use their saved model. These defaults apply when a project has no model
          selection. Connection checks do not start an agent.
        </p>
        <div className="modal-actions">
          <button className="primary" type="submit" disabled={busy || !status}>
            {busy ? "Checking…" : "Connect T3 Code"}
          </button>
          {status?.configured && (
            <>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(
                    () => api<T3Status>("/settings/t3/test", "POST"),
                    "T3 Code is reachable.",
                  );
                }}
              >
                Test T3 Code connection
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(
                    () => api<T3Status>("/settings/t3", "DELETE"),
                    "T3 Code disconnected. Existing threads remain in T3 Code.",
                  );
                }}
              >
                Disconnect T3 Code
              </button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}
