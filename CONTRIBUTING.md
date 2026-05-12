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

## Pull Requests

- Keep changes public-safe.
- Do not commit `.codex-home*`, `.phone-token`, `.phone-workspaces.json`, `.uploads/`, logs, or generated session databases.
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
