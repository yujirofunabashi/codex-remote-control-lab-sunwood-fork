// A management-side summary of verified results. Never a Windows heartbeat.
const fs = require("node:fs");
const path = require("node:path");
const { redactSensitiveText } = require("./debug-log");

function readLabProgress(filename) {
  const unavailable = { available: false };
  if (!filename) return unavailable;
  let fd;
  try {
    if (!path.isAbsolute(filename)) return unavailable;
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 24000 || (stat.mode & 0o077)) return unavailable;
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (data.schema !== 1 || !["completed", "revision_limit", "total_time_limit", "waiting_usage_observation", "waiting_subscription_capacity"].includes(data.status)
      || !Number.isSafeInteger(data.verifiedAt) || data.verifiedAt < 946684800000 || data.verifiedAt > Date.now() + 300000
      || !Number.isSafeInteger(data.aiInvocations) || data.aiInvocations < 0 || data.aiInvocations > 100
      || !/^[a-f0-9]{64}$/.test(data.sourceSha256 || "")) return unavailable;
    const result = { available: true, schema: 1, status: data.status, verifiedAt: data.verifiedAt,
      aiInvocations: data.aiInvocations, sourceSha256: data.sourceSha256 };
    for (const key of ["project", "department", "result", "stopReason", "nextAction", "ownerAction"]) {
      if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > 1500) return unavailable;
      result[key] = redactSensitiveText(data[key]);
    }
    return result;
  } catch { return unavailable; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { readLabProgress };
