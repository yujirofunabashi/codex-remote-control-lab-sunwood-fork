// The slash commands a session actually has.
//
// Claude reports them itself: every turn opens with a `system/init` message
// carrying `slash_commands` and `skills`, so the phone never has to ship a list
// that goes stale the moment a skill is added or the CLI is updated. What is
// hard-coded here is only the one thing that message does not carry - a short
// description for the built-ins. Skills bring their own from SKILL.md.
//
// Commands with no description still appear. A name and nothing else beats a
// name that is missing, and beats a sentence invented for it.

// Written for someone deciding whether to tap on a phone, so each one says what
// happens rather than what the command is called. Left deliberately incomplete:
// a command absent from this table is listed without a description.
const builtinDescriptions = {
  agents: "サブエージェントの一覧と管理",
  autocompact: "自動要約の発動サイズを変える",
  clear: "会話をリセットして最初から",
  color: "配色テーマを変える",
  compact: "会話を要約して文脈を空ける",
  config: "設定を開く",
  context: "文脈の使用量を内訳つきで見る",
  "code-review": "変更をレビューして指摘を出す",
  debug: "デバッグ情報を仕込んで調べる",
  design: "デザイン作業のモードに入る",
  doctor: "インストール状態を診断する",
  effort: "考える深さを変える",
  "extra-usage": "追加利用の状況を見る",
  fast: "高速モードを切り替える",
  init: "このリポジトリの CLAUDE.md を作る",
  insights: "使い方の傾向をまとめて見る",
  import: "他のツールから設定を取り込む",
  loop: "同じ作業を一定間隔で繰り返す",
  mcp: "MCP サーバーの接続状態を見る",
  model: "使うモデルを変える",
  recap: "これまでの作業を振り返る",
  "reload-skills": "スキルを読み込み直す",
  rename: "このセッションの名前を変える",
  review: "プルリクエストをレビューする",
  run: "アプリを起動して動作を見る",
  schedule: "定期実行のエージェントを組む",
  "security-review": "変更のセキュリティ面を点検する",
  simplify: "変更を整理して読みやすくする",
  usage: "利用量と上限までの余裕を見る",
  "usage-credits": "クレジット残量を見る",
  verify: "作業結果が本当に通るか検証する",
};

// `/help` answers "isn't available in this environment" through the bridge, and
// the terminal-only ones behave the same way. Listing them would be offering a
// button whose only outcome is that sentence.
const unavailableHeadless = new Set(["help", "heapdump", "vim", "terminal-setup", "login", "logout", "exit", "quit"]);

function normalizeCommandName(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

// Plugins namespace theirs; a skill says so by being in the session's skill
// list; whatever is left is the CLI's own.
function classifySlashCommand(name, skills = []) {
  const command = normalizeCommandName(name);
  if (command.includes(":")) return "plugin";
  const skillSet = skills instanceof Set ? skills : new Set((skills || []).map(normalizeCommandName));
  return skillSet.has(command) ? "skill" : "builtin";
}

// A skill's frontmatter description is written to be matched against a request,
// so it opens with trigger prose and runs long. The first sentence is the part
// that says what it does.
function shortDescription(value, limit = 74) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  // Japanese ends a sentence without a following space, so `。` breaks on its
  // own; a Latin full stop needs the space to avoid cutting at "e.g.".
  const sentence = text.split(/(?<=[。！？])\s*|(?<=[.!?])\s+/)[0] || text;
  const trimmed = sentence.replace(/[。.]$/, "");
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

function slashCommandCatalog({ commands = [], skills = [], descriptions = {} } = {}) {
  const skillSet = new Set((skills || []).map(normalizeCommandName));
  const seen = new Set();
  const catalog = [];
  for (const raw of commands || []) {
    const name = normalizeCommandName(raw);
    if (!name || seen.has(name) || unavailableHeadless.has(name)) continue;
    seen.add(name);
    const kind = classifySlashCommand(name, skillSet);
    const described = descriptions[name] ?? (kind === "builtin" ? builtinDescriptions[name] : "");
    catalog.push({ name, kind, description: shortDescription(described) });
  }
  // Built-ins first because they are what the CLI itself offers, then skills,
  // then plugin commands; alphabetical inside each so a name can be found by
  // scanning rather than by remembering where it sat last time.
  const order = { builtin: 0, skill: 1, plugin: 2 };
  return catalog.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

module.exports = {
  builtinDescriptions,
  classifySlashCommand,
  normalizeCommandName,
  shortDescription,
  slashCommandCatalog,
  unavailableHeadless,
};
