#!/usr/bin/env node
// Assembles the bridge URL for a device that reaches this machine over a mesh
// VPN (Tailscale and friends) rather than the local LAN, and hands it over
// without putting the token on screen.
//
//   node scripts/remote-url.js              # list reachable addresses, token masked
//   node scripts/remote-url.js --copy       # full URL to the clipboard, nothing printed
//   node scripts/remote-url.js --qr         # scan it from the phone
//   node scripts/remote-url.js --host mac.tailnet.ts.net --qr
//
// The token is only ever written to the clipboard or the QR image. Plain output
// stays masked so a screenshot or a shared terminal does not leak access.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { copy: false, qr: false, reveal: false, host: "", port: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--copy") args.copy = true;
    else if (arg === "--qr") args.qr = true;
    else if (arg === "--reveal") args.reveal = true;
    else if (arg === "--host") args.host = argv[++i] || "";
    else if (arg === "--port") args.port = Number(argv[++i] || 0);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function readToken() {
  if (process.env.PHONE_TOKEN) return process.env.PHONE_TOKEN;
  const tokenPath = path.join(root, ".phone-token");
  if (!fs.existsSync(tokenPath)) return "";
  return fs.readFileSync(tokenPath, "utf8").trim();
}

// Tailscale hands out addresses from the 100.64.0.0/10 CGNAT block. Matching the
// block rather than a bare `100.` keeps ordinary 100.x LAN addresses out.
function isMeshAddress(address) {
  const parts = address.split(".").map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function candidateAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && (entry.family === "IPv4" || entry.family === 4) && !entry.internal)
    .map((entry) => ({ address: entry.address, mesh: isMeshAddress(entry.address) }))
    .sort((a, b) => Number(b.mesh) - Number(a.mesh));
}

function magicDnsName() {
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return "";
  try {
    const status = JSON.parse(result.stdout);
    const name = status.Self?.DNSName || "";
    return name.replace(/\.$/, "");
  } catch {
    return "";
  }
}

function buildUrl(host, port, token) {
  const url = new URL(`http://${host}:${port}/`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function maskUrl(url) {
  return url.replace(/(token=)([^&]+)/, (_, prefix, token) => {
    if (token.length <= 8) return `${prefix}${"*".repeat(token.length)}`;
    return `${prefix}${token.slice(0, 3)}${"*".repeat(token.length - 6)}${token.slice(-3)}`;
  });
}

function copyToClipboard(text) {
  const commands = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { input: text });
    if (!result.error && result.status === 0) return command;
  }
  return "";
}

function showQr(text) {
  const result = spawnSync("qrencode", ["-t", "ANSIUTF8", "-m", "1", text], { stdio: ["pipe", "inherit", "pipe"] });
  if (result.error || result.status !== 0) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/remote-url.js [--host <name>] [--port <n>] [--copy] [--qr] [--reveal]");
    return;
  }

  loadEnvFile(path.join(root, ".env"));

  const token = readToken();
  if (!token) {
    console.error("No token found. Start the bridge once (npm run phone) so .phone-token is created,");
    console.error("or set PHONE_TOKEN in your environment or .env.");
    process.exitCode = 1;
    return;
  }

  const port = args.port || Number(process.env.PHONE_UI_PORT || 45214);
  const addresses = candidateAddresses();
  const magicDns = args.host || magicDnsName();
  const host = magicDns || addresses.find((entry) => entry.mesh)?.address || addresses[0]?.address || "";

  if (!host) {
    console.error("No reachable address found. Is Tailscale (or your VPN) connected?");
    process.exitCode = 1;
    return;
  }

  const url = buildUrl(host, port, token);

  if (args.copy) {
    const via = copyToClipboard(url);
    if (!via) {
      console.error("Could not reach a clipboard tool (pbcopy, wl-copy, xclip).");
      process.exitCode = 1;
      return;
    }
    console.log(`Copied to clipboard via ${via}. Nothing was printed.`);
    console.log(`Host: ${host}:${port}`);
    return;
  }

  if (args.qr) {
    if (!showQr(url)) {
      console.error("qrencode is not installed. Install it (brew install qrencode) or use --copy.");
      process.exitCode = 1;
      return;
    }
    console.log(`Scan from the phone with the VPN connected. Host: ${host}:${port}`);
    return;
  }

  console.log(args.reveal ? url : maskUrl(url));
  console.log("");
  console.log(`Host in use : ${host}:${port}${magicDns ? "  (MagicDNS)" : ""}`);
  if (addresses.length) {
    console.log("Interfaces  :");
    for (const entry of addresses) {
      console.log(`  ${entry.address}${entry.mesh ? "  <- mesh VPN" : "  (LAN only)"}`);
    }
  }
  console.log("");
  console.log("The token is masked above. Use --qr to scan it, --copy for the clipboard,");
  console.log("or --reveal if you really want it on screen.");
}

if (require.main === module) main();

module.exports = { buildUrl, candidateAddresses, isMeshAddress, maskUrl };
