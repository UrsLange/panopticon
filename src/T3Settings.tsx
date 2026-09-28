import { useEffect, useState } from "react";
import type { T3Status } from "../shared/t3";
import { api } from "./api";
import { useUnsavedSettings } from "./useUnsavedSettings";

export function T3Settings() {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<T3Status | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState("");
  const [instanceId, setInstanceId] = useState("codex");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const autoStartDirty = !!status && autoStart !== (status.autoStart ?? false);
  const dirty =
    !!status &&
    (endpoint !== status.endpoint ||
      instanceId !== status.defaultModel.instanceId ||
      model !== status.defaultModel.model ||
      !!credential);
  useUnsavedSettings(dirty || autoStartDirty);
  useEffect(() => {
    void api<T3Status>("/settings/t3")
      .then((next) => {
        setStatus(next);
        setAutoStart(next.autoStart ?? false);
        setEditing(!next.configured);
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
      const next = await action();
      setStatus(next);
      setEndpoint(next.endpoint);
      setInstanceId(next.defaultModel.instanceId);
      setModel(next.defaultModel.model);
      setEditing(!next.configured);
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
        Start implementation from a commitment using T3 Code on this machine. Configure the model,
        checkout, and permissions in project details on the Projects tab.
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
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            const saved = await api<T3Status>("/settings/t3/auto-start", "PUT", { autoStart });
            setStatus(saved);
            setAutoStart(saved.autoStart ?? false);
            setNotice("Global auto-start setting saved.");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Could not save auto-start.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || !status}>
          <label className="field">
            Global auto-start after refinement
            <select
              value={String(autoStart)}
              onChange={(event) => setAutoStart(event.target.value === "true")}
            >
              <option value="false">Off</option>
              <option value="true">On</option>
            </select>
          </label>
          <p>
            Saved global auto-start: {status?.autoStart ? "On" : "Off"}. Projects can inherit this
            value or override it in project details.
          </p>
          <p className="muted-text">
            Start T3 implementation automatically after refinement saves a ready task with a usable
            prompt and one available repository. No separate launch consent is requested. This
            authorizes starting implementation, not publishing or other shared-system changes.
          </p>
          <button className="primary" type="submit" disabled={!autoStartDirty}>
            Save global auto-start
          </button>
          <button
            className="secondary"
            type="button"
            disabled={!autoStartDirty}
            onClick={() => setAutoStart(status?.autoStart ?? false)}
          >
            Cancel auto-start changes
          </button>
        </fieldset>
      </form>
      <div className="project-actions">
        {!editing && status?.configured && (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Edit T3 Code connection
          </button>
        )}{" "}
        {status?.configured && (
          <>
            <button
              className="secondary"
              type="button"
              disabled={busy || dirty}
              onClick={() => {
                void run(() => api<T3Status>("/settings/t3/test", "POST"), "T3 Code is reachable.");
              }}
            >
              Test T3 Code connection
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || dirty}
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
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                api<T3Status>("/settings/t3", "PUT", { endpoint, credential, instanceId, model }),
              "T3 Code connected and saved.",
            );
          }}
        >
          <fieldset disabled={busy || !status}>
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
              Enable network access in T3 Code’s connection settings and create a pairing token, or
              run t3 pair on the host. Credentials stay on Panopticon’s backend.
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
              Projects without a model override use this global default. Connection checks do not
              start an agent.
            </p>
            <div className="settings-save-bar">
              <span>{dirty ? "Unsaved changes" : ""}</span>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  if (!status) return;
                  setEndpoint(status.endpoint);
                  setInstanceId(status.defaultModel.instanceId);
                  setModel(status.defaultModel.model);
                  setCredential("");
                  setError("");
                  setEditing(!status.configured);
                }}
              >
                Cancel
              </button>
              <button className="primary" type="submit" disabled={busy || !status}>
                {busy ? "Checking…" : "Connect T3 Code"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
