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

The default endpoint is `https://api.openai.com/v1`. Enter your provider's API key and change the endpoint if needed. Validation uses synthetic data, including a tool-call round trip; it sends no personal profile. Failed validation preserves the previous working connection.

## Configuration

Use **Settings** to change the connection, model, profile, timezone, and integrations. Saved settings take precedence over environment defaults and apply without a restart.

For initial defaults, copy [.env.example](../.env.example) to `.env.local` in the repository root. Environment changes require a backend restart.

| Variable | Default or purpose |
| --- | --- |
| `PA_DATA_DIR` | `~/.local/share/personal-assistant` |
| `PA_PROFILE_DIR` | `~/.local/share/personal-assistant-profile` |
| `PA_TIMEZONE` | System timezone |
| `PA_PORT` | Backend port; `4317` |
| `PA_MODEL_BASE_URL` | `https://api.openai.com/v1` |
| `PA_MODEL` | Provider model ID; unset |
| `OPENAI_API_KEY` | Provider API key; unset |
| `PA_KEY_FILE` | Optional token file path; unset disables file lookup |
| `PA_CAPTURE_SHORTCUT` | `Command+Shift+Space` |

File-backed credentials are used only for the endpoint configured by `PA_MODEL_BASE_URL` (or its default). Manually entered keys are stored in `settings.json` with owner-only permissions and reused only for the same endpoint. Keys are never returned to the browser or written to the profile.

The development proxy targets port 4317 in [vite.config.ts](../vite.config.ts). Changing `PA_PORT` alone does not update it. Reinstall the desktop companion and background schedule after changing the port.

### T3 Code

Run T3 Code on the same machine, with access to the same repository paths. Enable **Network access** in its connection settings and create a pairing token. In **Panopticon Settings → T3 Code**, enter the HTTP or HTTPS endpoint, token, and default provider instance and model IDs from T3 Code, then choose **Connect T3 Code**. Existing projects use their saved model selection; the defaults cover projects without one.

The integration requires T3 Code's environment HTTP API and WebSocket thread/worktree bootstrap support. Connection checks authenticate and read projects without starting an agent. Session credentials stay in owner-only settings storage; reconnect with a fresh pairing token if access expires or is revoked. Disconnect removes Panopticon's saved credential without deleting T3 projects or threads.

Configure [project discovery](project-discovery.md) before [implementing commitments](usage.md#implement-a-commitment).

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
