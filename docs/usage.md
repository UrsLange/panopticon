# Using Panopticon

[Setup](setup.md) · [Project discovery](project-discovery.md) · [Troubleshooting](operations.md#troubleshooting)

## Capture and organize

Capture from any view. **Command–K** focuses the browser capture box; **Command–Enter** saves. The [Mac companion](setup.md#mac-capture-companion) adds a global shortcut and selected-text capture.

A capture is saved before model processing. The assistant classifies it and refines its description using available context. Failed processing retains the capture and can be retried.

In **Inbox**, open an item to edit its kind, project, status, deadline, priority, or related item. **Prompt** holds the refined brief; **User input** retains your capture text. Original wording and revision history remain available. The default inbox shows captures awaiting refinement; **Include refined** also shows accepted captures.

If the current brief is sufficient, choose **Mark as refined**. This accepts a task or idea without calling the model or marking the work done. Save edits first and wait for any running refinement to finish. Accepted tasks appear in **Tasks**, and accepted ideas appear in **Notebook**. Notes still use the separate **Add to profile** flow.

When refinement needs more information, **Let’s clarify the brief** presents individual questions. Type answers and choose **Save answers** to return later, or **Refine with answers** to continue. Partial answers work: subsequent rounds use the previous brief and all saved answers, asking about remaining gaps. Answers survive reloads and failed refinement attempts; earlier rounds remain under **Previous answers**. Original capture text is preserved. Older captures with prose-only clarification need **Refine again** once to generate structured questions.

## Plan your day

**Today** shows started commitments in **In progress**, including those without deadlines. **Due & overdue** includes every unfinished commitment due today or earlier, using your configured timezone. Suggested next actions are the three oldest undated commitments that have not started, with high priority first. The app does not infer deadlines.

**Tasks** shows every refined commitment, including future deadlines and undated tasks beyond Today's suggestions. Search or filter by status, and enable **Include completed & archived** to browse finished work.

Use **Mark in progress** for work you do outside T3 Code. **Mark waiting** pauses a task; **Resume** returns it to progress. Use **Mark done** when non-code work is complete. Code tasks are complete after their implementation is merged. Every commitment shows its status in the list, and Inbox can filter by status. The status selector also supports **Ready for review**, reopening, and archiving.

**Notebook** holds refined ideas and pending profile notes. Discovering a repository does not create a commitment or assign it a priority.

## Implement a commitment

After [connecting T3 Code](setup.md#t3-code), open a commitment and save any edits. Complete refinement and resolve processing errors first. Select its discovered repository if project references do not identify one, then choose **Implement**.

Panopticon reuses the T3 project for that repository path or creates one. It immediately submits the refined task, notes, original wording, linked item, resolved references, and cited profile documents to a new thread. Each implementation uses a separate Git worktree from the current commit; uncommitted changes are not included. T3 runs the project's setup script and uses approval-required permissions.

Choose **Continue in T3 Code** to follow progress and answer approvals in the existing thread. A confirmed handoff marks the commitment **In progress**; an unconfirmed handoff leaves its status unchanged. **Retry handoff** checks the original thread and reuses the saved task and command IDs when dispatch is still needed, including after a restart. Later edits are not included in that retry. **Start another implementation** explicitly creates a new thread from the latest saved version. A handoff does not establish successful execution or completion. Use **Mark merged** after the implementation has been merged.

While the server runs, Panopticon checks submitted implementations every 30 seconds. A finished agent turn moves active work to **Ready for review**; inspect the result in T3 Code, since a finished turn can also contain a question or partial work. A new running turn returns reviewed work to **In progress**. Waiting tasks retain their manual status.

Automatic completion tracks the local `panopticon/<implementation-id>` branch created for the T3 handoff. No pull request, GitHub account, or `gh` CLI is needed. Panopticon identifies the local main branch using `origin/HEAD`, or the single local `main` or `master` branch when that metadata is absent. It reads local Git history every 30 seconds; **Check progress** checks immediately. It never fetches, merges, pushes, or modifies repository contents.

A normal merge commit or a recorded fast-forward merge into that main branch completes the task. The implementation must contain commits beyond its starting commit, those commits must be reachable from main, and its worktree must have no uncommitted or untracked changes. Merely updating the implementation branch from main does not complete it. Merge records can still establish completion after branch and worktree cleanup. Squash merges, renamed branches without matching evidence, and missing fast-forward reflogs require manual **Mark merged** confirmation.

Tracking errors appear on the task and leave completion unchanged. A changed task prompt prevents automatic status transitions from the old implementation. Starting another implementation automatically tracks its new branch. Reopening a task after an observed merge does not immediately complete it again. Local merge detection continues even when T3 Code is unavailable.

## Add knowledge to your profile

An explicit memory request, such as “remember that I prefer atomic conventional commits,” authorizes automatic incorporation into your profile. Unclear or implicit notes wait for review.

For a pending note, open it and choose **Add to profile**. Save any text edits first. Answer clarification questions or use **Retry profile update** after resolving a failure.

After a verified, committed update, the note is marked **Added to profile** and leaves the default queue. Enable **Include completed & archived** to see its original capture, history, and profile links. Editing a completed note reopens it for explicit addition; archiving a pending note dismisses it without incorporating it.

Profile updates use local `docs(profile): ...` commits and never push. Uncommitted edits in a target file block updates; unrelated changes remain untouched. If a commit fails, files may already be saved. Resolve the Git problem and review and commit those changes before retrying.

## Edit personal context

**Your context** edits the profile's Markdown documents. Custom concept types, nested directories, and unknown metadata are supported. External changes are discovered every five seconds; reselect a document to load its latest contents. Stale saves are rejected.

There are no mandatory concept filenames. Settings provides a copyable prompt for a coding agent to enrich company and team context. Project discovery is [configured separately](project-discovery.md).

### Personal aliases

In **Your context → Add aliases**, add one row per explicit mapping:

| Alias | Kind | Target |
| --- | --- | --- |
| Alex | person | alex@example.com |
| Lex | person | alex@example.com |
| portal | project | projects/customer-portal.md |

Use an existing directory email or a profile-relative Project document path. Use `repository` for a Repository document. Include given names explicitly; uniqueness alone does not establish a lasting identity.

Resolved mentions retain their capture-time target and label. Alias edits and ordinary retries do not rebind them. Use **Resolve aliases again** to correct an old binding. If an email or document path changes, update the registry for future captures; old captures keep their saved targets.

## Conversation and session history

**Conversation** answers questions using personal context and current commitments. It is read-only: choose **Save as capture** to keep an answer, or edit an item to apply a change. It does not send messages or modify company systems.

If `ctx` is installed and on the server's PATH, capture refinement can search indexed sessions automatically. In Conversation, manual search results are shared with the model only after you select the sharing checkbox. Panopticon does not initialize or refresh the index; use `ctx status` to inspect coverage. Historical plans are evidence, not proof of completed work.

## People directory

In **Settings → People & Entra sync**:

1. Choose **Existing Azure CLI login** or **Application client credentials**.
2. For CLI access, sign in to the intended tenant with `az login --tenant <tenant-id> --allow-no-subscriptions`. Confirm the detected tenant. The server's PATH must include `az`.
3. For application access, enter the tenant ID, client ID, and client secret **value**. Grant Graph application permissions `User.Read.All` and `GroupMember.Read.All` with administrator consent. CLI credentials also need directory read access.
4. Enter **Your directory email**, matching Entra's `mail` attribute, enable sync, save, and click **Sync people now**.

The directory stores names, email, role, company, and organizational levels in SQLite, separate from the profile. Only enabled member accounts with first name, last name, and valid email are imported. Guests, disabled accounts, and incomplete records are skipped. Duplicate emails fail the refresh.

Hierarchy comes from `onPremisesDistinguishedName`. Group names classify path nodes using `t_` (team), `u_` (unit), `sd_` (subdivision), and `d_` (division) prefixes in `onPremisesSamAccountName`. These are organization-specific conventions. Membership, job titles, and node position do not establish ancestry or reporting lines. Missing levels stay empty; ambiguous nodes appear under **Hierarchy needs attention**.

Sync reads Entra without modifying it. Successful refreshes replace the current profile and tenant's snapshot; failures preserve the last complete directory. Refresh runs every 24 hours while the server is running. Disabling sync retains local lookup data.

Only matching candidates and your own row are included in model context, not the whole directory. Keep personal relationships and aliases in profile documents. Review ambiguous identities and generated profile changes: structural validation does not establish factual accuracy.
