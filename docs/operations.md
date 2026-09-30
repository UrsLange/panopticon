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

## Profile learning

The running server checks at startup and every minute. With a connected model and profile Git repository, consolidation runs once per calendar day in the configured timezone. On restart it catches up from its last successful activity checkpoint. It does not independently launch the backend.

Each run creates an activity artifact containing all events since the last successful checkpoint, plus a separate provisional-memory artifact. The model receives their paths and the profile repository location. It reads, edits, reorganizes, checks, and commits the profile through tools, choosing how much to read and how to complete the task. There are no application-imposed activity, memory-size, or tool-call budgets. Activity arriving during the run remains pending for the next check. Failures retain the checkpoint and provisional memory and retry after 15 minutes. **Your context → Learn from recent activity** runs immediately.

Learning records are scoped to the profile active when an event is recorded. The activity journal, checkpoint, provisional memory, and latest result live in SQLite; temporary task artifacts are removed after the run. Ordinary assistant context uses the profile, not provisional memory. The agent creates local `docs(profile): ...` commits through its commit tool; an unchanged result needs no commit. The profile lock covers the entire agent session. Dirty profile documents block consolidation, including no-op retries after failed commits. Saved work is preserved on failure; review and commit it before retrying. A final success message cannot advance the checkpoint while edits remain uncommitted.

## Backups and upgrades

Back up both the profile repository and the complete application data directory. Stop the backend before copying application data, including SQLite WAL/SHM files if present. The directory contains credentials; protect the backup accordingly.

Use your normal Git workflow to back up the profile. The app never pushes its commits. Switching profiles does not clear captures, and copying the profile does not copy the synchronized people directory.

Stop older instances before upgrading. Install locked dependencies with `mise run setup`, rebuild, and reinstall any desktop or scheduling components you use. Do not run separate instances against the same data directory.

## Troubleshooting

### Refinement and CTX measurements

Run summaries are saved in the application's `assistant.sqlite` database. Inspect recent runs without needing to preserve terminal output:

```sh
sqlite3 -readonly -header -column ~/.local/share/personal-assistant/assistant.sqlite '
SELECT createdAt, itemId,
  json_extract(metrics, "$.durationMs") AS elapsed_ms,
  json_extract(metrics, "$.requests") AS model_requests,
  json_extract(metrics, "$.resumed") AS resumed,
  json_extract(metrics, "$.ctx.searches") AS ctx_searches,
  json_extract(metrics, "$.ctx.reads") AS ctx_reads,
  json_extract(metrics, "$.ctx.durationMs") AS ctx_tool_ms,
  json_extract(metrics, "$.ctx.citedSources") AS ctx_citations,
  json_extract(metrics, "$.ctx.assessment.value") AS ctx_assessment,
  json_extract(metrics, "$.ctx.assessment.explanation") AS ctx_explanation
FROM refinement_runs ORDER BY createdAt DESC LIMIT 20;'
```

Review whether history resolved an actual ambiguity, and compare elapsed time and request counts for similar captures. The model's assessment and citations are clues, not proof that CTX improved the result. A null assessment can mean unused CTX or missing/malformed diagnostic output; use the recorded lookup counts to distinguish them. Invalid diagnostics do not block saved outcomes. Search/read duration excludes the model time spent deciding, interpreting and replaying history; parallel tool durations can overlap. Runs with and without CTX are not randomized or necessarily comparable. These records contain local diagnostic explanations and should be treated as private app data.

### Common issues

**Model connection fails.** Check the endpoint, key, model permissions, network/VPN, and Responses API/tool/structured-output support. Previous working settings are preserved after failed validation.

**Capture processing fails.** The original capture is retained. Restore the provider connection and retry. Review clarification requests before allowing profile incorporation.

**Profile update fails.** Check Git identity, hooks, repository permissions, and uncommitted edits in target files. If files were saved but not committed, review and commit them before retrying. A busy profile means another write is active; abandoned locks are recovered automatically.

**No projects appear.** Roots must directly contain Git repositories. Nested repositories and symlinked child folders are not selected.

**Project review fails.** Check the endpoint, API key, and selected model in Settings, then inspect **Diagnostics** in Settings. Preserve generated-section markers and retry one project or all failures. An unavailable root does not delete existing knowledge.

**People sync fails.** Check the tenant, credentials, Graph read permissions, and administrator consent. For CLI access, ensure `az` is on the backend's PATH. Inspect **Hierarchy needs attention** for organizational gaps and confirm your email matches Entra's `mail` field.

**Background scans do not run.** Inspect launch-agent registration and `project-schedule.log` / `server.log` in the data directory. Confirm roots and timezone in Settings.

**Mac capture is unavailable.** See [desktop setup](setup.md#mac-capture-companion) for Services permissions, shortcut conflicts, and reinstall requirements.
