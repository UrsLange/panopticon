# Operations

[Setup](setup.md) · [Architecture](architecture.md) · [Development commands](../CONTRIBUTING.md#checks)

## Run a local production build

From the checkout root:

```sh
mise run build
mise run start
```

Open <http://127.0.0.1:4317>. The backend serves the built frontend and binds only to loopback. Keep the checkout's `prompts/` directory available; prompts load at backend startup.

`mise run dev` runs the watched backend and Vite on port 5173. It first stops an existing assistant belonging to this checkout; it refuses to stop an unrelated process occupying the backend port.

Quit a foreground backend with Control–C. Quitting My Mind alone does not stop the backend.

## Project schedule

The running server checks at startup and every minute. Project discovery is due at 8 a.m. in the configured timezone; missed days coalesce into one scan. Failures retry after 15 minutes. With no project roots, repository scanning is inactive.

To enable checks without manually starting the app:

```sh
mise run projects:schedule
```

This builds the app and installs `~/Library/LaunchAgents/local.personal-assistant.project-scan.plist`. The user LaunchAgent runs at login, at 8 a.m., and every 15 minutes. It starts the backend when needed; the backend decides whether a scan is due. It does not run before login or wake a powered-off Mac.

Reinstall after moving the checkout, changing the Node installation, or changing the backend port.

Inspect registration:

```sh
launchctl print "gui/$(id -u)/local.personal-assistant.project-scan"
```

Stop launch requests:

```sh
launchctl bootout "gui/$(id -u)/local.personal-assistant.project-scan"
```

Move the plist to Trash to prevent loading it at the next login. In-process checks continue while the backend runs.

## People sync

Enabled Entra sync runs at startup and every minute when overdue: 24 hours after success, or 15 minutes after failure. **Sync people now** bypasses the interval. This schedule does not independently launch the backend.

Directory replacement is transactional. Credentials and status stay in the data directory; tokens remain in memory. Legacy generated `people.md` tables are validated, imported when no SQL snapshot exists, and backed up as `people-<id>.md` in the data directory before removal from the profile. Invalid or unmanaged files are preserved.

## Backups and upgrades

Back up both the profile repository and the complete application data directory. Stop the backend before copying application data, including SQLite WAL/SHM files if present. The directory contains credentials; protect the backup accordingly.

Use your normal Git workflow to back up the profile. The app never pushes its commits. Switching profiles does not clear captures, and copying the profile does not copy the synchronized people directory.

Stop older instances before upgrading. Install locked dependencies with `mise run setup`, rebuild, and reinstall any desktop or scheduling components you use. Do not run separate instances against the same data directory.

## Troubleshooting

**Model connection fails.** Check the endpoint, key, model permissions, network/VPN, and Responses API/tool/structured-output support. Previous working settings are preserved after failed validation.

**Capture processing fails.** The original capture is retained. Restore the provider connection and retry. Review clarification requests before allowing profile incorporation.

**Profile update fails.** Check Git identity, hooks, repository permissions, and uncommitted edits in target files. If files were saved but not committed, review and commit them before retrying. A busy profile means another write is active; abandoned locks are recovered automatically.

**No projects appear.** Roots must directly contain Git repositories. Nested repositories and symlinked child folders are not selected.

**Project review fails.** Check the endpoint, API key, and selected model in Settings, then inspect **Diagnostics** in Settings. Preserve generated-section markers and retry one project or all failures. An unavailable root does not delete existing knowledge.

**People sync fails.** Check the tenant, credentials, Graph read permissions, and administrator consent. For CLI access, ensure `az` is on the backend's PATH. Inspect **Hierarchy needs attention** for organizational gaps and confirm your email matches Entra's `mail` field.

**Background scans do not run.** Inspect launch-agent registration and `project-schedule.log` / `server.log` in the data directory. Confirm roots and timezone in Settings.

**Mac capture is unavailable.** See [desktop setup](setup.md#mac-capture-companion) for Services permissions, shortcut conflicts, and reinstall requirements.
