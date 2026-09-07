# Contributing

Thanks for helping make this lab easier to reuse.

## Source of Truth

- Repository workflow rules live in `AGENTS.md`.
- Public contributor rules live here and in `docs/guide/contributing.md`.
- When behavior, workflow, or the public-safe checklist changes, update the matching README/docs page in the same change.

## Development

```bash
npm ci
npm run check
npm run docs:build
```

For manual bridge testing:

```bash
npm run phone
```

Open the printed URL from a device on the same LAN. Keep the Codex app-server on `127.0.0.1`; only the token-protected bridge should listen on the LAN.

When working from more than one machine, start a dedicated `feature/*` branch/worktree from `develop`, test the change, then integrate and push `develop`. Do not leave the only copy of a fix as an uncommitted edit on a running bridge. CI checks pushes to both `develop` and `main`.

On the receiving application's clean `develop` checkout, run `npm run bridge:check` to fetch and compare without updating files, then `npm run bridge:pull` to accept a fast-forward update. The commands refuse unfinished edits, unpublished or diverging commits, an unexpected tracking branch, and interrupted Git operations. They never commit, push, stash, reset or switch branches for you. Resolve refusals on a feature branch after reviewing both machines' changes. Keep credentials, registry backups and conversation histories machine-local.

Verify the app version shown separately from the chat workspace in the connection cards. Matching commit IDs alone are insufficient: compare actual build fingerprints, unshared state and restart warnings on both bridges, then verify the served screen. After dependency changes run `npm ci`; restart the affected supervised bridge only with approval and after active work is saved. See the [phone bridge update guide](docs/guide/phone-bridge.md#updating-across-machines). Changes to this path must pass `npm run check:sync` and `npm run smoke:fleet`.

## Pull Requests

- Keep changes public-safe.
- Do not commit `.codex-home*`, `.phone-token`, `.phone-bridges.*.local.json` or its backups, `.uploads/`, logs, or generated session databases.
- Include a focused verification command in the PR notes.
- Update `README.md`, `README.ja.md`, or `docs/` when behavior changes.

## Upstream Pull Requests

This repository may be used as a fork of an upstream project. You can open a PR back to the upstream repository when the change is general, public-safe, and small enough to review independently.

Recommended flow:

1. Check remotes with `git remote -v` and identify the fork remote and upstream remote.
2. Fetch upstream and create a branch from the upstream target branch.
3. Port only the reusable commits or hunks. Avoid private workflow glue, local launch settings, tokens, generated session data, and machine-specific paths.
4. Run the focused verification command that matches the change.
5. Push the branch to the fork and open a PR against the upstream repository.

If the local fork has diverged heavily, split the upstream PR into small pieces or open an upstream issue first to confirm maintainers want the direction.
