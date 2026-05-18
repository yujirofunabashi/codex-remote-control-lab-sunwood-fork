# 2026-05-18 Mobile Context Mismatch Memo

Status: first fix implemented on `feature/mobile-context-mismatch`.

## Context

The issue was observed from iPhone Safari in the Codex Remote Control Lab
mobile UI at around 2026-05-18 20:39 JST. The screenshots show the active
bridge UI for `codex-remote-control-lab` on `develop`, while the assistant's
command output in the conversation reports the actual working repository as:

```text
/Users/minijiro/WORK_LOCAL/00_WORKSPACE/開発/personal/trading-lab
```

This memo intentionally does not record the full browser URL, token, or private
network address.

## Current Problem

The mobile UI can make the operator believe the current work repository is
`codex-remote-control-lab`, even when the active Codex turn is executing
commands in another repository.

Observed mismatch:

- Header / drawer show `codex-remote-control-lab`, `develop`, and clean state.
- The selected chat content says the current work repo is `trading-lab`.
- The UI does not clearly distinguish bridge/app repository, bridge worktree,
  active thread repository, terminal current directory, and the cwd used by the
  latest assistant tool execution.

This is a safety and operability issue because repo identity is used to decide
where edits, commits, PRs, and merges should happen.

## UI Symptoms

- The workspace pill and drawer grouping look authoritative, but their source
  is ambiguous.
- Recent chat entries are grouped under `codex-remote-control-lab` even when
  the chat is discussing or confirming a different repository.
- The mobile header is crowded: thread title, Codex/Terminal switch, previous /
  next buttons, repository pill, branch, dirty state, and status compete for
  limited width.
- Important context is truncated, while lower-priority labels remain visible.
- There is no mismatch warning when the visible bridge repository differs from
  the last confirmed execution cwd.

## Expected Behavior

The UI should make repository context explicit and source-aware:

- Show `Bridge repo` separately from `Agent cwd` or `Thread cwd`.
- Expose the full path of the last confirmed execution cwd from the current
  thread.
- Show a warning when the visible bridge/worktree repo differs from the last
  confirmed execution cwd.
- In the thread drawer, display each thread's last known cwd/repo when known,
  instead of relying only on the currently selected bridge profile.
- Include a timestamp or freshness marker for cwd/repo metadata so stale context
  is distinguishable from current context.

## Suggested First Fix Scope

Keep the first fix narrow:

- Add a context model that separates:
  - bridge profile metadata
  - bridge workdir/repo metadata
  - active thread metadata
  - terminal cwd
  - last assistant/tool execution cwd when available
- Render labels in the header/drawer using those source names.
- Add a compact mobile warning state for repo mismatch.
- Prefer full path disclosure behind tap/expand or debug UI, not always in the
  crowded header.

Likely areas to inspect first:

- `public/main.js`
- `public/style.css`
- `scripts/bridge-state.js`
- `GET /api/bridge/info`
- any thread list / selected thread metadata mapping

## Implementation Notes

Implemented first patch:

- Preserve remote thread `cwd` / repo metadata when a live bridge reconnect only
  has stale bridge-local metadata.
- Preserve remote thread `cwd` / repo metadata as canonical even when a newer
  live bridge record reports a different execution cwd. Keep that live cwd as
  `lastExecutionCwd` so the UI can warn without moving the thread to the wrong
  repo group.
- Prefer selected thread `cwd` for resumed thread requests once the thread
  metadata is known.
- When a bookmarked / restored URL opens a thread from another repo, clear the
  initial pending state as soon as the thread list provides its `cwd`, refresh
  saved bridge metadata if needed, and switch to the matching bridge before the
  WebSocket connects.
- Keep bridge/fleet labels bridge-scoped, while the workspace context can show
  the selected thread's `Agent cwd`.
- When a selected thread's `cwd` matches a registered bridge workdir,
  automatically switch to that bridge before opening the thread.
- Add a compact expandable mismatch warning when `Agent cwd` and `Bridge repo`
  differ and no matching bridge switch has resolved the mismatch.
- Show each thread's known `cwd` in the drawer.

Verification:

- `node --check public/main.js && node --check public/phone-ui-utils.js && node --check scripts/start-phone.js && node --check scripts/mobile-smoke.js`
- `node --test scripts/thread-list.test.js scripts/bridge-state.test.js scripts/phone-ui-utils.test.js`
- `node scripts/mobile-smoke.js --shots`
- `npm run check`
- `npm test`
- `npm run docs:build`

Follow-up hardening in the same branch:

- Add an explicit UI state for whether the active workspace follows the selected
  thread `cwd` or the manually selected bridge. Manual bridge switches now stop
  old thread metadata from driving the next WebSocket `workdir`.
- Render the mismatch warning from the active execution workspace first, not
  from the selected thread's historical `cwd`.
- Scope server-side live bridge reuse by `threadId + workdir`, not just
  `threadId`, so a live bridge opened for the same thread in an old cwd cannot
  satisfy a later cross-repo thread navigation request.
- Filter live bridge history reads by the requested `workdir` before falling
  back to app-server thread reads/resumes.
- Prioritize selected run / active execution workspace over the bridge process
  cwd for the mobile header pill, workspace labels, and mismatch warning. A
  cross-repo thread can legitimately run through the same phone bridge process;
  that should show the thread repo as the active work repo, not warn just
  because the bridge process was launched from `codex-remote-control-lab`.
- `node --test scripts/thread-list.test.js scripts/bridge-state.test.js scripts/thread-read.test.js scripts/phone-ui-utils.test.js`
- `node scripts/mobile-smoke.js` includes both cross-repo existing-thread
  navigation with and without a registered matching bridge.
- `npm run check`
- `npm test`
- `npm run docs:build`

## Acceptance Criteria

- On an iPhone-width viewport, if the bridge repo is `codex-remote-control-lab`
  but the current thread's last confirmed cwd is `trading-lab`, the UI shows a
  clear mismatch warning.
- The drawer and header no longer imply that bridge repo equals execution repo.
- The full execution path is accessible without requiring the user to ask the
  assistant to run `pwd`.
- Existing token masking and localhost-first security boundaries are unchanged.
- New tests or screenshot evidence cover the mismatch state and the normal
  matching state.

## Non-goals

- Do not change Codex app-server binding or expose new unauthenticated control
  surfaces.
- Do not record tokens, private URLs, session databases, or generated Codex home
  data in docs or fixtures.
- Do not solve unrelated visual polish in the same first patch unless it is
  required for the mismatch warning to be readable.
