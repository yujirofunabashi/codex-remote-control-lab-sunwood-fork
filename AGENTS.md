# Repository Instructions

- Keep this repository public-safe: do not commit local tokens, credentials, `.codex-home*`, or generated session databases.
- Operate this repository with Git Flow. Use `main` as the production branch and `develop` as the integration branch.
- If `develop` does not exist yet, create it from `main`, push it to `origin`, and use it for normal development work.
- Start normal work from `develop` on `feature/<short-description>` branches, then merge completed features back into `develop`.
- Use `release/<version>` branches from `develop` for release stabilization, merge finished releases to `main`, tag them as `v<version>`, and merge the release result back to `develop`.
- Use `hotfix/<version>` branches from `main` for urgent production fixes, then merge the fix back to both `main` and `develop`.
- For normal documentation and code changes, commit to `develop` or finish a `feature/*` branch into `develop`, then push `develop` to `origin`.
- Push to `main` only when finishing a `release/*` or `hotfix/*` flow.
- Treat `CONTRIBUTING.md` and `docs/guide/contributing.md` as the public contribution SOT. Update them when the repository workflow, upstream PR policy, or public-safe checklist changes.
- For PRs back to the original upstream repository, create a small public-safe branch from the upstream base, port only the reusable change, verify it, then open the PR from this fork. Keep private workflow glue, local tokens, generated session data, and user-specific setup out of upstream PRs.
- After each meaningful change, run a focused verification command before committing and pushing the relevant Git Flow branch.
- When a bridge problem needs more than a couple of exchanges to pin down, turn on the debug log instead of adding throwaway prints: `PHONE_DEBUG=1 npm run phone` writes one JSON object per line to `.phone-debug.log`. Use `PHONE_DEBUG_FILE` to move it and `PHONE_DEBUG_MAX_BYTES` to change the size cap; the log rolls one generation to `<file>.1`.
- Read that file directly rather than asking the operator to copy terminal output. `claude.stream.line` records which branch of the Claude stream handled each message and marks the ones nothing claimed, `claude.turn` closes each turn with its line and delta counts and whether an answer was appended to history, and the `claude.approval.*` entries separate an approval that was never broadcast from one the phone never drew.
- Add new instrumentation with `debugLog` and `debugTimer` from `scripts/debug-log.js`, not with `console.log`. That module owns `redactSensitiveText` for the whole bridge, so anything logged is masked and capped; keep it that way and keep the debug log out of commits.
- Prefer small commits that describe the working increment, such as adding the phone bridge, updating docs, or fixing protocol handling.
- Keep the Codex app-server bound to localhost in examples; expose only the token-protected bridge on the LAN.
