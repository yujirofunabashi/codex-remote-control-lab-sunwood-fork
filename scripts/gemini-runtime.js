// No credential bodies are read or printed. Migrate only the old CLI's public
// authentication-method setting, retaining the original settings as a backup.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function inspectGemini({ home = os.homedir(), migrate = false } = {}) {
  const directory = path.join(home, ".gemini");
  const file = path.join(directory, "settings.json");
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
  const settings = JSON.parse(original);
  let migrated = false;
  if (migrate && settings.selectedAuthType === "oauth-personal" && !settings.security?.auth?.selectedType) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
    settings.security = { ...settings.security, auth: { ...settings.security?.auth, selectedType: "oauth-personal" } };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    migrated = true;
  }
  return { cachedGoogleLogin: fs.existsSync(path.join(directory, "oauth_creds.json")), authType: settings.security?.auth?.selectedType || null, legacyAuthType: settings.selectedAuthType || null, migrated };
}
if (require.main === module) {
  const result = inspectGemini({ migrate: process.argv.includes("--migrate-auth") });
  try { result.version = execFileSync(process.env.GEMINI_BIN || "gemini", ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { result.version = null; }
  console.log(JSON.stringify(result));
}
module.exports = { inspectGemini };
