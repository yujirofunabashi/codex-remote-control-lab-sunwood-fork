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

The command prints one URL per LAN IPv4 address:

```text
http://192.168.11.8:45214/?token=...
```

Open the exact printed URL from a phone or another browser on the same network. Use the phone to send prompts, approve work, inspect artifacts, and then resume the same thread from the desktop browser when you return to the PC.

The printed URL includes `?token=...`. Keep that URL private. To stop the bridge, press `Ctrl+C` in the terminal that is running `npm run phone`. If the terminal is closed or the PC restarts, start it again with `npm run phone`.

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
CODEX_WORKDIR=/Users/admin/Prj/demo \
PHONE_TOKEN=demo-test-token \
npm run phone
```

In this mode, OCdex does not start a new app-server. It uses the app-server behind the socket. If Codex Desktop opens the same headless app-server as a Remote Connection, the Desktop remote view and OCdex browser subscribe to the same thread event stream.

## Useful Environment Variables

```bash
PHONE_UI_PORT=45214 npm run phone
PHONE_AGENT_PROVIDER=claude npm run phone
CODEX_WORKDIR=/Users/admin/Prj/some-project npm run phone
CODEX_MODEL=gpt-5.4 npm run phone
CLAUDE_WORKDIR=/Users/admin/Prj/some-project npm run phone:claude
CLAUDE_MODEL=sonnet npm run phone:claude
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock npm run phone
CODEX_APP_SERVER_URL=ws://127.0.0.1:45213 npm run phone
CODEX_HISTORY_SYNC=0 npm run phone
PHONE_TOKEN=choose-your-own-token npm run phone
PHONE_NTFY_TOPIC=your-private-topic npm run phone
PHONE_PUSHOVER_TOKEN=app-token PHONE_PUSHOVER_USER=user-key npm run phone
PHONE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... npm run phone
PHONE_NOTIFY_TIMEOUT_MS=5000 npm run phone
```

Startup notifications are optional. If `PHONE_NTFY_TOPIC` is set, the bridge posts the ready URLs to that ntfy topic. If `PHONE_PUSHOVER_TOKEN` and `PHONE_PUSHOVER_USER` are set, it sends the same URLs through Pushover. If `PHONE_DISCORD_WEBHOOK_URL` is set, it posts them to Discord. `npm run phone` loads local `.env` values before reading these variables. `PHONE_NTFY_SERVER` defaults to `https://ntfy.sh` and must use HTTPS. Notification requests time out after `PHONE_NOTIFY_TIMEOUT_MS`, which defaults to 5000 ms. When a LAN IPv4 URL is available, the message includes the tokenized bridge URL, so use a private/protected topic, account, or channel and keep notification credentials out of Git. If no LAN IPv4 URL is detected, the notification omits provider link fields and tells you to check the host console.

Rate-limit display supports local, unofficial provider-specific snapshots. For Codex, set `PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` to let the bridge read the Codex auth file at `~/.codex/auth.json`, call Codex Desktop's usage endpoint, normalize only the displayed remaining percentage/reset fields, and cache that small snapshot in `.phone-rate-limits.json`. The legacy `PHONE_RATE_LIMIT_REFRESH_COMMAND` name is still honored for Codex only, so Claude mode cannot accidentally show Codex limits. The bridge does not cache tokens or raw API responses; failures fall back to the last provider cache or `unavailable`. Set `PHONE_RATE_LIMIT_SOURCE=desktop` only when you intentionally want the older macOS Accessibility fallback against the Codex app UI.

If you use ChatGPT in Chrome instead of Codex Desktop, set `PHONE_RATE_LIMIT_SOURCE=chrome`, open a `chatgpt.com` tab, and enable Chrome's `View > Developer > Allow JavaScript from Apple Events`. The Chrome provider reads only `document.body.innerText` after opening the account/profile menu; it does not read cookies, local storage, or request headers.

Claude subscription limits are separate from Anthropic API rate-limit headers. In Claude mode, the bridge listens for Claude Code `rate_limit_event` messages from the headless `claude --output-format stream-json` run and caches the normalized 5-hour / 7-day subscription windows in `.phone-rate-limits.claude.json`. For an interactive Claude Code session, you can also configure a status line command such as `node /absolute/path/to/scripts/capture-claude-rate-limits.js`; it reads Claude Code's `rate_limits` status-line JSON, writes the same cache, and stores only remaining percentage/reset metadata.

Background thread-list polling suppresses repeated identical errors. A transient app-server restart or token mismatch should not continuously fill the chat log with the same `/api/threads` failure.

Claude mode is intentionally narrower than Codex mode. It has Claude Code session listing for the active workdir, but does not provide Codex app-server history sync, plugin lookup, or live tool approval callbacks. Use `CLAUDE_PERMISSION_MODE` or the UI permission mode to decide how much autonomy each spawned Claude run has.

## UI Surface

- recent thread list and thread resume
- phone control of the desktop Codex session
- PC/mobile continuity through a shared bridge-managed thread
- model, plugin, config, auth, and automation lookups
- approval and sandbox mode controls for the next turn
- repository artifact preview
- Markdown rendering for chat and artifacts
- browser image attachments passed to Codex as `localImage` inputs
- simple, cyberpunk, and botanical color themes from the settings panel
- LAN sharing for a single bridge-managed thread
