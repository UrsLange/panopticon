# Panopticon

**A personal workspace for thoughts, commitments, and context.**

Capture a thought, turn it into an idea, note, or commitment, and use your personal context to work through it. Panopticon runs locally on your Mac and connects to a model provider you choose.

Your reusable knowledge lives in a separate Git repository of Markdown files. Captures and conversations stay in a local SQLite database. Model processing sends relevant content to the configured provider.

[Get started](docs/setup.md) · [User guide](docs/usage.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)

## What you can do

- **Capture anywhere.** Use the browser, a global Mac shortcut, or the selected-text service.
- **Plan your day.** See due commitments and suggested next actions.
- **Keep useful context.** Add notes to your profile and edit its Markdown documents.
- **Ask with context.** Discuss your ideas using profile knowledge, commitments, and optional project or session evidence.
- **Connect your work.** Discover local repositories and optionally sync a Microsoft Entra people directory.

Conversation is read-only. Profile updates create local commits; nothing is automatically pushed.

## Get started

You need macOS, Git with a configured author identity, [mise](https://mise.jdx.dev/), and access to a model supporting the Responses API, tool calling, hosted web search, and structured JSON outputs. Tool versions are pinned in [mise.toml](mise.toml).

From the repository root:

```sh
mise trust
mise install
mise run setup
mise run dev
```

Open <http://127.0.0.1:5173>. Connect and validate your model, then create a profile in an empty directory or connect an existing profile Git repository. Choose your timezone.

Setup installs locked dependencies and initializes local storage. You can configure everything else in the app. See [setup and configuration](docs/setup.md) for provider requirements, optional integrations, and environment variables.

## Capture from your Mac

```sh
mise run desktop:install
mise run desktop
```

The companion is named **My Mind** and appears as **Mind** in the menu bar.

| Action | Shortcut or menu |
| --- | --- |
| Open capture from any app | Command–Shift–Space |
| Save a capture | Command–Enter |
| Dismiss and keep the draft | Escape |
| Capture selected text | Services → Add to My Mind |
| Focus capture in the browser | Command–K |

The companion must be running for the global shortcut. Captures are saved before model processing, including during provider outages. [Desktop setup and troubleshooting](docs/setup.md#mac-capture-companion) covers Services, login startup, and shortcut changes.

## Find your way

| Guide | Contents |
| --- | --- |
| [Setup](docs/setup.md) | Requirements, onboarding, model connection, configuration |
| [Usage](docs/usage.md) | Captures, daily planning, profile notes, aliases, people |
| [Operations](docs/operations.md) | Running, scheduling, backups, troubleshooting |
| [Architecture](docs/architecture.md) | Components, data flow, storage, trust boundaries |
| [Project discovery](docs/project-discovery.md) | Repository selection, reviews, profile updates |
| [Contributing](CONTRIBUTING.md) | Development workflow, checks, prompts, contribution rules |

Panopticon is a single-user application bound to loopback. It is not designed for network exposure. Read [data and model access](docs/architecture.md#data-and-model-access) before connecting sensitive context.
