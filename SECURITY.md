# Security Policy

## Supported Scope

This repository is an experimental local lab. The supported security posture is:

- keep the Codex app-server bound to `127.0.0.1`
- expose only the token-protected phone bridge to the LAN
- treat `.phone-token`, `.uploads/`, `.codex-home*/`, and generated session databases as local-only state
- treat `.phone-fleet.local.json`, `.phone-bridges.local.json`, `.phone-bridges.<port>.local.json`, `.phone-registry-key`, and browser bridge registry state as local-only state
- treat startup notification credentials and tokenized URL messages as private local state; event notifications must use token-free URLs

## Reporting

If you find a security issue, open a private advisory or contact the repository owner before publishing details.

## Public-Safe Checklist

- Do not commit local tokens, generated Codex homes, session databases, logs, uploads, private screenshots, or the `.phone-registry-key` that protects backed-up bridge tokens.
- Do not bind `codex app-server` directly to a LAN or public interface without a separate authenticated private network.
- Treat any full `?token=...` startup URL as a private local access key for the whole fleet, not just that machine: a bridge serves the registry backup, so an authenticated request can read the backed-up tokens of every other bridge the phone had registered. Do not publish it in issues, chats, screenshots, or streams.
- Stop the bridge with `Ctrl+C`; closing the terminal or restarting the PC stops the process.
- Do not expose the bridge through an unauthenticated public tunnel or raw port forward.
- Do not add a server-side fleet proxy that can fetch arbitrary URLs; only token-protected registered/private bridge URLs are acceptable.
- Run the bridge from a normal user account, not a root/admin shell.
- Send startup notifications only to private/protected notification accounts, topics, or channels.
- Keep `PHONE_NOTIFY_EVENTS=1` event notifications token-free and deduped; do not include raw bridge tokens in event titles or bodies.
- Rotate `PHONE_TOKEN` or delete `.phone-token` after demos on shared networks.
- Prefer SSH forwarding, a VPN, or a mesh network for access outside the local LAN.
