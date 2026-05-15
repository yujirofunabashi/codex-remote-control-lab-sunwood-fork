# Official Codex Mobile Comparison

This repository is not an official mobile client replacement. It is a local-first LAN bridge experiment for Codex CLI remote-control and app-server workflows.

## Purpose

Codex Remote Control Lab keeps the Codex app-server on `localhost` or `127.0.0.1` and exposes only a small token-protected phone bridge to trusted browsers. It is useful for CLI/headless workflows, local worktrees, LAN/VPN/mesh access, and a browser/PWA interface that can monitor, approve, review, and redirect running work.

## Key Differences

| Area | Official Codex mobile style | This repository |
| --- | --- | --- |
| Trust model | Account-managed connection and managed relay behavior | Self-hosted local bridge, protected by a local access token |
| Network boundary | Managed service path | LAN, SSH forwarding, VPN, or mesh network |
| App-server exposure | Not user-managed | Codex app-server must stay on `localhost`; only the bridge is LAN-facing |
| Mobile UI | Official mobile app experience | Browser/PWA work inbox for thread status, approvals, review center, health, and notifications |
| Device authorization | Account/device managed | Local token handling is the operator's responsibility |

## When To Use Each

Use the official experience when you want account-managed setup, managed security boundaries, and product-supported mobile behavior.

Use this repository when you are experimenting with local Codex CLI/app-server flows, need a phone UI for a headless worktree, want LAN/VPN/mesh access, or need reusable local-first bridge code.

## Safe Use

- Keep the Codex app-server bound to `localhost` or `127.0.0.1`.
- Expose only the token-protected phone bridge.
- Treat any full `?token=...` startup URL as a local access key.
- Do not use unauthenticated public tunnels or raw port forwards.
- Prefer SSH forwarding, a VPN, or a device-authenticated mesh network outside a trusted LAN.
- Do not commit `.phone-token`, uploads, session databases, logs, private screenshots, webhook URLs, or local config.

## Implemented Surface

- thread resume
- approvals
- review center for summary, diff, tests, terminal, artifacts, and actions
- event notifications through configured private ntfy, Pushover, or Discord targets
- health panel
- PWA app shell with token/API responses excluded from cache

## Known Limits

This is not a secure relay, not account-managed device authorization, and not a substitute for the official product security boundary. It depends on the trust boundary of your LAN, VPN, SSH forwarding, or mesh network. Token storage and rotation remain the operator's responsibility.
