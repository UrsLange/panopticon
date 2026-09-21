# Contributing

[Setup](docs/setup.md) · [Architecture](docs/architecture.md) · [Operations](docs/operations.md)

## Work locally

Install the pinned tools and dependencies, then run the app from the repository root:

```sh
mise trust
mise install
mise run setup
mise run dev
```

The frontend is at <http://127.0.0.1:5173>; the API uses port 4317. The development task stops an existing assistant from the same checkout before starting.

Use separate `PA_DATA_DIR` and `PA_PROFILE_DIR` paths in `.env.local` for development if you also use Panopticon daily. Configure these before setup. Saved UI settings override environment defaults, so a separate data directory also isolates credentials and profile selection.

## Checks

```sh
mise run check
mise run build
mise run test:e2e
```

| Command | Coverage |
| --- | --- |
| `mise run check` | Biome formatting/lint, TypeScript, Vitest unit and integration tests |
| `mise run build` | Frontend bundle and server compilation |
| `mise run test:e2e` | Chromium installation, desktop compilation, Playwright workflows |
| `mise run profile:check` | Structure and links in the selected profile |
| `mise run format` | Formatting and safe lint fixes |

For a focused test:

```sh
mise exec -- pnpm exec vitest run tests/prompts.test.ts
```

Tests use temporary data, repositories, and substitute model and directory services. Browser tests start their own server on port 4318. They do not establish live model quality, real tenant access, or physical reboot/sleep behavior.

Run checks relevant to your change and report what passed, failed, or was not run. For prompt changes, automated checks establish integration, not answer quality; review representative outputs with a configured provider separately.

## Where changes belong

Put workflow rules in `server/application/`, external I/O in infrastructure adapters, and wiring in `server/bootstrap.ts`. HTTP handlers and schedulers call the same application services. Use existing ports when they fit; add a narrow interface only for a new external capability.

Test application behavior with substitute adapters and persistence or provider boundaries with adapter tests. [Architecture tests](tests/architecture.test.ts) enforce dependency rules; see the [component map](docs/architecture.md#code-boundaries).

Preserve original captures, revision checks, dirty-file protection, profile metadata, and credential isolation. Keep changes focused; avoid unrelated cleanup, speculative abstractions, and extra configuration.

## Edit model prompts

Prompt files are in [prompts/](prompts/):

| File | Purpose |
| --- | --- |
| `shared.md` | Shared capture/conversation instructions |
| `capture.md` | Interpretation and classification |
| `research.md` | Evidence gathering |
| `research-limitations.md` | Handling missing evidence |
| `research-finalization.md` | Finalizing after a research limit |
| `conversation.md` | Conversation answers |
| `profile-update.md` | Incorporating authorized notes |
| `project-exploration.md` | Repository exploration and summaries |
| `profile-enrichment.md` | Copyable enrichment prompt in Settings |
| `connection-validation.md` | Synthetic connection check |

Prompts load once at backend startup. Restart the backend after editing; a browser reload or quitting the companion is insufficient. Prompt-only edits do not require a rebuild. Both development and production read `prompts/` from the working directory.

Preserve `{{name}}` placeholders. Substitution is literal, and unknown variables fail with the file and variable name. Tool definitions, schemas, runtime data, and enforced limits remain in TypeScript.

## Submit a change

Use atomic Conventional Commits, such as `fix(captures): preserve manual edits during retry` or `docs(setup): clarify model requirements`. Keep each commit focused on one reviewable change.

Describe the problem, resulting behavior, and validation. Update the relevant guide when behavior changes. Do not commit credentials, local data, generated builds, or unrelated edits.
