# Project discovery

[Setup](setup.md) · [Architecture](architecture.md) · [Scheduling](operations.md#project-schedule)

Project discovery turns local repositories into profile documents describing their purpose, architecture, technologies, development commands, and source references. It does not execute project commands or create commitments.

## Configure

1. Configure OpenCode's own provider credentials with `mise exec -- opencode auth login` or its configuration file. Panopticon does not pass its API key or endpoint to OpenCode.
2. Make the model selected in Panopticon available in OpenCode. An exact provider/model match wins; otherwise the model name must match exactly one provider.
3. In **Settings → Development environment & projects**, enter absolute paths to folders directly containing repositories, one per line.
4. Save and click **Scan now**.

Saving roots authorizes source inspection and profile-document updates. No roots are selected automatically. Use only trusted repositories.

Settings shows progress, accepted results, unavailable repositories, and failures. **Diagnostics** includes attempt times, model, session ID, and failure category. Retry an individual project or all failed projects. Automatic scans run daily at 8 a.m.; [install the background schedule](operations.md#project-schedule) for checks without manually starting the app.

## Selection and change detection

Only direct child directories with their own `.git` entry are included. Worktrees qualify; symlinked children and the profile repository do not. No remote fetch occurs.

Fingerprints combine HEAD, staged entries, and paths, modes, sizes, and modification times of tracked and nonignored untracked files. Dependency/generated folders and credential-like filenames are excluded from working-file inspection. Scanning is capped at 50,000 files.

Unchanged repositories require no model request. Ignored untracked files and remote-only changes do not trigger review. This is local change detection, not a content audit: an edit preserving both size and modification time can evade detection.

Repository identity is based on its local path. Moving a checkout creates a new entry; separate worktrees have separate entries. Missing repositories retain their knowledge and become unavailable. Unreadable roots report errors, and removing a configured root preserves its documents.

## Exploration and updates

OpenCode runs sequentially with `opencode run --pure` and a ten-minute timeout per repository. It reads source and documentation, then edits a temporary copy of the project's profile document.

The discovery agent allows file discovery, restricted reads, and edits only to the draft. Shell commands, subagents, network tools, and content search are denied. Plugins, formatters, language servers, and sharing are disabled. These are OpenCode permissions, not an operating-system sandbox; higher-priority organizational policies still apply.

Generated content belongs between `project-summary:start` and `project-summary:end` HTML comments. Keep your own context under **Personal notes**, outside those markers.

Before applying a draft, the app checks metadata, protected text, markers, a nonempty summary, and unchanged source/profile snapshots. Invalid or stale drafts are discarded. Applying an accepted draft holds the profile write lock and creates a local `docs(profile): refresh project summary` commit. Registration is committed separately, so a failed first review can leave a valid placeholder.

Failed reviews retain the last accepted fingerprint. Automatic retries wait 15 minutes. A later navigation or commit failure may leave validated changes saved but uncommitted; review and resolve those changes before retrying. Structural checks do not verify model accuracy.

Scans are serialized. Manual requests join active work, and roots or profiles cannot change during a scan. Exploration does not hold the profile lock, so you can keep reading and editing; concurrent edits invalidate stale drafts.

## Profile and local state

Generated documents use `type: Project` and include repository identity, name, accepted fingerprint, availability, and `updated_at`. Absolute repository paths, attempt history, diagnostics, and scheduling state remain in local `project-scan.json`.

`updated_at` changes when knowledge or availability changes. A successful review with an unchanged summary advances only the fingerprint.

The root `index.md` maintains Projects and Aliases sections linking typed documents, including nested ones. Alias registries maintain Referenced concepts links. Managed sections preserve surrounding prose and metadata; malformed or duplicate markers cause an error.

Reconciliation runs on profile connection/loading, API edits, scans, retries, and scheduled checks. External edits are reflected on the next check. Files are written separately with stale-content checks, so an interrupted reconciliation can leave navigation temporarily out of date.
