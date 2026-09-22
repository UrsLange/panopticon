import { useEffect, useState } from "react";
import type { PeopleSyncStatus } from "../shared/people";
import type { Settings } from "../shared/schema";
import { api } from "./api";
import { useUnsavedSettings } from "./useUnsavedSettings";

export function PeopleSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  const [form, setForm] = useState(settings.entra);
  const [editing, setEditing] = useState(!settings.entra.tenantId);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<PeopleSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tenantNotice, setTenantNotice] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(settings.entra) || !!secret;
  useUnsavedSettings(dirty);
  useEffect(() => {
    if (!editing || form.authMode !== "azure-cli" || form.tenantId) return;
    let active = true;
    setTenantNotice("Detecting the tenant from your Azure CLI login…");
    void api<{ tenantId: string | null }>("/settings/entra/tenant")
      .then(({ tenantId }) => {
        if (!active) return;
        if (tenantId) setForm((current) => ({ ...current, tenantId }));
        setTenantNotice(
          tenantId
            ? "Tenant detected from your existing login. You can change this value."
            : "Could not detect a tenant. Sign in with Azure CLI or enter the tenant ID manually.",
        );
      })
      .catch(() => {
        if (active) setTenantNotice("Could not detect a tenant. Enter the tenant ID manually.");
      });
    return () => {
      active = false;
    };
  }, [editing, form.authMode, form.tenantId]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api<PeopleSyncStatus>("/people")
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setError("Could not load people sync status.");
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "People operation failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card">
      <h2>People & Entra sync</h2>
      <p className="pill">
        {settings.entra.enabled ? "Daily sync enabled" : "Automatic sync disabled"}
      </p>
      <p>
        Keep a local directory of your organization. Only matching people and your own row are sent
        to your model when processing requests.
      </p>
      {error && (
        <p role="alert" className="warning-text">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        className="secondary"
        type="button"
        disabled={busy || status?.running || !settings.entra.enabled || dirty}
        onClick={() => {
          void run(async () => {
            setStatus(await api<PeopleSyncStatus>("/people/sync", "POST", {}));
          });
        }}
      >
        {status?.running ? "Syncing people…" : "Sync people now"}
      </button>
      {dirty && <p className="muted-text">Save your changes before syncing.</p>}
      {status && (
        <>
          <p>
            Last attempt:{" "}
            {status.lastAttempt ? new Date(status.lastAttempt).toLocaleString() : "Not run yet"}
            <br />
            Last successful sync:{" "}
            {status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : "Not yet"}
            <br />
            {status.count} people imported; {status.skipped} accounts skipped in the last successful
            sync.
          </p>
          {status.error && (
            <p role="alert" className="warning-text">
              {status.error}
            </p>
          )}
          {status.warnings.length > 0 && (
            <details>
              <summary>Hierarchy needs attention ({status.warnings.length})</summary>
              <ul>
                {status.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {!editing ? (
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          Edit people connection
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const next = await api<Settings>("/settings/entra", "PUT", {
                ...form,
                ...(secret ? { clientSecret: secret } : {}),
              });
              setForm(next.entra);
              setEditing(false);
              setSecret("");
              onChange(next);
              setStatus(await api<PeopleSyncStatus>("/people"));
              setNotice(
                "Entra settings saved. Use Sync people now to check access and update the directory.",
              );
            });
          }}
        >
          <fieldset disabled={busy || status?.running}>
            <label className="field">
              Automatic people sync
              <select
                value={String(form.enabled)}
                onChange={(event) => setForm({ ...form, enabled: event.target.value === "true" })}
              >
                <option value="false">Disabled</option>
                <option value="true">Enabled — daily while the app server is running</option>
              </select>
            </label>
            <label className="field">
              Entra authentication
              <select
                value={form.authMode}
                onChange={(event) => {
                  setForm({ ...form, authMode: event.target.value as typeof form.authMode });
                  setSecret("");
                }}
              >
                <option value="azure-cli">Existing Azure CLI login</option>
                <option value="client-secret">Application client credentials</option>
              </select>
            </label>
            <label className="field">
              Entra tenant ID
              <input
                required
                value={form.tenantId}
                onChange={(event) => {
                  setForm({ ...form, tenantId: event.target.value });
                  setSecret("");
                  setTenantNotice("");
                }}
              />
            </label>
            {form.authMode === "azure-cli" && tenantNotice && (
              <p className="muted-text">{tenantNotice}</p>
            )}
            {form.authMode === "azure-cli" ? (
              <p className="muted-text">
                Uses the Azure CLI (az) login on this Mac. Sign in from a terminal with az login
                --tenant &lt;tenant-id&gt; --allow-no-subscriptions. The server must have az on its
                PATH.
              </p>
            ) : (
              <>
                <label className="field">
                  Entra client ID
                  <input
                    required
                    value={form.clientId}
                    onChange={(event) => {
                      setForm({ ...form, clientId: event.target.value });
                      setSecret("");
                    }}
                  />
                </label>
                <label className="field">
                  Entra client secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    placeholder={
                      settings.entra.hasClientSecret
                        ? "Leave blank to keep the secret for the same tenant and client"
                        : "Enter the secret value, not its ID"
                    }
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <p className="muted-text">
                  Requires Microsoft Graph application permissions User.Read.All and
                  GroupMember.Read.All with administrator consent. Secrets are stored locally with
                  owner-only permissions, outside your profile, and are never returned to this page.
                </p>
              </>
            )}
            <label className="field">
              Your directory email
              <input
                type="email"
                required
                value={form.myEmail}
                onChange={(event) => setForm({ ...form, myEmail: event.target.value })}
              />
            </label>
            <p>
              Team, unit, subdivision, and division follow each person's directory path.
              Organizational group names identify the level of each node. Teams may attach directly
              to a subdivision or division; skipped levels stay empty. Group memberships and job
              titles do not determine ancestry.
            </p>
            <p className="muted-text">
              Sync refreshes the local directory. Only enabled member accounts with first name, last
              name, and valid email are included. Turning sync off retains the existing directory.
            </p>
            <div className="settings-save-bar">
              <span>{dirty ? "Unsaved changes" : ""}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setForm(settings.entra);
                  setSecret("");
                  setError("");
                  setTenantNotice("");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button className="primary" type="submit" disabled={!dirty}>
                Save Entra settings
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
