# Phone Bridge

The phone bridge starts a local Codex app-server, waits for `/readyz`, and then starts a small HTTP/WebSocket bridge for browser clients on the LAN.

Its main job is to make the phone a remote control for the Codex session on your desktop. The desktop keeps the real Codex app-server local, while phone and desktop browsers can share the same bridge-managed thread.

## Start

```bash
npm ci
npm run phone
```

For the experimental Claude provider, run:

```bash
npm run phone:claude
```

The command prints one masked URL per LAN IPv4 address:

```text
http://192.168.11.8:45214/?token=abcd…wxyz
```

Open a private tokenized startup URL from a protected notification channel, or open the bridge URL and enter the token from your local `.phone-token` / `PHONE_TOKEN` source. Use the phone to send prompts, approve work, inspect artifacts, and then resume the same thread from the desktop browser when you return to the PC.

Any full `?token=...` URL is a local access key. Keep it private. To stop the bridge, press `Ctrl+C` in the terminal that is running `npm run phone`. If the terminal is closed or the PC restarts, start it again with `npm run phone`.

## Runtime Layout

```text
phone browser
  -> token-protected bridge on 0.0.0.0:45214
  -> Codex app-server on ws://127.0.0.1:45213
```

In Claude mode, the last hop changes to a per-turn `claude -p --output-format stream-json` process. The phone UI and upload path stay the same, but session resume relies on the Claude session ID returned by the CLI rather than Codex app-server threads. The Claude sidebar reads same-workdir Claude Code JSONL sessions from the local Claude project history.

The `phone:claude` script sets Claude as the default provider only. If you save another provider from the settings panel and restart, the saved `.env` value takes precedence.

The bridge shares a thread across multiple browser clients. Add `thread=<thread_id>` to resume a known Codex thread. This is the PC/mobile sync path: both devices are looking at the same bridge-managed Codex conversation instead of creating separate sessions.

For access outside a trusted LAN, do not publish the bridge through an unauthenticated public tunnel or raw port forward. Put trusted access, such as SSH forwarding, a VPN, or a device-authenticated mesh network, in front of it.

For live sync with Codex Desktop itself, connect OCdex to the same headless app-server that Desktop opens through a Remote Connection. The normal local conversation view in Codex Desktop uses a private `stdio` app-server, so there is no public external route for a bridge to inject live UI updates into that local view.

For history sync with the normal Desktop view, OCdex refreshes the app-server history after each completed turn by calling `thread/read` and a scan-backed `thread/list`. This is designed for the Desktop sidebar/history and for reopen/refresh continuity. It is not a live body update path for an already-open normal Desktop thread.

Example using an existing control socket:

```bash
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock \
PHONE_WORKDIR=/Users/admin/Prj/demo \
PHONE_TOKEN=demo-test-token \
npm run phone
```

In this mode, OCdex does not start a new app-server. It uses the app-server behind the socket. If Codex Desktop opens the same headless app-server as a Remote Connection, the Desktop remote view and OCdex browser subscribe to the same thread event stream.

## Useful Environment Variables

```bash
PHONE_UI_PORT=45214 npm run phone
PHONE_AGENT_PROVIDER=claude npm run phone
PHONE_WORKDIR=/Users/admin/Prj/some-project npm run phone
CODEX_MODEL=gpt-5.4 npm run phone
CLAUDE_MODEL=sonnet npm run phone:claude
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock npm run phone
CODEX_APP_SERVER_URL=ws://127.0.0.1:45213 npm run phone
CODEX_HISTORY_SYNC=0 npm run phone
PHONE_TOKEN=choose-your-own-token npm run phone
PHONE_NTFY_TOPIC=your-private-topic npm run phone
PHONE_PUSHOVER_TOKEN=app-token PHONE_PUSHOVER_USER=user-key npm run phone
PHONE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... npm run phone
PHONE_NOTIFY_TIMEOUT_MS=5000 npm run phone
PHONE_NOTIFY_EVENTS=1 npm run phone
PHONE_NOTIFY_EVENT_DEDUPE_MS=60000 npm run phone
```

