# Phone Bridge

The phone bridge starts a local Codex app-server, waits for `/readyz`, and then starts a small HTTP/WebSocket bridge for browser clients on the LAN.

Its main job is to make the phone a remote control for the Codex session on your desktop. The desktop keeps the real Codex app-server local, while phone and desktop browsers can share the same bridge-managed thread.

## Start

```bash
npm ci
npm run phone
```

To use the UI's restart button — in the sidebar footer beside `設定`, and inside the settings panel — start through a supervised entry point. Restarting exits with code 42 and relies on a supervisor to bring the bridge back, so without one the bridge stays down. Both buttons confirm before they act:

```bash
npm run phone:loop          # Codex
npm run phone:loop:claude   # Claude
```

A bridge started without a supervisor refuses the restart request and says why, rather than stopping somewhere you cannot reach it.

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

## Updating across machines

Use the same workflow in either direction: create a dedicated `feature/*` branch/worktree from `develop`, verify the change, integrate it into `develop`, then push to `origin`. An uncommitted edit on a running bridge is not shared. See [Normal Repository Work](./contributing.md#normal-repository-work).

In the receiving application's clean `develop` checkout:

```bash
npm run bridge:check  # Fetch and compare; do not update working files
npm run bridge:pull   # Accept only a safe fast-forward
```

Unfinished edits, unpublished/diverging commits, unexpected tracking branches and interrupted Git operations stop the update. The commands never commit, push, stash, reset or switch branches. Inspect and integrate both sides on a feature branch before retrying. Keep each machine's credentials, connection registry backups and conversation histories local; do not synchronize those files.

Connection cards distinguish **app** build identity from the selected **workspace** branch/dirty status. Matching HEAD alone does not prove delivery: the authenticated `/api/bridge/info` response includes `build` with the application root, commit, actual source fingerprints, dirty/tracking state and `restartRequired`. The fingerprints exclude machine settings and timestamps. The sidebar warns about differing builds, unshared changes and restart waits even when connections are folded. Disconnected peers or older bridges without this metadata remain unknown, not synchronized.

Tracking state reflects the last local fetch; run `bridge:check` for a fresh remote comparison. The UI's recheck button refreshes bridge state but does not pull code. Any browser source change, including CSS and helpers, changes the served browser build so idle pages can reload; active work, drafts and attachments defer it. Backend changes require an authorized restart of the affected supervised bridge after active work is saved. If dependencies changed, run `npm ci` first. Verify both bridges' actual served screens and matching clean builds with no restart warning afterward.

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
CODEX_MODEL=gpt-5.6-sol npm run phone
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
PHONE_NOTIFY_EXCERPT_CHARS=200 npm run phone
PHONE_APPROVAL_TIMEOUT_MS=1200000 npm run phone
PHONE_CLAUDE_STALL_WARN_MS=90000 npm run phone
PHONE_CLAUDE_STALL_KILL_MS=300000 npm run phone
```

For parallel operation, treat each `PHONE_UI_PORT` as a fixed workspace slot. Pin the slot with `PHONE_WORKDIR`, and switch Codex or Claude from the browser UI as needed. When `CODEX_APP_SERVER_PORT` is not set, each slot uses `PHONE_UI_PORT - 1` for its local Codex app-server, such as `45224 -> 45223`, so parallel slots do not reuse the `45214 -> 45213` upstream by accident. Settings saved from the browser UI use port-scoped `.env` keys such as `PHONE_WORKDIR_45224`, so one slot's worktree choice does not become every port's default. `PHONE_AGENT_PROVIDER` only sets the default provider for that slot after restart.

Bridge Fleet / Worktree Switchboard manages those slots from one browser tab. Start each bridge on a different port, open one bridge, then use the bridge/worktree pill to paste the remaining protected startup URLs or base URLs plus tokens. Saved host profiles keep base URLs and metadata separate from the local device token store. The active bridge drives the existing chat, terminal, thread, artifact, model, and approval UI; inactive bridges are polled through token-protected APIs for running state, errors, terminal tail, and approval requests.

Each bridge exposes token-protected `GET /api/bridge/info` for fleet metadata: label, group, port, cwd, repo root, branch, short HEAD, dirty summary, model, and capabilities. The endpoint requires the bridge token through the UI's auth header/cookie flow and returns no phone token, app-server secret, webhook URL, or shell execution capability.

Optional fleet launcher:

```json
{
  "bridges": [
    {
      "id": "work-a",
      "label": "Work A",
      "provider": "codex",
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

Set `provider` to `codex` or `claude` when a fleet slot should stay pinned after restart. The launcher passes the provider as both shared and port-scoped `PHONE_AGENT_PROVIDER` values for that bridge process. When the bridge was started by the fleet launcher, browser UI settings also update the matching fleet entry for workdir, model, and provider so those choices survive the next fleet restart.

The repository ignores `.phone-fleet.local.json`, `.phone-bridges.local.json`, the per-port registry backups `.phone-bridges.<port>.local.json`, and `.phone-registry-key`. Keep those local because they can contain private worktree paths, registry details, and the key that protects backed-up bridge tokens.

Startup notifications are optional. If `PHONE_NTFY_TOPIC` is set, the bridge posts the ready URLs to that ntfy topic. If `PHONE_PUSHOVER_TOKEN` and `PHONE_PUSHOVER_USER` are set, it sends the same URLs through Pushover. If `PHONE_DISCORD_WEBHOOK_URL` is set, it posts them to Discord. Startup is one message: it names the Mac (`PHONE_MACHINE_LABEL`, or the hostname) and the folder, and when `tailscale serve` publishes this bridge over HTTPS that published address comes first. `npm run phone` loads local `.env` values before reading these variables. Each of them also takes the slot-scoped form the rest of a fleet's `.env` uses, such as `PHONE_DISCORD_WEBHOOK_URL_45214`, so two bridges sharing one file can post to different channels or only one of them can notify at all; a bare key still covers every slot. `PHONE_NTFY_SERVER` defaults to `https://ntfy.sh` and must use HTTPS. Notification requests time out after `PHONE_NOTIFY_TIMEOUT_MS`, which defaults to 5000 ms. The startup message is token-free by default: an installed Home Screen app already holds its token and only needs to know the bridge is up, while a tokenized URL in a channel is the key to the whole fleet, because a bridge serves the registry backup. Set `PHONE_NOTIFY_STARTUP_TOKEN_URLS=1` when you want the tokenized URL for first-time setup, and use a private/protected topic, account, or channel. Keep notification credentials out of Git. If no LAN IPv4 URL is detected, the notification omits provider link fields and tells you to check the host console.

Task completion/interruption notifications are always sent through configured providers. Set `PHONE_NOTIFY_EVENTS=1` to send the rest of the work events through the same providers. Supported event types are `approval_required`, `approval_expired`, `question_required`, `test_failed`, `connection_lost`, `history_sync_failed`, and `long_running`; startup is covered by the single startup message above, and no separate `bridge_started` event is sent. Messages are written in Japanese for a person to read. The first line says which Mac's AI did what (for example `✅ mini の Claude の作業が終わりました` or `🔔 Air の Codex が承認を待っています`); then come the folder, the start of the request, the start of the answer on completion (200 characters by default; `PHONE_NOTIFY_EXCERPT_CHARS` changes it and `0` leaves it out), the command or file an approval is for, the question when there is one, the cause of a failure, what to do next, and one token-free bridge URL. Discord receives the headline as the message text and the rest as an embed, posted under a per-Mac name such as `Claude mini` or `Codex Air`, with the embed's edge in that Mac's colour (mini amber, Air blue, any other name a fixed colour derived from it; `PHONE_BRIDGE_COLOR` overrides it), so two Macs posting to one channel can be told apart before the message is read. Thread IDs, turn IDs, model names, raw event types, and UTC timestamps are not included. A turn that ends on a question sends `question_required` only, not a completion notice as well; a connection lost mid-turn is one `test_failed` message that carries the cause. The link uses the HTTPS address `tailscale serve` publishes for the bridge when there is one, because the raw IP is a different origin where the Home Screen app's saved token does not apply. `PHONE_NOTIFY_EVENT_DEDUPE_MS` controls short-window dedupe for non-forced events. Event notifications never include the full phone token.

Rate-limit display supports local, unofficial provider-specific snapshots. For Codex, set `PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` to let the bridge read the Codex auth file at `~/.codex/auth.json`, call Codex Desktop's usage endpoint, normalize only the displayed remaining percentage/reset fields, and cache that small snapshot in `.phone-rate-limits.json`. The legacy `PHONE_RATE_LIMIT_REFRESH_COMMAND` name is still honored for Codex only, so Claude mode cannot accidentally show Codex limits. The bridge does not cache tokens or raw API responses; failures fall back to the last provider cache or `unavailable`. Set `PHONE_RATE_LIMIT_SOURCE=desktop` only when you intentionally want the older macOS Accessibility fallback against the Codex app UI.

If you use ChatGPT in Chrome instead of Codex Desktop, set `PHONE_RATE_LIMIT_SOURCE=chrome`, open a `chatgpt.com` tab, and enable Chrome's `View > Developer > Allow JavaScript from Apple Events`. The Chrome provider reads only `document.body.innerText` after opening the account/profile menu; it does not read cookies, local storage, or request headers.

Claude subscription limits are separate from Anthropic API rate-limit headers. In Claude mode, the bridge listens for Claude Code `rate_limit_event` messages from the headless `claude --output-format stream-json` run and caches the normalized 5-hour / 7-day subscription windows in `.phone-rate-limits.claude.json`. For an interactive Claude Code session, you can also configure a status line command such as `node /absolute/path/to/scripts/capture-claude-rate-limits.js`; it reads Claude Code's `rate_limits` status-line JSON, writes the same cache, and stores only remaining percentage/reset metadata.

Background thread-list polling suppresses repeated identical errors. A transient app-server restart or token mismatch should not continuously fill the chat log with the same `/api/threads` failure.

Claude mode is intentionally narrower than Codex mode. It has Claude Code session listing for the active workdir, but does not provide Codex app-server history sync or plugin lookup. Use `CLAUDE_PERMISSION_MODE` or the UI permission mode to decide how much autonomy each spawned Claude run has.

Whichever mode is picked, the run is given a way to ask. Claude Code is spawned with a permission-prompt tool backed by a per-bridge Unix socket, so any tool call it stops on becomes an approval card on the phone. Full access (`bypassPermissions`) included: that mode lets ordinary tool calls through without consulting the prompt tool, but a `PreToolUse` hook answering `ask` still stops one, and a run with nowhere to ask records a permission denial and waits. The bridge holds an open approval until it is answered, so reloading or reconnecting hands the same question back instead of leaving a run that looks stuck. The same holds when no phone is connected: if a notification channel (Discord and the like) is configured, the question is held and announced rather than declined on the spot, and the app that opens later is handed the card through `ready`. That announcement is sent regardless of `PHONE_NOTIFY_EVENTS`. Only when there is neither a connected phone nor a notification channel is the request declined immediately. A question left unanswered for `PHONE_APPROVAL_TIMEOUT_MS` (default 1200000 ms, 20 minutes) is declined and an `approval_expired` notification says so. Claude Code aborts a stdio MCP call that stays silent for 30 minutes, so keep this value below that. Codex approvals are carried in the `ready` run state too, so a reconnecting phone gets that card back as well. Holding ends when the asker does: if the turn that asked finishes without an answer, the bridge drops the question rather than handing back a card no decision can reach.

A turn only ends when the Claude Code process exits, so a process that stops emitting without exiting leaves 「処理中」 on the phone indefinitely — indistinguishable from work still in progress, which is the one question the screen exists to answer. The bridge tracks the last output of each turn: after `PHONE_CLAUDE_STALL_WARN_MS` of silence (default 90000 ms) it says once in the work log that the turn may have stopped responding, and after `PHONE_CLAUDE_STALL_KILL_MS` (default 300000 ms) it ends the process, closes the turn as 「応答なし」, and sends a `failed` run notification. Because a hung process can ignore SIGTERM, the kill escalates to SIGKILL after `PHONE_CLAUDE_STALL_KILL_GRACE_MS` (default 2000 ms). Time alone does not decide it: a turn with a tool call still in flight is silent for as long as a build or test suite takes and is working the whole time, so it is only noted, never killed. Only a turn that went silent after its tool result — owing output and producing none — is ended. Either threshold can be switched off with `0` independently of the other, and whatever partial answer already arrived is kept in the history.

## The Sidebar Spans Every Workdir

Sessions are filed per working directory. While the sidebar read only the active one, **changing the workdir made every earlier session look deleted** — the display was scoped, the records were never lost.

The sidebar now reads every workdir under `~/.claude/projects`, in one of two orders:

- **プロジェクト別 (by project)** — grouped under a heading per folder. The original behaviour, and still the default.
- **日時順 (by date)** — headings collapsed into one list across all folders, newest first. Each row carries its own `cwd:`, so nothing is lost by dropping the headings.

The choice is remembered per device.

Use **新規セッション (New session)** above the chat list to start in a folder that has no session history. Choose the Mac and AI, browse from that Mac's home folder, and press **このフォルダで開始 (Start in this folder)**. **ホーム (Home)** and **↑ 上の階層 (Parent folder)** navigate the tree; entering an absolute path and pressing **開く (Open)** also checks a folder. The picker uses existing directories under the selected Mac's home, including ordinary folders without a Git repository. It does not create directories or change startup defaults.

Browsing does not switch the active conversation. Cancelling preserves the current chat and draft; starting opens a fresh session on the selected Mac with the selected AI. Existing chats remain available in the list. A loading, failed or edited path cannot be used until its folder is confirmed. Check this flow with `node scripts/new-session-smoke.js` and `node scripts/new-session-smoke.js --webkit`; these use mocked connections and do not send AI requests.

The `>_` at the end of each Codex or Claude row copies a command that can be pasted into either Mac's terminal. It resumes the exact session in its original working directory **on the Mac that owns it**, without transferring any transcript.

On the owning Mac it starts locally; on the other Mac it connects through SSH. The mini must already have an `air` SSH alias targeting the Air's session owner, and the Air must have a `mini` alias targeting the mini's session owner. Other host types use their hostname as the SSH destination. The generated command checks the hostname again after connecting and stops on a mismatch. Connection failures never fall back to starting an AI on the wrong Mac.

For Codex, the inner command is `codex resume <session-id> --remote <owner-app-server-endpoint>`. It joins the same running app-server as the phone, so both interfaces can show the conversation and continue it without creating a second writer. The endpoint comes from that row's owning bridge, including its slot or local Unix socket; it is never inferred from the phone's address. Closing the terminal leaves the shared server running. Reopen the same chat on the phone to continue; terminal input, active turns, interrupts and resolved approvals are reflected there. An independently started plain `codex` session must finish and close before this shared server can resume it. For future terminal-first work, connect with `codex --remote <owner-app-server-endpoint>` from the project's directory.

Claude continues to use `claude --resume <session-id>` and its existing transcript watcher; the shared Codex server does not change Claude's execution model. The copied command also includes host selection, changing directory, and the SSH hop when needed. Remote execution uses `zsh -lic` to load the owner's normal CLI environment. The button is withheld until the owning hostname, absolute working directory and valid session ID are known; Codex also requires a confirmed local endpoint. Paste into a real Mac terminal, not the phone's single-command terminal runner. Keep the app-server bound to localhost and use SSH to reach its owning Mac. See the [Codex app-server documentation](https://developers.openai.com/codex/app-server) for remote terminal support.

Run `npm run smoke:handoff` to check the real Codex CLI and both browser engines. It requires `codex` and `tmux` on PATH, creates an isolated test home and terminal, and uses a local fake model without account credentials or external inference requests.

The bridge is served over HTTP, so `navigator.clipboard` is unavailable in some browsers; it falls back to `execCommand`, and then to showing the command in a field you can select by hand.

A session opened from another workdir **runs in the directory it started in**. Otherwise the continuation would be filed under a different project and the original would look abandoned. Nothing is moved and nothing accumulates: bridges are keyed per session, each takes its directory once at construction, and the configured workdir is untouched — a new chat still starts there.

That includes folders **outside the home directory**, such as an external volume. `validateWorkdir`'s home rule exists to constrain what a phone may ask for over the network; a `cwd` read back out of a transcript is not that — it is where the local `claude` already ran. Falling back there is the real hazard: `git remote -v` then answers for a different repository than the row it was opened from. The workspace shown in the header follows the folder the turn will actually run in.

Each project shows its 6 newest rows (30 in date order); **もっと表示する (残りN件)** opens the rest, and **表示を減らす** puts it back. The expanded state is remembered per device.

### Keeping a project out of the list

Tooling writes sessions too — memory hooks, summarisers, anything whose opening message is a system prompt rather than something a person typed. Which folders those land in differs per machine, and the home folder in particular is real work for some people and only tooling for others, so the sidebar is told rather than left to guess: press **×** on a project heading to drop it from the list.

Hidden projects collect under **非表示のプロジェクト** at the bottom of the sidebar; tapping one puts it back. The choice lives on the bridge, in `.phone-workspaces.json` beside the workspace bookmarks, so it holds from any phone.

Hiding is about the sidebar, not about where work may run, so it accepts folders `validateWorkdir` would refuse — an external volume, or one that has since been deleted. The workdir the bridge is itself running in is never hidden: there would be no way back to it from a sidebar that no longer lists it.

The one exception is asking for a folder explicitly. The per-project "new chat" button sends the project it belongs to, and Claude honours it now; while the sidebar showed one workdir that button could only ever mean the folder the bridge was already in, so the request was dropped. A folder that is gone, or outside the home folder, falls back to the configured workdir rather than failing to open the chat.

The list is polled, so summaries are cached until a file changes underneath them, and each folder contributes its 20 newest sessions — raise or lower that with `PHONE_CLAUDE_SESSIONS_PER_PROJECT`.

## Picking Up Desktop Work on the Phone

A session is one file, and **the desktop app, the terminal `claude`, and this bridge all append to the same one**. Open it from the sidebar and the conversation so far is there to carry on from.

While it is open the bridge follows that file, so work continuing on the PC shows up on the phone:

- **the open session** — about a second (`PHONE_CLAUDE_WATCH_INTERVAL_MS`), and an append is pushed over the WebSocket rather than waiting for the next poll
- **the list** — polled every 10 seconds

The watch runs only while a phone actually has the session open, and stops when the last one closes. A turn of the bridge's own is left alone: the stream already on screen is the newer view, and everything written meanwhile arrives once that turn finishes.

::: warning The claude.ai phone app is not included
What can be picked up here is what lives **on that Mac's disk** — the desktop app and the terminal `claude`. Conversations in the claude.ai phone app or in a browser live server-side and are not files on the Mac, so they cannot be read this way.
:::

## Picking Up Phone Work on the Desktop

The bridge records its turns exactly where Claude Code expects them:

```text
~/.claude/projects/<slugged workdir>/<session-id>.jsonl
```

When those sessions seem to be missing, they usually are not — you are looking somewhere else. `claude --resume` only offers sessions belonging to **the directory it was started from**. Launched anywhere but the bridge's workdir, work done from the phone will not appear in the picker.

To see what exists and where:

```bash
npm run sessions                       # every workdir, grouped
npm run sessions -- --cwd /path/to/project
npm run sessions -- --json
```

It prints each session's id, title, and last activity per workdir, plus a resume command you can paste:

Sessions are filed per working directory, so changing the bridge's workdir sends new work elsewhere and earlier sessions drop out of anything scoped to one folder. They are not lost, just filed under the previous workdir — which is why the default here spans all of them.

```bash
cd /Users/you/Prj/example && claude --resume 2bec35bc-1324-4b49-8a83-d550e9a9ba07
```

If you want the interactive picker instead, run `claude --resume` **from the bridge's workdir** — that directory is what scopes the list.

### When the picker still does not show it

`claude -c` continues that directory's newest conversation **without going through the picker**, which separates the two things that look identical from the outside:

```bash
cd "$(the ■ path from npm run sessions)"
claude -c
```

- **It opens the phone conversation** — the session is reachable, so you were either in the wrong directory before, or the row was in the picker under a label you did not recognise. Sessions created before naming existed are labelled by their opening message, not by anything that says "phone".
- **It finds nothing** — you are not in the directory the session belongs to. Re-check the `■` line.

Either way `claude --resume <id>` works: the id is the one label that cannot be misread, and `npm run sessions` prints the whole command per row.

### Naming

A session created from the phone is named from its opening prompt, behind a marker showing where it came from:

```text
📱 レートリミットの表示を直して
```

That name is what the `/resume` picker, the prompt box, and the terminal title show, so a phone session is recognisable next to one you started yourself. It is set once, when the session is created — renaming it on the desktop sticks, and the phone sidebar picks up the new name too.

Set `PHONE_SESSION_NAME_PREFIX` to change the marker, or to an empty string to drop it. The naming is skipped entirely if the installed `claude` is too old to accept `--name`.

## Claude Rate Limits

Two sources feed the Claude rate-limit card, and they carry different things:

| Source | Provides | Setup |
| --- | --- | --- |
| `rate_limit_event` from the bridge's own turns | which window, when it resets, whether the account is on overage | none, automatic |
| Claude Code's statusLine payload | **the remaining percentage** | see below |

The live event carries no utilization field, so the bridge's own turns cannot produce a percentage. To get one, install the statusLine hook in the interactive Claude Code on that machine by adding this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/codex-remote-control-lab/scripts/capture-claude-rate-limits.js"
  }
}
```

Replace the path with your clone's absolute path. Each interactive `claude` session then refreshes `.phone-rate-limits.claude.json`, which the bridge reads.

statusLine is an interactive-UI feature and does not fire under `claude -p`, so percentages update when *you* use Claude in a terminal, not when the bridge runs a turn. The bridge marks a cache older than the TTL as stale.

Override the location with `PHONE_CLAUDE_RATE_LIMIT_CACHE_PATH`. Only normalized display values are cached — no tokens and no raw API responses.

## UI Surface

- recent thread list and thread resume
- phone control of the desktop Codex session
- PC/mobile continuity through a shared bridge-managed thread
- Bridge Fleet / Worktree Switchboard for multiple bridge/worktree slots in one tab
- global running monitor and approval inbox across registered bridges
- a 48px single-row session strip below the header, spanning both Codex and Claude on all registered Macs. Compact labels such as `Codex mini①` identify provider, machine and a stable conversation number. A short blue border segment orbits stationary text while executing; overlaid corner marks show green `✓` for unread completion, amber `?` for questions/permission requests, red `!` for errors, grey `!` for unverified connectivity/state, and grey `−` for interruption. The count includes executing conversations only. Scroll horizontally for more, tap a session to open it on its own Mac/provider, or tap the count for full titles and explicit state labels. Completion stays until the conversation is successfully opened/acknowledged; opening questions, approvals or errors does not clear them. The row hides when only acknowledged completions or ordinary idle sessions remain. Unread state is retained in this browser; a lost connection is never advertised as confirmed progress. Reduced-motion preferences stop the orbit and retain a static blue partial border
- thread status badges and `要対応 / 実行中 / 最近` inbox filters
- Reply-waiting is not inferred from a `?` or a routine inspection instruction anywhere in an answer. Held input/permission requests take priority. For ordinary replies, a conservative text fallback checks the closing prose or question list for a direct question or explicit reply request, excluding code, quotations, tables, examples and glossary sections. A completed report explaining the status symbols is therefore completion, not a question. Codex and Claude use the same classification on completion and history restoration, without borrowing an earlier turn's question. This is a bounded text rule, not another AI call, and does not promise to recognize every ambiguous phrasing
- Review Center tabs for Summary, Diff, Tests, Terminal, Artifacts, and Actions
- connection health panel for bridge, app-server, WebSocket, history sync, token age, notification providers, host, and LAN URL
- PWA app shell caching that excludes `/api/*`, WebSocket, tokenized URLs, uploads, and raw file responses
- cockpit header with thread position, run state, per-thread accent color, compact cwd, and a mini thread switcher
- guarded swipe navigation that avoids text inputs, terminal logs, artifact previews, approval cards, and horizontal scrollers; a swipe in from the left screen edge opens the sidebar instead of changing chats
- Codex / Terminal view switching with unread badges and preserved drafts/scroll position
- phone terminal mode reserved for manual command input/output, with the chat composer and chat status logs kept out of the terminal surface and a `user@host cwd %` prompt shown for the active workspace
- terminal filter chips, client-side search, visible-output copy, auto-scroll pause, wrap/font controls, key-intent chips, and CSS focus mode
- approval cards that stay visible from both chat and terminal views
- quick action chips that insert prompt templates without auto-sending
- model, plugin, config, auth, and automation lookups
- Codex and Claude show the model and effective reasoning depth using readable Japanese labels; available depths follow the connected bridge's model capabilities. Fast mode remains a one-row toggle with a `⚡` suffix
- The user's requested reasoning depth stays in this page's browser storage. Startup, reconnects, and thread/model switches never persist a capability fallback over it. An unsupported model adjusts only the displayed and submitted depth; returning to a capable model restores the requested depth. Capabilities are kept separately per bridge, and partial responses do not erase known model levels. A preference already overwritten by an older version cannot be reconstructed; select it once again after updating
- approval and sandbox mode controls for the next turn
- repository artifact preview
- Markdown rendering for chat and artifacts
- browser image attachments passed to Codex as `localImage` inputs
- simple, cyberpunk, and botanical color themes from the settings panel
- LAN sharing for a single bridge-managed thread

The terminal key row does not expose unauthenticated raw shell execution. `$` inserts a safe Codex command-request template, and bridge access remains token protected while the Codex app-server stays bound to localhost.

## PWA Notes

The normal public `site.webmanifest` is token-free and uses `display: standalone`. A valid protected `/install?token=...` page links to a no-store install manifest whose `start_url` carries the credential in a URL fragment. If Safari already holds the credential from an earlier protected visit, opening the short `/install` URL automatically reloads that protected install page before it is added to the Home Screen. This is necessary because Safari and the installed Home Screen web app have separate storage. On first launch, the app saves the credential in its own local storage and immediately removes the fragment; fragments are never sent to the bridge. Invalid or tokenless install-manifest requests cannot receive a credential-bearing `start_url`. Adding `provider=codex` (or `provider=claude`) to that URL makes the install page, its icon and its manifest use that provider's picture and name, such as `Codex mini`, and keeps the provider in `start_url`, so the icon opens in that provider even on a bridge whose default is the other one.

On secure contexts and localhost, the phone UI registers `service-worker.js` and caches only the app shell. Public manifests, API responses, WebSocket traffic, tokenized URLs and install manifests, uploaded files, raw file routes, terminal history, and approval payloads are not cached. On plain LAN HTTP, browser rules may block Service Worker registration; the normal browser UI still works.

After adding the bridge to the Home Screen, treat the stored token as private local device state. If the token is missing or rotated, enter the local `.phone-token` / `PHONE_TOKEN` value in the Home Screen app's recovery form. Alternatively, remove that Home Screen app and add it again from the current protected `/install?token=...` URL; merely opening the URL in Safari does not copy Safari storage into an already installed app.

Deleting the Home Screen app also deletes its list of bridges, so each bridge keeps a copy of the list that was last synced to it. Once the reinstalled app has a valid token, it reads that copy back from the bridge it was installed from and the other machines reappear without being registered by hand. The copy is only as current as the last sync: register the bridges once after deploying this, and every later addition or removal backs itself up. Removals are recorded rather than merely omitted, so a phone that was closed when a bridge was deleted drops it on its next sync instead of pushing it back; a bridge registered again after being deleted stays. Those records are kept for 90 days, and at most 256 of them, so a phone offline for longer than that can still carry a deleted bridge back — register it again or delete it there too. Nothing is ever pushed before a restore has succeeded, so a fresh install cannot overwrite the backup it is about to recover from — which also means a bridge whose backup cannot be read stops syncing rather than replacing it. See [Security Model](./security.md) for where the file lives and how its tokens are protected.
