import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../shared/schema";
import { api } from "./api";
import { PanopticonMark, Wordmark } from "./Brand";
import { PeopleSettings } from "./PeopleSettings";
import { ProjectSettings } from "./ProjectSettings";
import { T3Settings } from "./T3Settings";
import { useUnsavedSettings } from "./useUnsavedSettings";

const sections = ["General", "Model", "People", "Projects", "T3 Code"] as const;
type SettingsProps = {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onboarding?: boolean;
};

export function Configuration({
  settings,
  onChange,
  onboarding = false,
  onFinish,
}: SettingsProps & { onFinish?: () => void }) {
  const [section, setSection] = useState<(typeof sections)[number]>("General");
  const [visited, setVisited] = useState<string[]>(["General"]);
  return (
    <div className={onboarding ? "configuration" : "configuration settings-workspace"}>
      {onboarding && (
        <div className="onboarding-brand">
          <PanopticonMark />
          <Wordmark />
        </div>
      )}
      <div className="page-heading">
        <div>
          <div className="eyebrow">{onboarding ? "LET’S GET YOU STARTED" : "YOUR WORKSPACE"}</div>
          <h1>{onboarding ? "Make this assistant yours." : "Settings"}</h1>
          <p>
            {onboarding
              ? "Connect a model, then give your assistant a little context."
              : "Your preferences, connections, and project discovery."}
          </p>
        </div>
      </div>
      <div className={onboarding ? "" : "settings-layout"}>
        {!onboarding && (
          <nav className="settings-navigation" aria-label="Settings sections">
            {sections.map((name) => (
              <button
                type="button"
                key={name}
                aria-current={section === name ? "page" : undefined}
                onClick={() => {
                  setSection(name);
                  setVisited((current) => [...new Set([...current, name])]);
                }}
              >
                {name}
              </button>
            ))}
          </nav>
        )}
        <div className="settings-content">
          <div hidden={onboarding ? settings.modelReady : section !== "Model"}>
            <ModelSettings settings={settings} onChange={onChange} onboarding={onboarding} />
          </div>
          {settings.modelReady && (
            <div hidden={!onboarding && section !== "General"}>
              <ProfileSettings settings={settings} onChange={onChange} onboarding={onboarding} />
            </div>
          )}
          {!onboarding && settings.profileReady && settings.modelReady && (
            <>
              <div hidden={section !== "People"}>
                {visited.includes("People") && (
                  <PeopleSettings
                    key={settings.profilePath}
                    settings={settings}
                    onChange={onChange}
                  />
                )}
              </div>
              <div hidden={section !== "Projects"}>
                {visited.includes("Projects") && (
                  <ProjectSettings
                    key={settings.profilePath}
                    settings={settings}
                    onChange={onChange}
                  />
                )}
              </div>
              <div hidden={section !== "T3 Code"}>
                {visited.includes("T3 Code") && <T3Settings />}
              </div>
            </>
          )}
          {onboarding && settings.modelReady && settings.profileReady && (
            <>
              <Enrichment autoPrepare />
              <button className="primary" type="button" onClick={onFinish}>
                Open my assistant
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelSettings({ settings, onChange, onboarding }: SettingsProps) {
  const savedSource = settings.credentialSources.find(
    (entry) => entry.endpoint.replace(/\/+$/, "") === settings.baseURL.replace(/\/+$/, ""),
  );
  const [baseURL, setBaseURL] = useState(settings.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [credentialMode, setCredentialMode] = useState(savedSource ? "existing" : "new");
  const [model, setModel] = useState(settings.model);
  const [models, setModels] = useState<string[]>([]);
  const [editing, setEditing] = useState(onboarding || !settings.modelReady);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const started = useRef(false);
  const source = settings.credentialSources.find(
    (entry) => entry.endpoint.replace(/\/+$/, "") === baseURL.replace(/\/+$/, ""),
  );
  const dirty =
    baseURL !== settings.baseURL ||
    model !== settings.model ||
    (credentialMode === "new" && !!apiKey);
  useUnsavedSettings(dirty);
  const run = async (save: boolean) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const input = { baseURL, model, ...(credentialMode === "new" ? { apiKey } : {}) };
      if (save) {
        const next = await api<Settings>("/settings/connection", "PUT", input);
        onChange(next);
        setBaseURL(next.baseURL);
        setModel(next.model);
        setApiKey("");
        setCredentialMode("existing");
        setEditing(false);
        setNotice("Model validated and saved.");
      } else {
        const result = await api<{ models: string[] }>("/settings/models", "POST", input);
        setModels(result.models);
        setNotice(
          result.models.length
            ? "Connected. Choose a model to validate."
            : "Connected, but no models were listed. Enter a model ID supplied by your provider.",
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (onboarding && !settings.modelReady && !started.current) {
      started.current = true;
      if (source) void run(false);
    }
  });
  return (
    <section className="settings-card">
      <div className="settings-section-heading">
        <h2>Model connection</h2>
        <span className="pill">
          {!savedSource
            ? "Credential required"
            : settings.modelReady
              ? "Validated"
              : "Setup required"}
        </span>
      </div>
      <p className="muted-text">
        Connect a provider that supports the Responses API, tool calling, and structured outputs.
      </p>
      {settings.modelReady && (
        <p>
          <strong>{settings.model}</strong>
          <br />
          <span className="muted-text">{settings.baseURL}</span>
        </p>
      )}
      {!savedSource && (
        <p className="banner warning" role="status">
          No API key is available for the saved endpoint. Capture refinement is paused. Enter a new
          API key or restore the configured environment variable or key file, then test and save the
          connection.
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!editing ? (
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          Edit model connection
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(true);
          }}
        >
          <fieldset disabled={busy}>
            <label className="field">
              API endpoint
              <input
                type="url"
                required
                value={baseURL}
                onChange={(event) => {
                  setBaseURL(event.target.value);
                  setApiKey("");
                  setModels([]);
                  setNotice("");
                }}
              />
            </label>
            <label className="field">
              Credential source
              <select
                value={credentialMode}
                onChange={(event) => {
                  setCredentialMode(event.target.value);
                  setApiKey("");
                  setModels([]);
                  setNotice("");
                }}
              >
                <option value="existing">Use existing credential</option>
                <option value="new">Enter a new API key</option>
              </select>
            </label>
            {credentialMode === "existing" ? (
              <div className="credential-status">
                <strong>
                  {source?.source === "saved"
                    ? "Saved API key"
                    : source?.source === "environment"
                      ? "Environment variable: OPENAI_API_KEY"
                      : source?.source === "file"
                        ? "Local key file"
                        : "No credential available for this endpoint"}
                </strong>
                <p className="muted-text">
                  {source?.source === "file" ? (
                    <>
                      <span className="repository-path">{source.path}</span>
                      <br />
                      Read from this file when connecting. The key is not copied into settings.
                    </>
                  ) : source ? (
                    "Used automatically for this endpoint. You do not need to enter a key."
                  ) : (
                    "Choose “Enter a new API key” to connect. Existing credentials are only used with their associated endpoint."
                  )}
                </p>
              </div>
            ) : (
              <>
                <label className="field">
                  API key
                  <input
                    type="password"
                    required
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
                <p className="muted-text">
                  Replaces the credential for this endpoint after validation. Stored on this Mac
                  with owner-only file permissions, outside your profile.
                </p>
              </>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy || !baseURL || (credentialMode === "new" ? !apiKey.trim() : !source)}
              onClick={(event) => {
                if (event.currentTarget.form?.reportValidity()) void run(false);
              }}
            >
              Test connection & load models
            </button>
            <label className="field">
              Model
              <input
                list="available-models"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Search models or enter a model ID"
              />
            </label>
            <datalist id="available-models">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <p className="muted-text">
              Validation sends synthetic requests. Normal use sends captures and selected context to
              this provider.
            </p>
            <div className="settings-save-bar">
              <span>{dirty ? "Unsaved changes" : ""}</span>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setBaseURL(settings.baseURL);
                  setModel(settings.model);
                  setApiKey("");
                  setCredentialMode(savedSource ? "existing" : "new");
                  setModels([]);
                  setError("");
                  setNotice("");
                  if (settings.modelReady) setEditing(false);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                type="submit"
                disabled={
                  busy || !model.trim() || (credentialMode === "new" ? !apiKey.trim() : !source)
                }
              >
                {busy ? "Checking…" : "Validate & save model"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

function ProfileSettings({ settings, onChange, onboarding }: SettingsProps) {
  const [mode, setMode] = useState(settings.profileGit ? "connect" : "create");
  const [path, setPath] = useState(settings.profilePath);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [editing, setEditing] = useState(onboarding || !settings.profileReady);
  const [facts, setFacts] = useState({
    name: "",
    role: "",
    company: "",
    team: "",
    teamPurpose: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty =
    path !== settings.profilePath ||
    timezone !== settings.timezone ||
    mode === "create" ||
    Object.values(facts).some(Boolean);
  useUnsavedSettings(dirty && editing);
  return (
    <section className="settings-card">
      <div className="settings-section-heading">
        <h2>Profile & timezone</h2>
        <span className="pill">{settings.profileReady ? "Connected" : "Setup required"}</span>
      </div>
      <p className="repository-path">{settings.profilePath}</p>
      <p className="muted-text">
        {settings.timezone} · Used for daily planning and scheduled scans.
      </p>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!editing ? (
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          Edit profile & timezone
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            void api<Settings>("/settings/profile", "POST", { mode, path, timezone, ...facts })
              .then((next) => {
                onChange(next);
                setMode("connect");
                setPath(next.profilePath);
                setTimezone(next.timezone);
                setFacts({ name: "", role: "", company: "", team: "", teamPurpose: "" });
                setEditing(false);
                setNotice("Profile settings saved.");
              })
              .catch((reason) => setError(reason.message))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset disabled={busy}>
            <label className="field">
              Profile setup
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="create">Create a new profile</option>
                <option value="connect">Connect an existing Git repository</option>
              </select>
            </label>
            <label className="field">
              Repository directory
              <input required value={path} onChange={(event) => setPath(event.target.value)} />
            </label>
            <p className="muted-text">
              Connecting another repository preserves the files in your current profile.
            </p>
            <label className="field">
              Timezone
              <input
                required
                list="timezones"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Search by city or timezone"
              />
            </label>
            <datalist id="timezones">
              {[...new Set([settings.timezone, "UTC", ...Intl.supportedValuesOf("timeZone")])].map(
                (zone) => (
                  <option key={zone} value={zone} />
                ),
              )}
            </datalist>
            {mode === "create" && (
              <>
                <p className="muted-text">Optional context. You can add more later.</p>
                {(
                  [
                    ["name", "Preferred name"],
                    ["role", "Role"],
                    ["company", "Important company context"],
                    ["team", "Your team"],
                    ["teamPurpose", "Purpose of your team"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="field" key={key}>
                    {label}
                    <textarea
                      rows={key === "name" ? 1 : 2}
                      maxLength={key === "name" ? 200 : 3000}
                      value={facts[key]}
                      onChange={(event) => setFacts({ ...facts, [key]: event.target.value })}
                    />
                  </label>
                ))}
              </>
            )}
            <div className="settings-save-bar">
              <span>{dirty ? "Unsaved changes" : ""}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setMode(settings.profileGit ? "connect" : "create");
                  setPath(settings.profilePath);
                  setTimezone(settings.timezone);
                  setFacts({ name: "", role: "", company: "", team: "", teamPurpose: "" });
                  setError("");
                  if (settings.profileReady) setEditing(false);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Saving…" : mode === "create" ? "Create profile" : "Save profile settings"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

export function Enrichment({ autoPrepare = false }: { autoPrepare?: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prepare = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setPrompt((await api<{ prompt: string }>("/profile/enrichment")).prompt);
      setCopied(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare prompt.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (autoPrepare) void prepare();
  }, [autoPrepare, prepare]);
  return (
    <section className="settings-card">
      <h2>Enrich your company and team context</h2>
      <p>
        Prepare guidance for a coding agent to interview you, inspect sources you authorize, and
        propose profile updates.
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="secondary" disabled={busy} onClick={() => void prepare()}>
        {busy ? "Preparing…" : "Prepare agent prompt"}
      </button>
      {prompt && (
        <>
          <label className="field">
            Agent enrichment prompt
            <textarea readOnly rows={12} value={prompt} />
          </label>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void navigator.clipboard
                .writeText(prompt)
                .then(() => setCopied(true))
                .catch(() => setError("Could not copy. Select the prompt and copy it manually."));
            }}
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
          <p className="muted-text">
            Review before sharing. This prompt includes your local repository path and document
            titles.
          </p>
        </>
      )}
    </section>
  );
}