For parallel operation, treat each `PHONE_UI_PORT` as a fixed workspace slot. Pin the slot with `PHONE_WORKDIR`, and switch Codex or Claude from the browser UI as needed. Settings saved from the browser UI use port-scoped `.env` keys such as `PHONE_WORKDIR_45224`, so one slot's worktree choice does not become every port's default. `PHONE_AGENT_PROVIDER` only sets the default provider for that slot after restart.

Bridge Fleet / Worktree Switchboard manages those slots from one browser tab. Start each bridge on a different port, open one bridge, then use the bridge/worktree pill to paste the remaining protected startup URLs or base URLs plus tokens. Saved host profiles keep base URLs and metadata separate from the local device token store. The active bridge drives the existing chat, terminal, thread, artifact, model, and approval UI; inactive bridges are polled through token-protected APIs for running state, errors, terminal tail, and approval requests.

Each bridge exposes token-protected `GET /api/bridge/info` for fleet metadata: label, group, port, cwd, repo root, branch, short HEAD, dirty summary, model, and capabilities. The endpoint requires the bridge token through the UI's auth header/cookie flow and returns no phone token, app-server secret, webhook URL, or shell execution capability.

Optional fleet launcher:

```json
{
  "bridges": [
    {
      "id": "work-a",
      "label": "Work A",
      "workdir": "/Users/admin/Prj/work-a",
      "phonePort": 45214,
      "appServerPort": 45213
    }
  ]
}
```

```bash
npm run phone:fleet
```

The repository ignores `.phone-fleet.local.json` and `.phone-bridges.local.json`. Keep those local because they can contain private worktree paths and registry details.

Startup notifications are optional. If `PHONE_NTFY_TOPIC` is set, the bridge posts the ready URLs to that ntfy topic. If `PHONE_PUSHOVER_TOKEN` and `PHONE_PUSHOVER_USER` are set, it sends the same URLs through Pushover. If `PHONE_DISCORD_WEBHOOK_URL` is set, it posts them to Discord. `npm run phone` loads local `.env` values before reading these variables. `PHONE_NTFY_SERVER` defaults to `https://ntfy.sh` and must use HTTPS. Notification requests time out after `PHONE_NOTIFY_TIMEOUT_MS`, which defaults to 5000 ms. When a LAN IPv4 URL is available, the startup message can include the tokenized bridge URL for compatibility, so use a private/protected topic, account, or channel and keep notification credentials out of Git. If no LAN IPv4 URL is detected, the notification omits provider link fields and tells you to check the host console.

Task completion/interruption notifications are sent through configured providers. Set `PHONE_NOTIFY_EVENTS=1` to send the rest of the structured work events through the same providers. Supported event types are `bridge_started`, `approval_required`, `question_required`, `test_failed`, `connection_lost`, `history_sync_failed`, and `long_running`. Event payloads include type, title, message, thread ID/title when available, project name, severity, created time, a token-free bridge URL, and optional extra fields. `PHONE_NOTIFY_EVENT_DEDUPE_MS` controls short-window dedupe for non-forced events. Event notifications never include the full phone token.

Rate-limit display supports local, unofficial provider-specific snapshots. For Codex, set `PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` to let the bridge read the Codex auth file at `~/.codex/auth.json`, call Codex Desktop's usage endpoint, normalize only the displayed remaining percentage/reset fields, and cache that small snapshot in `.phone-rate-limits.json`. The legacy `PHONE_RATE_LIMIT_REFRESH_COMMAND` name is still honored for Codex only, so Claude mode cannot accidentally show Codex limits. The bridge does not cache tokens or raw API responses; failures fall back to the last provider cache or `unavailable`. Set `PHONE_RATE_LIMIT_SOURCE=desktop` only when you intentionally want the older macOS Accessibility fallback against the Codex app UI.

