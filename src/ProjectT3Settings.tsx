import { useEffect, useState } from "react";
import type { Project } from "../shared/projects";
import type { T3ImplementationSettings, T3Overrides } from "../shared/t3";
import { api } from "./api";
import { useUnsavedSettings } from "./useUnsavedSettings";

export function ProjectT3Settings({
  project,
  disabled,
  onSaved,
  onDirty,
  onBusy,
}: {
  project: Project;
  disabled: boolean;
  onSaved(project: Project): void;
  onDirty(dirty: boolean): void;
  onBusy(busy: boolean): void;
}) {
  const [defaults, setDefaults] = useState<T3ImplementationSettings | null>(null);
  const [globalDraft, setGlobalDraft] = useState<T3ImplementationSettings | null>(null);
  const [draft, setDraft] = useState<T3Overrides>(project.t3 ?? {});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const projectDirty = JSON.stringify(draft) !== JSON.stringify(project.t3 ?? {});
  const globalDirty = JSON.stringify(globalDraft) !== JSON.stringify(defaults);
  useUnsavedSettings(projectDirty || globalDirty);
  useEffect(() => onDirty(projectDirty || globalDirty), [projectDirty, globalDirty, onDirty]);
  useEffect(() => {
    let stopped = false;
    void api<T3ImplementationSettings>("/settings/t3/defaults")
      .then((value) => {
        if (stopped) return;
        setDefaults(value);
        setGlobalDraft(value);
      })
      .catch((reason) => {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Could not load T3 defaults.");
      });
    return () => {
      stopped = true;
    };
  }, []);
  const save = async (global: boolean) => {
    onBusy(true);
    setError("");
    setNotice("");
    try {
      if (global) {
        const saved = await api<T3ImplementationSettings>(
          "/settings/t3/defaults",
          "PUT",
          globalDraft,
        );
        setDefaults(saved);
        setGlobalDraft(saved);
      } else {
        const saved = await api<Project>(`/project-workspace/${project.id}`, "PATCH", {
          t3: draft,
        });
        setDraft(saved.t3 ?? {});
        onSaved(saved);
      }
      setNotice(global ? "Global T3 defaults saved." : "Project T3 settings saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save T3 settings.");
    } finally {
      onBusy(false);
    }
  };
  return (
    <section className="project-info-panel">
      <h2>T3 implementation</h2>
      <p className="muted-text">
        Settings apply to new implementations. Retries keep their original settings.
      </p>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {defaults && globalDraft && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <fieldset disabled={disabled}>
              <T3Fields value={draft} defaults={defaults} onChange={setDraft} />
              <div className="project-inline-actions">
                <button type="submit" className="primary" disabled={!projectDirty}>
                  Save project T3 settings
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!projectDirty}
                  onClick={() => setDraft(project.t3 ?? {})}
                >
                  Cancel project changes
                </button>
              </div>
            </fieldset>
          </form>
          <details className="project-t3-defaults">
            <summary>Global T3 defaults</summary>
            <p className="muted-text">
              Used by every project without an override for that setting.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(true);
              }}
            >
              <fieldset disabled={disabled}>
                <T3Fields
                  value={globalDraft}
                  onChange={(value) => setGlobalDraft(value as T3ImplementationSettings)}
                />
                <div className="project-inline-actions">
                  <button type="submit" className="primary" disabled={!globalDirty}>
                    Save global T3 defaults
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!globalDirty}
                    onClick={() => setGlobalDraft(defaults)}
                  >
                    Cancel global changes
                  </button>
                </div>
              </fieldset>
            </form>
          </details>
        </>
      )}
    </section>
  );
}

function T3Fields({
  value,
  defaults,
  onChange,
}: {
  value: T3Overrides;
  defaults?: T3ImplementationSettings;
  onChange(value: T3Overrides): void;
}) {
  const prefix = defaults ? "Project" : "Global";
  const model = value.model;
  return (
    <>
      {defaults && (
        <label className="field">
          Project model selection
          <select
            value={value.model ? "override" : "inherit"}
            onChange={(event) => {
              const next = { ...value };
              if (event.target.value === "inherit") delete next.model;
              else next.model = { ...defaults.model };
              onChange(next);
            }}
          >
            <option value="inherit">
              Use global default ({defaults.model.instanceId} /{" "}
              {defaults.model.model || "not configured"})
            </option>
            <option value="override">Override for this project</option>
          </select>
        </label>
      )}
      {model && (
        <div className="field-grid">
          <label className="field">
            {prefix} provider instance
            <input
              required
              maxLength={200}
              value={model.instanceId}
              onChange={(event) =>
                onChange({ ...value, model: { ...model, instanceId: event.target.value } })
              }
            />
          </label>
          <label className="field">
            {prefix} model
            <input
              required
              maxLength={200}
              placeholder="Model ID configured in T3 Code"
              value={model.model}
              onChange={(event) =>
                onChange({ ...value, model: { ...model, model: event.target.value } })
              }
            />
          </label>
        </div>
      )}
      <label className="field">
        {prefix} implementation location
        <select
          value={value.workspaceMode ?? ""}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value)
              next.workspaceMode = event.target.value as T3ImplementationSettings["workspaceMode"];
            else delete next.workspaceMode;
            onChange(next);
          }}
        >
          {defaults && (
            <option value="">
              Use global default (
              {defaults.workspaceMode === "checkout" ? "Current checkout" : "New worktree"})
            </option>
          )}
          <option value="checkout">Current checkout</option>
          <option value="worktree">New worktree</option>
        </select>
      </label>
      <label className="field">
        {prefix} permission level
        <select
          value={value.runtimeMode ?? ""}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value)
              next.runtimeMode = event.target.value as T3ImplementationSettings["runtimeMode"];
            else delete next.runtimeMode;
            onChange(next);
          }}
        >
          {defaults && (
            <option value="">Use global default ({permissionLabels[defaults.runtimeMode]})</option>
          )}
          <option value="full-access">Full access</option>
          <option value="approval-required">Supervised</option>
          <option value="auto-accept-edits">Auto-accept edits</option>
        </select>
      </label>
    </>
  );
}

const permissionLabels = {
  "full-access": "Full access",
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
};
