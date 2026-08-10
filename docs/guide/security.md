# Security Model

This project is intentionally local-first.

## Public-Safe Defaults

- The Codex app-server examples bind to `127.0.0.1`.
- The phone bridge is the only LAN-facing server.
- Page, API, and WebSocket bridge requests require the same token.
- `.phone-token`, `.uploads/`, `.codex-home*/`, logs, and session databases stay out of Git.
- `.phone-fleet.local.json`, `.phone-bridges.local.json`, `.phone-bridges.<port>.local.json`, `.phone-registry-key`, and browser bridge registry state are local-only.
- Startup notification credentials and tokenized URL messages should stay in private/protected notification accounts, topics, or channels.

## Do Not Do This

Do not bind an unauthenticated Codex app-server directly to a LAN or public interface.

For remote access outside a trusted local network, prefer:

- SSH port forwarding
- a VPN
- a mesh network with device-level authentication

## Token Handling

The bridge creates `.phone-token` with mode `0600` when `PHONE_TOKEN` is not provided. Delete `.phone-token` to rotate the generated token.

Each bridge also keeps the phone's list of connections in `.phone-bridges.<port>.local.json` so a reinstalled Home Screen app can recover it. This widens what one token is worth: an authenticated request to a bridge can read the backed-up tokens for every other bridge the phone had registered, because that is what recovery needs. A leaked `?token=...` URL for one Mac therefore reaches the whole fleet, not just that Mac. Treat each bridge token accordingly, and keep tokenized URLs out of startup notifications you would not trust with all of them. The bridge tokens inside that file are encrypted with AES-256-GCM under `.phone-registry-key`, which is generated beside it with mode `0600`; the rest of the file, such as base URLs, labels, and the dated record of which bridges were removed, stays readable. Tokens the phone was told not to remember are never sent to the backup, and a removed bridge's token is dropped with it. The encryption keeps tokens out of a stray copy of the JSON — a backup sweep, a pasted file — and is not a defence against someone who already has the account. Delete both files together to discard the backup; deleting only the key leaves a registry that fails closed and stops syncing until it is removed.

## Beginner Runtime Notes

- Treat the printed `?token=...` URL like a local access key. Anyone who can open it can drive the bridge for that running session.
- Do not paste tokenized URLs into public issues, shared chats, screenshots, or streams.
- Stop the bridge with `Ctrl+C` in the terminal that is running `npm run phone`.
- Closing the terminal or restarting the PC stops the bridge. Run `npm run phone` again when you want to use it.
- Run the bridge from a normal user account, not a root/admin shell.
- Do not expose the bridge with an unauthenticated public tunnel or raw port forward. Put trusted access, such as SSH forwarding, a VPN, or a device-authenticated mesh network, in front of it.
- Do not turn the fleet UI into an open proxy. Cross-bridge reads and approval actions must stay token protected and scoped to registered/private bridge URLs.
