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
//
// This table outranks the frontmatter a skill ships. That prose is written to be
// matched against a request - it opens with "Use when…", runs to a paragraph,
// and is usually English - which is the wrong shape for a row on a phone.
const commandDescriptions = {
  agents: "サブエージェントの一覧と管理",
  autocompact: "自動要約が始まるサイズを変える",
  clear: "会話をリセットして最初から",
  color: "プロンプトバーの色を変える",
  compact: "会話を要約して文脈を空ける",
  config: "設定を開く",
  context: "文脈の使用量を内訳つきで見る",
  "code-review": "変更をレビューして指摘を出す",
  debug: "デバッグ情報を仕込んで原因を絞る",
  doctor: "インストール状態を診断する",
  effort: "考える深さを変える",
  "extra-usage": "クレジット残量を見る（/usage-credits の旧名）",
  fast: "高速モードを切り替える",
  goal: "完了条件を決めて、満たすまで作業を続けさせる",
  init: "このリポジトリの CLAUDE.md を作る",
  insights: "使い方の傾向をまとめて見る",
  loop: "同じ作業を一定間隔で繰り返す",
  mcp: "MCP サーバーの接続状態を見る",
  model: "使うモデルを変える",
  recap: "セッションに戻ったとき経緯を思い出す",
  "reload-skills": "再起動せずスキルを読み込み直す",
  rename: "このセッションの名前を変える",
  review: "プルリクエストをレビューする",
  run: "アプリを起動して動作を見る",
  schedule: "定期実行のエージェントを組む",
  "security-review": "変更のセキュリティ面を点検する",
  simplify: "変更を整理して読みやすくする",
  "team-onboarding": "利用状況からチーム向けの入門ガイドを作る",
  ultrareview: "クラウドで複数エージェントによるレビューを走らせる",
  usage: "利用量と上限までの余裕を見る",
  "usage-credits": "クレジット残量を見る",
  verify: "作業結果が本当に通るか検証する",

  // Skills that ship with the CLI. Their descriptions live inside the binary
  // rather than on disk, so unlike the ones below they cannot be read back.
  "artifact-capabilities": "Artifact に動的な機能を持たせる方法を調べる",
  "artifact-design": "Artifact の見た目と構成を決める指針",
  "artifact-diagramming": "Artifact に図を描くときの指針",
  batch: "同じ種類の変更をまとめて処理する",
  "claude-api": "Claude API のモデル・料金・使い方を正確に引く",
  dataviz: "グラフや可視化を作る前に読む配色と設計の指針",
  "deep-research": "時間をかけて調べ、根拠つきでまとめる",
  "fewer-permission-prompts": "よく使う操作を許可リストにして確認を減らす",
  "keybindings-help": "キーボードショートカットを設定する",
  "run-skill-generator": "新しいスキルを作る",
  "update-config": "settings.json のフック・権限・環境変数を設定する",

  // Skills kept by the owner of this machine.
  "coconala-listing-optimizer": "ココナラ出品ページを診断して改善案を出す",
  "cross-review": "他のAIやセッションが出した成果をレビューする",
  "current-project-intake": "今の作業を棚卸しして次の一手を決める",
  "document-maintainer": "正典ドキュメントを構造を保ったまま更新する",
  "evidence-critic": "計画や判断を根拠と突き合わせて批判的に点検する",
  "finish-line": "当初の目的を見失わずに完了まで持っていく",
  "funabashi-decision-pipeline": "判断と戦略を実行できる指示に落とし込む",
  "funabashi-operating-profile": "提案や指示をこの利用者の進め方に合わせる",
  "goal-seeking-strategy": "最終目的から逆算して次にやることを決める",
  "naming-audit": "ファイル名の命名規則を監査してリネーム計画を作る",
  "parallel-orchestrator": "複数 worktree の並行作業を統合ブランチから指揮する",
  "pc-organizer": "PC上のファイルを規則に沿って整理・分類する",
  "project-init": "新しい案件の作業場をテンプレから作る",
  "quality-first-router": "作業に見合った思考の深さと進め方を選ぶ",
  "quarter-workflow": "0base の開発フロー（PR・型生成・デプロイ）",
  "revenue-companion": "今日の収益台本に並走してタスクを消化する",
  "revenue-weekly-review": "週次で収入のKPIを見て今週の一手を決める",
  "sellable-content-creator": "note・ココナラ向けの販売用コンテンツを作る",
  "session-handoff": "作業の目的と経緯を次のセッションへ引き継ぐ",
  "thinking-abstraction": "指摘や違和感を再利用できる判断基準に変える",
  "tmux-work-session": "tmux の常駐作業セッションを整える・直す",
  "workflow-executor": "判断や戦略を作業指示・チェックリストに変換する",
  "worktree-executor": "割り当てられた worktree で実装して handoff を返す",

  // Plugin commands, namespaced by the plugin that brought them. Taken from the
  // command files in the plugin's own cache.
  CLAUDE: "claude-mem が記録した直近の作業を読み込む",
  "claude-mem:CLAUDE": "claude-mem が記録した直近の作業を読み込む",
  "claude-mem:do": "サブエージェントに作業を割り振って実行させる",
  "claude-mem:make-plan": "段階に分けた実行計画を作る",
};

// `/help` answers "isn't available in this environment" through the bridge, and
// the terminal-only ones behave the same way. Listing them would be offering a
// button whose only outcome is that sentence. The last few are plumbing another
// command drives; nobody types them.
const unavailableHeadless = new Set([
  "help",
  "heapdump",
  "vim",
  "terminal-setup",
  "login",
  "logout",
  "exit",
  "quit",
  "workflow-launch-exec",
]);

function isInternalCommand(name) {
  return name.startsWith("__");
}

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
    if (!name || seen.has(name) || unavailableHeadless.has(name) || isInternalCommand(name)) continue;
    seen.add(name);
    const kind = classifySlashCommand(name, skillSet);
    // The written-for-a-phone line first, then whatever the skill said itself.
    const described = commandDescriptions[name] || descriptions[name] || "";
    catalog.push({ name, kind, description: shortDescription(described) });
  }
  // Built-ins first because they are what the CLI itself offers, then skills,
  // then plugin commands; alphabetical inside each so a name can be found by
  // scanning rather than by remembering where it sat last time.
  const order = { builtin: 0, skill: 1, plugin: 2 };
  return catalog.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

module.exports = {
  commandDescriptions,
  classifySlashCommand,
  normalizeCommandName,
  shortDescription,
  slashCommandCatalog,
  unavailableHeadless,
};
