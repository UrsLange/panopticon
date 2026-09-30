# Using Panopticon

[Setup](setup.md) · [Project discovery](project-discovery.md) · [Troubleshooting](operations.md#troubleshooting)

## Capture and organize

Capture from any view. **Command–K** focuses the browser capture box; **Command–Enter** saves. The [Mac companion](setup.md#mac-capture-companion) adds a global shortcut and selected-text capture.

A capture is saved before model processing. The assistant uses tools to inspect ctx session history, profile knowledge, captures and project files, then saves the useful outcome. Mixed captures can produce linked tasks, ideas and knowledge notes. Failed processing retains the capture and can be retried.

Every capture starts in **Inbox**. **Needs your attention** holds captures requiring clarification, retry, or resumption; **Refining** holds work the assistant is processing automatically. Successful refinement moves ideas to **Notebook** and commitments to **Tasks**. Notes follow the profile workflow below. Editing the capture's **User input** sends it back through Inbox while retaining its task status and history.

Open a capture or task to edit it in the details panel. The main content is the refined task, idea or implementation prompt. **Original input** retains the capture text with resolved aliases. Original wording and revision history remain available. Refinement never closes an open panel or discards a draft.

Navigation badges mean **needs your attention**, not total items. Inbox counts captures requiring your help, excluding background refinement. Tasks counts each task due today, overdue, or ready for review once. Use **Needs your attention** in the task status filter to see those tasks. Page summaries show totals separately; Notebook has no attention badge.

## Manage tasks

**Tasks** groups active work into **Ready for review**, **In progress**, **Backlog**, and **Waiting**. Within each group, tasks appear by earliest deadline, then high priority, then age. Search and project/status filters narrow the list. Completed and archived tasks remain available through the status filter.

Click a task's completion circle once to finish it; **Undo** restores its previous status. Click its title for details, editing, and actions such as starting work or continuing in T3 Code. Closing the panel preserves your list position and filters.

If the current brief is sufficient, choose **Mark as refined**. This accepts a task or idea without calling the model or marking the work done. Save edits first and wait for any running refinement to finish. Accepted tasks appear in **Tasks**, and accepted ideas appear in **Notebook**. Clear knowledge notes are incorporated directly; pending notes retain clarification and retry actions.

When refinement needs more information, **Let’s clarify the brief** presents individual questions. Type answers and choose **Save answers** to return later, or **Refine with answers** to continue. Partial answers work: subsequent rounds use the previous brief and all saved answers, asking about remaining gaps. The conversation, tool evidence and provider-supplied reasoning are retained locally while questions remain, including across app restarts. Continuing with answers resumes that conversation. Completion discards it; editing the capture, resetting references or changing the model, endpoint or refinement instructions starts a fresh conversation. Answers survive reloads and failed refinement attempts; earlier rounds remain under **Previous answers**. Original capture text is preserved. Older captures with prose-only clarification need **Refine again** once to generate structured questions.

## Plan your day

**Today** shows refined, started commitments in **In progress**, including those without deadlines. **Due & overdue** includes every refined, unfinished commitment due today or earlier, using your configured timezone. Suggested next actions are the three oldest refined, undated commitments that have not started, with high priority first. The app does not infer deadlines.

Use **Mark in progress** for work you do outside T3 Code. **Mark waiting** pauses a task; **Resume** returns it to progress. Use **Mark done** when non-code work is complete. Detected code merges wait for your confirmation before completing the task. Every commitment shows its status in the list, and Tasks can filter by status. The status selector also supports **Ready for review**, reopening, and archiving.

**Notebook** holds refined ideas, with search, project filtering, and access to archived ideas. Discovering a repository does not create a commitment or assign it a priority.

## Implement a commitment

After [connecting T3 Code](setup.md#t3-code), open a task with **Execution → Implementation** and save any edits. Ordinary tasks can belong to projects and remain manual; project membership does not start implementation. Complete refinement and resolve processing errors first. Select its discovered repository if project references do not identify one, then choose **Implement**.

You can opt into **auto-start after refinement** globally or for a project in [T3 settings](setup.md#t3-code). It defaults to off. After a successful refinement is saved, Panopticon starts T3 only for an active, ready implementation task with a nonempty prompt, no unresolved clarification, and one resolved, available repository in the configured project roots. Ideas, notes, failed or unsaved refinements, closed tasks, no-project tasks, and missing or ambiguous repositories do not auto-start. Manually marking a task refined does not trigger it. The task shows the effective setting, and manual implementation remains available.

Auto-start uses the same serialized, persisted handoff as manual implementation. Duplicate processing or refinement retries do not create another thread after submission. An unconfirmed handoff retains its original thread and command IDs; automatic retries require the same prompt and repository, while **Retry handoff** remains available for the original saved attempt. A failed auto-start is shown separately on the task, including after restart: refinement remains successful. Fix the connection or repository issue and use the manual launch or retry action. Enabling auto-start authorizes starting implementation only; publishing and other shared-system changes still require separate approval.

Panopticon reuses the T3 project for that repository path or creates one, then submits the saved refined prompt to a new thread. By default, each implementation uses a separate Git worktree from the current commit; uncommitted changes are not included. T3 runs the project's setup script and uses approval-required permissions. Global defaults and project overrides can select the current checkout, another model, or another permission level.

Choose **Continue in T3 Code** to follow progress and answer approvals in the existing thread. A confirmed handoff marks the commitment **In progress**; an unconfirmed handoff leaves its status unchanged. **Retry handoff** checks the original thread and reuses the saved task and command IDs when dispatch is still needed, including after a restart. Later edits are not included in that retry. **Start another implementation** explicitly creates a new thread from the latest saved version. A handoff does not establish successful execution or completion. Use **Mark merged** after the implementation has been merged.

While the server runs, Panopticon checks submitted implementations every 30 seconds. A finished agent turn moves active work to **Ready for review**; inspect the result in T3 Code, since a finished turn can also contain a question or partial work. A new running turn returns reviewed work to **In progress**. Waiting tasks retain their manual status.

Completion detection tracks the local `panopticon/<implementation-id>` branch created for the T3 handoff. No pull request, GitHub account, or `gh` CLI is needed. Panopticon identifies the local main branch using `origin/HEAD`, or the single local `main` or `master` branch when that metadata is absent. It reads local Git history every 30 seconds; **Check progress** checks immediately. It never fetches, merges, pushes, or modifies repository contents.

A normal merge commit or a recorded fast-forward merge into that main branch proposes completion. The implementation must contain commits beyond its starting commit, those commits must be reachable from main, and its worktree must have no uncommitted or untracked changes. Merely updating the implementation branch from main does not qualify. Merge records can still provide evidence after branch and worktree cleanup. Squash merges, renamed branches without matching evidence, and missing fast-forward reflogs require manual **Mark merged** confirmation.

When you open or return to the website, a review dialog presents pending completion suggestions and their evidence, one task at a time. **Confirm completion** (**C**) marks the task done. **Keep open** (**K**) preserves its current status and dismisses that suggestion; the same merged commit will not prompt again. New merged commits or a new implementation can produce another suggestion. **Decide later** skips the current task, and **Escape** defers the remaining tasks. Deferred suggestions persist for your next visit, including after a server restart. While you are using the website, new suggestions appear in a quiet **tasks ready for review** button instead of interrupting you. Shortcuts operate only inside the review dialog.

Tracking errors appear on the task and leave completion unchanged. A changed task prompt prevents automatic status transitions from the old implementation. Starting another implementation automatically tracks its new branch. Reopening a task after an observed merge does not immediately complete it again. Local merge detection continues even when T3 Code is unavailable.

## Add knowledge to your profile

A clear knowledge note, such as “I prefer atomic conventional commits,” is incorporated directly into your profile. No special prefix is required. Ambiguous intent or identity remains pending for clarification. Tasks and tentative ideas do not become established profile facts; daily learning can separately retain useful knowledge from your activity.

For a pending note, open it and choose **Add to profile**. Save any text edits first. Answer clarification questions or use **Retry profile update** after resolving a failure.

The model receives the note and clarification answers as an artifact, inspects existing profile knowledge, and uses tools to edit, verify and commit the update. It can reorganize concepts when useful and leaves unresolved questions pending. Tune this behavior in `prompts/profile-update.md` and restart the backend after changes.

After a verified, committed note update, the note is marked **Added to profile** and leaves Inbox. Its content is available in **Your context**. Archiving a pending note dismisses the note workflow; daily learning separately considers recorded activity.

Profile updates use local `docs(profile): ...` commits and never push. Uncommitted edits in a target file block updates; unrelated changes remain untouched. If a commit fails, files may already be saved. Resolve the Git problem, then retry: recorded agent drafts can be reviewed and committed by the model. Manually modified drafts require your review. Subjects stay within 72 characters, with detailed changes in the commit body.

## Edit personal context

**Daily profile learning** in **Your context** shows the latest result and any failure. The daily pass considers new captures, submitted edits, clarification answers, conversation messages, and implementation outcomes. It can retain clear facts and well-supported implications after one observation, with uncertainty preserved. Less certain useful observations stay in a small provisional memory outside the profile. Task details and insignificant activity should not become permanent knowledge.

Choose **Learn from recent activity** to run a pass immediately. The model updates existing knowledge rather than building a diary, and local Git diffs show its changes. Daily learning does not mark captures as incorporated or complete tasks. Learning starts with activity recorded by this version; older unscoped conversations and captures are not automatically imported.

The model receives an activity artifact and the profile location, then uses tools to read context, update files, inspect its work, and commit changes. Its file reads are sent to your configured provider. Review the first few Git diffs to tune `prompts/profile-consolidation.md`; restart the backend after editing the prompt. Inferences remain model judgments, not verified facts.

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

**Conversation** answers questions using personal context and current commitments. Choose **Save as capture** to keep an answer as an item, or edit an item to apply a change. Daily learning can retain useful context from your statements; assistant replies are contextual evidence, not independent confirmation. Conversation does not send messages or modify company systems.

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
