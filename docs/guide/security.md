# Security Model

This project is intentionally local-first.

## Public-Safe Defaults

- The Codex app-server examples bind to `127.0.0.1`.
- The phone bridge is the only LAN-facing server.
- Page, API, and WebSocket bridge requests require the same token.
- `.phone-token`, `.uploads/`, `.codex-home*/`, logs, and session databases stay out of Git.
- Startup notification credentials and tokenized URL messages should stay in private/protected notification accounts, topics, or channels.

## Do Not Do This

Do not bind an unauthenticated Codex app-server directly to a LAN or public interface.

For remote access outside a trusted local network, prefer:

- SSH port forwarding
- a VPN
- a mesh network with device-level authentication

## Handing the URL to a Phone Off-LAN

Once a mesh VPN or VPN reaches this machine, the bridge already advertises that interface: it binds `0.0.0.0` in token mode and lists every non-internal IPv4 address, so a Tailscale `100.64.0.0/10` address appears alongside the LAN one. Nothing in the bridge needs changing.

`npm run url:remote` assembles that URL and hands it over without putting the token on screen:

```bash
npm run url:remote            # prefers the mesh address, token masked
npm run url:remote -- --qr    # scan it from the phone (needs qrencode)
npm run url:remote -- --copy  # straight to the clipboard, nothing printed
```

It reads `PHONE_TOKEN` or `.phone-token`, picks up the MagicDNS name when `tailscale` is on PATH, and masks the token unless you pass `--reveal`. Prefer `--qr` or `--copy`: a masked URL is safe to leave on screen, a revealed one is a live access key.

Do not paste a tokenized URL into chat, issues, or screenshots to move it between devices. Use the clipboard, a QR scan, or the private notification channels in [Phone Bridge](/guide/phone-bridge).

## Token Handling

The bridge creates `.phone-token` with mode `0600` when `PHONE_TOKEN` is not provided. Delete `.phone-token` to rotate the generated token.

`PHONE_DEBUG_NO_TOKEN=1` is the tokenless debugging switch. By itself, it binds the bridge to `127.0.0.1` and does not create or require a token.

`PHONE_DEBUG_BIND=lan` is the explicit tokenless LAN debug bind. Use it only together with `PHONE_DEBUG_NO_TOKEN=1` on a trusted private network you control, and never through public tunnels or raw port forwards.

## Beginner Runtime Notes

- Treat the printed `?token=...` URL like a local access key. Anyone who can open it can drive the bridge for that running session.
- Do not paste tokenized URLs into public issues, shared chats, screenshots, or streams.
- Do not expose the no-token debug URL outside the host machine.
- Stop the bridge with `Ctrl+C` in the terminal that is running `npm run phone`.
- Closing the terminal or restarting the PC stops the bridge. Run `npm run phone` again when you want to use it.
- Run the bridge from a normal user account, not a root/admin shell.
- Do not expose the bridge with an unauthenticated public tunnel or raw port forward. Put trusted access, such as SSH forwarding, a VPN, or a device-authenticated mesh network, in front of it.
