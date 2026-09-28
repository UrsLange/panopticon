# Setup and configuration

[README](../README.md) · [Usage](usage.md) · [Operations](operations.md)

## Requirements

- **macOS** for the supported desktop and background-scheduling workflow.
- **Git** with an author name and email configured. Profile writes use your identity and hooks.
- **mise** to install the Node.js and pnpm versions pinned in [mise.toml](../mise.toml).
- **A model endpoint and API key.** The model must support the Responses API, function tool calling, hosted `web_search`, and JSON-schema structured outputs. Chat-completions-only endpoints do not work.
- **Network access** for dependency installation and model requests.

[Project discovery](project-discovery.md) uses the same configured model endpoint and API key as the rest of the app. Optional integrations have separate requirements: Azure CLI or application credentials for [Entra sync](usage.md#people-directory), and an existing indexed `ctx` installation for session history.

## First launch

Run from the checkout root:

```sh
mise trust
mise install
mise run setup
mise run dev
```

Open <http://127.0.0.1:5173>.

1. **Connect a model.** Enter the endpoint and key, select a model or enter its ID, then validate it.
2. **Connect a profile.** Create one in an empty directory or select the root of an existing independent Git repository. Existing files are preserved.
3. **Set your timezone.** It determines today's commitments and the daily project scan.
4. **Add initial context.** Name, role, company, team, and team purpose are optional.

The browser workspace requires a validated model and a profile. Native capture can save thoughts before onboarding is complete.

The default endpoint is `https://litellm.jobrad.tech/v1`, using the key from `~/.config/jobrad-ai/litellm.key` automatically. Alternatively, enter an API key manually and change the endpoint if needed. Validation uses synthetic data, including a tool-call round trip; it sends no personal profile. Failed validation preserves the previous working connection.

## Configuration

Use **Settings** to change the connection, model, profile, timezone, and integrations. Saved settings take precedence over environment defaults and apply without a restart.

For initial defaults, copy [.env.example](../.env.example) to `.env.local` in the repository root. Environment changes require a backend restart.

| Variable | Default or purpose |
| --- | --- |
| `PA_DATA_DIR` | `~/.local/share/personal-assistant` |
| `PA_PROFILE_DIR` | `~/.local/share/personal-assistant-profile` |
| `PA_TIMEZONE` | System timezone |
| `PA_PORT` | Backend port; `4317` |
| `PA_MODEL_BASE_URL` | `https://litellm.jobrad.tech/v1` |
| `PA_MODEL` | Provider model ID; unset |
| `OPENAI_API_KEY` | Provider API key; unset |
| `PA_KEY_FILE` | `~/.config/jobrad-ai/litellm.key` for the default LiteLLM endpoint; empty disables file lookup |
| `PA_CAPTURE_SHORTCUT` | `Command+Shift+Space` |

File-backed credentials are used only for the endpoint configured by `PA_MODEL_BASE_URL` (or its default). Overriding the endpoint disables the default LiteLLM key lookup unless `PA_KEY_FILE` is also explicitly configured. Manually entered keys take precedence, are stored in `settings.json` with owner-only permissions, and are reused only for the same endpoint. Keys are never returned to the browser or written to the profile.

The development proxy targets port 4317 in [vite.config.ts](../vite.config.ts). Changing `PA_PORT` alone does not update it. Reinstall the desktop companion and background schedule after changing the port.

### T3 Code

Run T3 Code on the same machine, with access to the same repository paths. Enable **Network access** in its connection settings and create a pairing token. In **Panopticon Settings → T3 Code**, enter the HTTP or HTTPS endpoint, token, and default provider instance and model IDs from T3 Code, then choose **Connect T3 Code**. Existing projects use their saved model selection; the defaults cover projects without one.

The integration requires T3 Code's environment HTTP API and WebSocket thread/worktree bootstrap support. Connection checks authenticate and read projects without starting an agent. Session credentials stay in owner-only settings storage; reconnect with a fresh pairing token if access expires or is revoked. Disconnect removes Panopticon's saved credential without deleting T3 projects or threads.

Configure [project discovery](project-discovery.md) before [implementing commitments](usage.md#implement-a-commitment).

All implementation preferences support global defaults and project overrides: **auto-start after refinement**, **provider instance and model** (one selection), **implementation location** (new worktree or current checkout), and **permission level**. Configure global implementation location, permission level, and auto-start in **Settings → T3 Code → Save global T3 defaults**, even before connecting T3. The default provider and model are configured in the connection form. Open Projects → project details → **T3 implementation** for project overrides; its **Global T3 defaults** section also edits the global values. Each setting independently inherits its current global value until overridden. Choosing **Use global default** removes that override, so later global changes apply to new implementations. Retries retain the original handoff's model, workspace, and permission settings. The T3 endpoint and pairing credentials remain one global connection.

**Global auto-start after refinement** in Settings → T3 Code is off by default, including for existing installations. Save **On** to authorize automatic implementation after successful refinement. In Projects → project details → **T3 implementation**, choose **Use global default**, **On**, or **Off** for that project. An explicit project **Off** overrides a global **On**. Project details show the effective saved value; the global default is also editable there. Changing a setting does not launch existing tasks by itself.

Auto-start grants consent to start T3 implementation without a separate launch-confirmation step. It does not authorize publishing, pushing, opening pull requests, or other shared-system changes. T3's model, workspace, and permission settings continue to apply.

## Mac capture companion

```sh
mise run desktop:install
mise run desktop
```

This installs `~/Applications/My Mind.app` and `~/Library/Services/Add to My Mind.workflow`. The menu-bar companion provides **Command–Shift–Space**; the text service provides **Services → Add to My Mind** in supporting applications.

Press **Command–Enter** to save. Escape, clicking away, or repeating the shortcut dismisses the window and retains the draft across restarts. Selected-text capture saves directly and shows a notification. macOS dictation works in the capture box; dedicated audio recording is not included.

Both capture paths start the backend when needed. The text service works without the companion running; quitting the companion leaves the backend running.

If the service is missing, enable it in **System Settings → Keyboard → Keyboard Shortcuts → Services** and reopen the target app. Try the application's Services menu if its context menu does not show it.

To change the shortcut, set `PA_CAPTURE_SHORTCUT`, quit My Mind, and reinstall. Add My Mind to macOS Login Items if you want it at login. Reinstall after moving the checkout or runtime: the app references both and is not a standalone distribution.

To uninstall, quit My Mind and move its app and workflow to Trash. Your data remains intact.
