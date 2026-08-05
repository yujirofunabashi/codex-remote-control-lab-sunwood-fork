#!/usr/bin/env node
// Lists the Claude sessions the phone bridge has produced, with a ready-to-run
// resume command for each.
//
// The bridge records turns exactly where Claude Code expects — under
// ~/.claude/projects/<slug>/<session-id>.jsonl — but `claude --resume` only
// offers sessions belonging to the directory it was launched from. Started from
// anywhere else, work done from the phone looks like it vanished. This prints
// where each session actually lives so it can be picked up on the desktop.
//
// Sessions are filed per working directory, so changing the bridge's workdir
// moves new work elsewhere and the old work stops showing up anywhere scoped to
// one folder. The default here is therefore every workdir, grouped.
//
//   npm run sessions                          # every workdir
//   npm run sessions -- --cwd /path/to/project
//   npm run sessions -- --json
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { cwd: "", json: false, limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--cwd") args.cwd = argv[++i] || "";
    else if (arg === "--limit") args.limit = Number(argv[++i] || 20) || 20;
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

// Mirrors claudeProjectDirFor() in start-phone.js; the slug is how Claude Code
// maps a working directory onto its transcript folder.
function projectDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : ""))
    .join(" ")
    .trim();
}

function summarize(filePath) {
  let text;
  let stat;
  try {
    stat = fs.statSync(filePath);
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const session = {
    id: path.basename(filePath, ".jsonl"),
    title: "",
    customTitle: "",
    firstPrompt: "",
    lastPrompt: "",
    cwd: "",
    messages: 0,
    updatedAt: stat.mtimeMs,
    file: filePath,
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.cwd) session.cwd = item.cwd;
    if (item.type === "ai-title" && item.aiTitle) session.title = String(item.aiTitle);
    // `claude --name` and a desktop rename both write this, and it is what the
    // /resume picker shows. Deliberate, so it outranks the generated title.
    if (item.type === "custom-title" && item.customTitle) session.customTitle = String(item.customTitle);
    const timestamp = Date.parse(item.timestamp || "");
    if (Number.isFinite(timestamp)) session.updatedAt = Math.max(session.updatedAt, timestamp);
    if (item.type !== "user" && item.type !== "assistant") continue;
    const content = textFromContent(item.message?.content);
    if (!content) continue;
    session.messages += 1;
    if ((item.message?.role || item.type) !== "user") continue;
    if (!session.firstPrompt) session.firstPrompt = content;
    // The phone sidebar labels a row by its latest message while this labelled
    // it by the first, so the same session read as two different ones. Carry
    // both and the rows can be matched from either side.
    session.lastPrompt = content;
  }

  return session;
}

function listSessions(cwd, limit = 20) {
  const dir = projectDirFor(cwd);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, sessions: [] };
  }
  const sessions = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => summarize(path.join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return { dir, sessions };
}

// Sessions are filed per working directory, so changing the workdir moves new
// work to a different folder and the old work stops showing anywhere that looks
// at only one. Scanning every project directory is what makes "where did my
// sessions go" answerable without knowing the answer first.
function listAllSessions(limit = 20) {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let dirNames = [];
  try {
    dirNames = fs.readdirSync(projectsRoot);
  } catch {
    return { root: projectsRoot, groups: [] };
  }

  const groups = [];
  for (const dirName of dirNames) {
    const dir = path.join(projectsRoot, dirName);
    let names = [];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const sessions = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => summarize(path.join(dir, name)))
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!sessions.length) continue;
    groups.push({
      // The slug is lossy, so the cwd recorded inside the transcript is the
      // only reliable way back to a real path.
      cwd: sessions[0].cwd || dir,
      dir,
      updatedAt: sessions[0].updatedAt,
      sessions: sessions.slice(0, limit),
    });
  }

  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  return { root: projectsRoot, groups };
}

function formatWhen(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const locale = process.env.PHONE_RATE_LIMIT_LOCALE || "ja-JP";
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date)
    : new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/claude-sessions.js [--cwd <path>] [--limit <n>] [--json]");
    return;
  }

  loadEnvFile(path.join(root, ".env"));

  // Narrowing to one workdir is opt-in. Defaulting to it is what made sessions
  // look missing: change the bridge's workdir and the old ones stop appearing.
  if (args.cwd) {
    const cwd = path.resolve(args.cwd);
    const { dir, sessions } = listSessions(cwd, args.limit);
    if (args.json) {
      console.log(JSON.stringify({ cwd, dir, sessions }, null, 2));
      return;
    }
    printGroup({ cwd, dir, sessions });
    if (!sessions.length) console.log("Run without --cwd to see every workdir.");
    return;
  }

  const { root: projectsRoot, groups } = listAllSessions(args.limit);

  if (args.json) {
    console.log(JSON.stringify({ root: projectsRoot, groups }, null, 2));
    return;
  }

  if (!groups.length) {
    console.log(`No Claude sessions recorded under ${projectsRoot} yet.`);
    return;
  }

  for (const group of groups) printGroup(group);

  console.log("`claude --resume` without an id only lists sessions for the directory it is started");
  console.log("from, so run the `cd` above first, or pass the id directly.");
  console.log("");
  console.log("Not showing up in the picker even after the cd? `claude -c` opens that directory's");
  console.log("newest conversation without the picker, which tells you whether the session is");
  console.log("reachable at all or you are simply in the wrong directory.");
}

function printGroup({ cwd, dir, sessions }) {
  console.log(`■ ${cwd}`);
  console.log(`  ${dir}`);
  // The picker is scoped to the directory it is started from, so getting into
  // the right one is the whole job. Lead with it rather than trailing it.
  console.log(`  cd ${cwd}`);
  console.log("");
  if (!sessions.length) {
    console.log("  (no sessions recorded for this workdir yet)");
    console.log("");
    return;
  }
  for (const session of sessions) {
    const label =
      session.customTitle || session.title || session.firstPrompt.replace(/\s+/g, " ").slice(0, 60) || "(名前未設定のチャット)";
    console.log(`  ${formatWhen(session.updatedAt)}  ${label}`);
    // The phone shows this one, so print it whenever it differs.
    if (session.lastPrompt && session.lastPrompt !== session.firstPrompt) {
      console.log(`    最新: ${session.lastPrompt.replace(/\s+/g, " ").slice(0, 60)}`);
    }
    // Per row, not just the newest: an id alone still leaves the command to be
    // assembled, and the id is the one label that cannot be misread.
    console.log(`    ${session.messages} messages  ·  claude --resume ${session.id}`);
  }
  console.log("");
}

if (require.main === module) main();

module.exports = { listAllSessions, listSessions, projectDirFor, summarize };