If you use ChatGPT in Chrome instead of Codex Desktop, set `PHONE_RATE_LIMIT_SOURCE=chrome`, open a `chatgpt.com` tab, and enable Chrome's `View > Developer > Allow JavaScript from Apple Events`. The Chrome provider reads only `document.body.innerText` after opening the account/profile menu; it does not read cookies, local storage, or request headers.

Claude subscription limits are separate from Anthropic API rate-limit headers. In Claude mode, the bridge listens for Claude Code `rate_limit_event` messages from the headless `claude --output-format stream-json` run and caches the normalized 5-hour / 7-day subscription windows in `.phone-rate-limits.claude.json`. For an interactive Claude Code session, you can also configure a status line command such as `node /absolute/path/to/scripts/capture-claude-rate-limits.js`; it reads Claude Code's `rate_limits` status-line JSON, writes the same cache, and stores only remaining percentage/reset metadata.

Background thread-list polling suppresses repeated identical errors. A transient app-server restart or token mismatch should not continuously fill the chat log with the same `/api/threads` failure.

Claude mode is intentionally narrower than Codex mode. It has Claude Code session listing for the active workdir, but does not provide Codex app-server history sync, plugin lookup, or live tool approval callbacks. Use `CLAUDE_PERMISSION_MODE` or the UI permission mode to decide how much autonomy each spawned Claude run has.

## UI Surface

- recent thread list and thread resume
- phone control of the desktop Codex session
- PC/mobile continuity through a shared bridge-managed thread
- Bridge Fleet / Worktree Switchboard for multiple bridge/worktree slots in one tab
- global running monitor and approval inbox across registered bridges
- thread status badges and `要対応 / 実行中 / 最近` inbox filters
- Review Center tabs for Summary, Diff, Tests, Terminal, Artifacts, and Actions
- connection health panel for bridge, app-server, WebSocket, history sync, token age, notification providers, host, and LAN URL
- PWA app shell caching that excludes `/api/*`, WebSocket, tokenized URLs, uploads, and raw file responses
- cockpit header with thread position, run state, per-thread accent color, compact cwd, and a mini thread switcher
- guarded swipe navigation that avoids text inputs, terminal logs, artifact previews, approval cards, and horizontal scrollers
- chat / terminal view switching with unread badges and preserved drafts/scroll position
- phone terminal mode reserved for manual command input/output, with the chat composer and chat status logs kept out of the terminal surface
- terminal filter chips, client-side search, visible-output copy, auto-scroll pause, wrap/font controls, key-intent chips, and CSS focus mode
- approval cards that stay visible from both chat and terminal views
- quick action chips that insert prompt templates without auto-sending
- model, plugin, config, auth, and automation lookups
- Codex model labels use `5.5-L/M/H/XH`, where `L/M/H/XH` mean Low, Medium, High, and Extra High
- approval and sandbox mode controls for the next turn
- repository artifact preview
- Markdown rendering for chat and artifacts
- browser image attachments passed to Codex as `localImage` inputs
- simple, cyberpunk, and botanical color themes from the settings panel
- LAN sharing for a single bridge-managed thread

The terminal key row does not expose unauthenticated raw shell execution. `$` inserts a safe Codex command-request template, and bridge access remains token protected while the Codex app-server stays bound to localhost.

## PWA Notes

`site.webmanifest` is token-free and uses `display: standalone`. On secure contexts and localhost, the phone UI registers `service-worker.js` and caches only the app shell. API responses, WebSocket traffic, tokenized URLs, uploaded files, raw file routes, terminal history, and approval payloads are not cached. On plain LAN HTTP, browser rules may block Service Worker registration; the normal browser UI still works.

After adding the bridge to the Home Screen, treat the stored token as private local device state. If the token is missing or rotated, open the protected startup URL once, or use the token entry field with the local `.phone-token` / `PHONE_TOKEN` value, so the UI can store the key locally without keeping it in the address bar.
