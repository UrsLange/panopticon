import { useEffect, useRef, useState } from "react";
import type { Settings } from "../shared/schema";
import { api } from "./api";
import { PanopticonMark, Wordmark } from "./Brand";
import { PeopleSettings } from "./PeopleSettings";
import { ProjectSettings } from "./ProjectSettings";
import { T3Settings } from "./T3Settings";

export function Configuration({
  settings,
  onChange,
  onboarding = false,
  onFinish,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onboarding?: boolean;
  onFinish?: () => void;
}) {
  const [baseURL, setBaseURL] = useState(settings.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(settings.model);
  const [models, setModels] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const started = useRef(false);
  const [mode, setMode] = useState(settings.profileGit ? "connect" : "create");
  const [path, setPath] = useState(settings.profilePath);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [facts, setFacts] = useState({
    name: "",
    role: "",
    company: "",
    team: "",
    teamPurpose: "",
  });
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    setConnected(false);
    const result = await api<{ models: string[] }>("/settings/models", "POST", {
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      model,
    });
    setModels(result.models);
    setConnected(true);
    setNotice(
      result.models.length
        ? "Connected. Choose a model to validate."
        : "Connected, but no models were listed. Enter a model ID supplied by your provider.",
    );
  };
  useEffect(() => {
    if (onboarding && !settings.modelReady && !started.current) {
      started.current = true;
      void run(discover);
    }
  });
  const showConnection = !onboarding || !settings.modelReady;
  return (
    <div className="configuration">
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
              : "Manage your model connection and independent profile repository."}
          </p>
        </div>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {showConnection && (
        <section className="settings-card">
          <h2>1. Model connection</h2>
          <p>
            Connect your model provider using its API endpoint and key. Credentials never appear in
            the profile or this page.
          </p>
          <details open={!onboarding || (!busy && !connected)}>
            <summary>Connection details</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(discover);
              }}
            >
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
                    setConnected(false);
                  }}
                />
              </label>
              <label className="field">
                API key
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder="Leave blank to use the existing key for this endpoint"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setConnected(false);
                  }}
                />
              </label>
              <p className="muted-text">
                A manually entered key is saved locally with owner-only file permissions.
              </p>
              <button className="secondary" type="submit" disabled={busy}>
                {busy ? "Checking…" : "Test connection & load models"}
              </button>
            </form>
          </details>
          {(connected || settings.modelReady) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await api<Settings>("/settings/connection", "PUT", {
                    baseURL,
                    model,
                    ...(apiKey ? { apiKey } : {}),
                  });
                  setApiKey("");
                  setNotice("Model validated and saved.");
                  onChange(result);
                });
              }}
            >
              <label className="field">
                Model
                <input
                  list="available-models"
                  required
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="Choose or enter a model ID"
                />
              </label>
              <datalist id="available-models">
                {models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <p className="muted-text">
                Validation sends two short synthetic requests to check capture interpretation and
                conversation. Normal use sends captures and selected context to this provider.
              </p>
              <button className="primary" type="submit" disabled={busy || !model}>
                {busy ? "Validating…" : "Validate & save model"}
              </button>
            </form>
          )}
        </section>
      )}
      {settings.modelReady && (
        <section className="settings-card">
          <h2>2. Your profile</h2>
          {settings.profileReady && (
            <p>
              Connected to {settings.profilePath}. Existing files are preserved when you connect
              another repository.
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await api<Settings>("/settings/profile", "POST", {
                  mode,
                  path,
                  timezone,
                  ...facts,
                });
                setPrompt((await api<{ prompt: string }>("/profile/enrichment")).prompt);
                setNotice("Profile saved. You can enrich it with any coding agent.");
                onChange(result);
              });
            }}
          >
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
            <label className="field">
              Timezone
              <input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </label>
            {mode === "create" && (
              <>
                <p>These questions are optional. Leave anything you want to explore later blank.</p>
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
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : mode === "create" ? "Create profile" : "Connect profile"}
            </button>
          </form>
        </section>
      )}
      {!onboarding && settings.profileReady && settings.modelReady && (
        <>
          <PeopleSettings key={settings.profilePath} settings={settings} onChange={onChange} />
          <ProjectSettings key={settings.profilePath} settings={settings} onChange={onChange} />
          <T3Settings />
        </>
      )}
      {settings.profileReady && settings.modelReady && (
        <section className="settings-card">
          <h2>Enrich your company and team context</h2>
          <p>
            Use any coding agent with local file access. The generated guidance helps it interview
            you, inspect sources you authorize, and propose profile updates.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                setPrompt((await api<{ prompt: string }>("/profile/enrichment")).prompt);
                setCopied(false);
              });
            }}
          >
            Prepare agent prompt
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
                  void run(async () => {
                    await navigator.clipboard.writeText(prompt);
                    setCopied(true);
                  });
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
      )}
      {onboarding && settings.modelReady && settings.profileReady && (
        <button className="primary" type="button" onClick={onFinish}>
          Open my assistant
        </button>
      )}
    </div>
  );
}
