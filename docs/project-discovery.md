# Project discovery

[Setup](setup.md) · [Architecture](architecture.md) · [Scheduling](operations.md#project-schedule)

Project discovery turns local repositories into profile documents describing their purpose, architecture, technologies, development commands, and source references. It does not execute project commands or create commitments.

## Projects workspace

**Projects** in the main navigation is the operational view of your configured directories. It discovers checkouts independently of AI description scans and stores first-class project records in SQLite, scoped to the selected profile. Each local checkout, including a worktree, has its own project identity. Existing generated descriptions are linked through their repository identity; assigning a different profile page manually preserves that choice.

The default **Attention** view shows projects with local changes, unpublished commits or branches, incoming commits, a reminder to return to the default branch, requested reviews, security findings, or unavailable status information. **All projects**, directory filtering, and search provide access to the complete inventory. Search always includes projects outside the Attention filter.

Tiles have six fixed action positions: local work, incoming changes, default branch, reviews, Dependabot alerts, and failing pipelines. Clean checkouts do not show healthy-state labels. Names are truncated visually, with the full name and path available on hover and in details. The responsive grid keeps tile dimensions consistent and displays several columns on desktop.

Click a project name for a details modal containing checkout metadata, files and diffs, incoming/outgoing commits, remote findings, and the linked profile description. The grid stays mounted underneath, preserving filters and scroll position. Close, Escape, or clicking the backdrop dismisses details; unsaved profile edits require confirmation. Descriptions can be edited inline with stale-document protection; these profile edits are not committed automatically. Returning to the repository's default branch is an individual project preference, initially enabled. The default is read from the remote HEAD when available, with local `main`/`master` detection before the first remote check.

### Git actions

- A clean checkout with incoming changes offers a direct fast-forward pull. Dirty checkouts open the local-change form instead. Diverged branches require an explicit merge, and conflicts must be resolved in the editor.
- Local changes open file selection and a commit message in one dialog. **Commit & push** is available when no known incoming commits block publishing. Unselected staged files stay out of the commit; hooks and signing remain enabled. New untracked file contents should be inspected in the editor before selection.
- Publishing a branch without an upstream explicitly creates or updates that branch on the selected remote and establishes tracking. Pushes are never forced. A failed push after a successful commit leaves the commit intact and reports that publishing remains outstanding.
- Switching back preserves all branches and requires local work to be saved and, when a remote exists, published. If the default branch is already checked out in another worktree, open that checkout instead or disable the reminder for this worktree.

Actions recheck checkout state and reject stale requests. Git operations are serialized per checkout. The application does not discard files, reset branches, automatically stash edits, delete branches, or skip hooks. A merge failure can leave a normal in-progress Git merge; resolve it in the editor and refresh.

### Remote checks and GitHub

The workspace reads local status independently of profile scans. On opening Projects, every ten minutes while it remains active, and on **Refresh**, it checks remotes using your existing Git credentials. Remote checks run in the background with bounded concurrency. Status records distinguish never-checked and failed checks from successful results; the details page shows timestamps.

GitHub.com repositories use the local **GitHub CLI** (`gh`) to load pull requests requesting your review and open Dependabot alerts. Install the CLI and run `gh auth login` if necessary. The application uses existing permissions and does not request new scopes automatically. Disabled Dependabot, insufficient permissions, missing credentials, and unsupported hosts are reported as unavailable in project details, never as zero findings. The security icon appears only for open Dependabot alerts. Only alert titles, severity, source, and links are retained.

A single review or finding opens directly at GitHub. Multiple items open a compact link list. Opening a link does not mark it resolved; a subsequent remote check updates the result. Other Git hosts still support local Git actions, with remote insights available through the repository link.

Pipeline checks use GitHub's remote default branch, regardless of the locally checked-out branch. The latest run of each active GitHub Actions workflow is checked independently. Any failure, timeout, or startup failure adds the project to Attention and lights up its pipeline icon. A newer successful run clears that workflow's failure; queued or running reruns are shown as pending in details. Cancelled, skipped, and neutral runs are not failures. One failing workflow links directly to its run and logs; multiple failures open a link list. Partial or unavailable checks remain visible in details. Pipelines use the same refresh schedule as other repository insights. The GitHub [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) supplies these results.

## Configure

1. Configure and validate the endpoint, API key, and model in **Settings**. Discovery uses this same connection and exact model ID, with no separate agent installation or credentials. The model must support the Responses API, tool calling, and structured JSON outputs.
2. In **Settings → Development environment & projects**, enter absolute paths to folders directly containing repositories, one per line.
3. Save and click **Scan now**.

Saving roots authorizes source inspection and profile-document updates. No roots are selected automatically. Use only trusted repositories.

Settings shows progress, accepted results, unavailable repositories, and failures. **Diagnostics** includes attempt times, model, latest model response ID, files read, and failure category. Retry an individual project or all failed projects. Automatic scans run daily at 8 a.m.; [install the background schedule](operations.md#project-schedule) for checks without manually starting the app.

## Selection and change detection

Only direct child directories with their own `.git` entry are included. Worktrees qualify; symlinked children and the profile repository do not. No remote fetch occurs.

Fingerprints combine HEAD, staged entries, and paths, modes, sizes, and modification times of tracked and nonignored untracked files. Dependency/generated folders and credential-like filenames are excluded from working-file inspection. Scanning is capped at 50,000 files.

Unchanged repositories require no model request. The built-in explorer uses a new fingerprint version, so the first scan after this upgrade reviews existing projects once, even if their files have not changed. Ignored untracked files and remote-only changes do not trigger review. This is local change detection, not a content audit: an edit preserving both size and modification time can evade detection.

Repository identity is based on its local path. Moving a checkout creates a new entry; separate worktrees have separate entries. Missing repositories retain their knowledge and become unavailable. Unreadable roots report errors, and removing a configured root preserves its documents.

## Exploration and updates

Repositories are reviewed sequentially. The model receives the profile location and a read-only project artifact identifying its profile document and repository scope. It chooses which profile documents and repository files to inspect. There are no application-level call-count, accumulated-context or overall review-time budgets. Repository reads remain paginated in 12,000-character pages and reject files larger than 2 MiB.

Repository tools provide file listing, content search and read-only access. They reject paths outside the selected scope, symlinks, common credential files, binary files and generated directories. Profile tools let the model read, edit, create, move or remove Markdown documents, inspect diffs, check structure and commit locally. There are no shell, history or source-repository editing tools. File contents are sent to the configured provider as the model reads them, including personal profile context. Requests use `store: false`; provider retention policies still apply.

The model maintains knowledge directly instead of returning a summary for insertion. It can reorganize the previous project-summary section and supporting concepts while preserving personal knowledge and discovery identity. Renamed project documents are located by repository ID. The prompt requires evidence-based claims, useful relative source references, and preservation of unrelated context.

Before committing, tools check profile structure, external edits, repository identity and source freshness. The completion tool requires retrieved supporting evidence and no outstanding profile edits. Successful changes create local `docs(profile): ...` commits. The scanner records the accepted fingerprint and availability afterward. Registration is committed separately, so a failed first review can leave a valid placeholder.

Failed reviews retain the last accepted fingerprint. Automatic retries wait 15 minutes. Direct edits or commits may already exist when a later step fails; review saved changes and resolve uncommitted edits before retrying. Structural checks do not verify model accuracy.

Scans are serialized. Manual requests join active work, and roots or profiles cannot change during a scan. An editing session holds the profile write lock; competing app writes must wait or retry. External filesystem edits are detected before further writes or commits.

## Profile and local state

Generated documents use `type: Project` and include repository identity, name, accepted fingerprint, availability, and `updated_at`. Absolute repository paths, attempt history, diagnostics, and scheduling state remain in local `project-scan.json`.

`updated_at` changes when knowledge or availability changes. A successful review with unchanged knowledge advances only the fingerprint.

The root `index.md` maintains Projects and Aliases sections linking typed documents, including nested ones. Alias registries maintain Referenced concepts links. Managed sections preserve surrounding prose and metadata; malformed or duplicate markers cause an error.

Reconciliation runs on profile connection/loading, API edits, scans, retries, and scheduled checks. External edits are reflected on the next check. Files are written separately with stale-content checks, so an interrupted reconciliation can leave navigation temporarily out of date.
