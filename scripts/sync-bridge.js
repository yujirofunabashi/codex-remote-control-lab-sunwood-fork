// A guarded, manually invoked pull. Never commits, pushes, stashes or resets.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

const messages = {
  current: "この作業場所は共有先と同じ保存版です。稼働中アプリの反映状態は画面でも確認してください。",
  updated: "共有版を取り込みました。稼働中アプリの再起動待ちと、相手側の版を画面で確認してください。",
  behind: "共有先に新しい変更があります。取り込みには npm run bridge:pull を使ってください。",
  dirty: "未共有の編集が残っています。専用の作業ブランチで確認・保存してください。編集は上書きしていません。",
  ahead: "この作業場所だけの保存済み変更があります。内容を確認して共有先へ送ってから更新してください。",
  diverged: "両側で別々の変更が保存されています。作業ブランチで両方を統合してください。自動上書きはしません。",
  "wrong-branch": "更新対象のブランチではありません。作業中のブランチは切り替えません。",
  "no-upstream": "指定した共有先を追跡していません。接続先とブランチの設定を確認してください。",
  "git-operation": "別の履歴操作が途中です。その作業を確認してから更新してください。",
  changed: "確認中に別の編集または履歴変更がありました。状態を確認してください。変更は破棄しません。",
  error: "共有先または作業場所を確認できませんでした。通信とリポジトリの状態を確認してください。",
};
function result(status, extra = {}) { return { ok: status === "current" || status === "updated", status, message: messages[status], ...extra }; }

function syncBridge(root, { apply = false, remote = "origin", branch = "develop" } = {}) {
  try {
    if (![remote, branch].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value))) return result("error");
    if (fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== fs.realpathSync(root)) return result("error");
    if (git(root, ["branch", "--show-current"]) !== branch) return result("wrong-branch");
    for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
      const location = git(root, ["rev-parse", "--git-path", operation]);
      if (fs.existsSync(path.resolve(root, location))) return result("git-operation");
    }
    if (git(root, ["status", "--porcelain=v1", "--untracked-files=normal"])) return result("dirty");
    try {
      if (git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) !== `${remote}/${branch}`) return result("no-upstream");
    } catch { return result("no-upstream"); }
    const before = git(root, ["rev-parse", "HEAD"]);
    git(root, ["fetch", "--no-tags", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    const target = git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
    const unchanged = () => git(root, ["rev-parse", "HEAD"]) === before && git(root, ["branch", "--show-current"]) === branch
      && !git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (!unchanged()) return result("changed");
    const [ahead, behind] = git(root, ["rev-list", "--left-right", "--count", `${before}...${target}`]).split(/\s+/).map(Number);
    if (ahead > 0) return result(behind > 0 ? "diverged" : "ahead", { head: before, target });
    if (!behind) return result("current", { head: before, target });
    if (!apply) return result("behind", { head: before, target });
    // Bind the update to the revision inspected above, not a moving branch name.
    git(root, ["merge", "--ff-only", target]);
    if (git(root, ["rev-parse", "HEAD"]) !== target || git(root, ["branch", "--show-current"]) !== branch
      || git(root, ["status", "--porcelain=v1", "--untracked-files=normal"])) return result("changed");
    return result("updated", { head: target, previousHead: before });
  } catch { return result("error"); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let valid = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply") options.apply = true;
    else if ((args[index] === "--branch" || args[index] === "--remote") && args[index + 1]) options[args[index].slice(2)] = args[++index];
    else valid = false;
  }
  const outcome = valid ? syncBridge(path.resolve(__dirname, ".."), options) : result("error");
  console.log(outcome.message);
  process.exitCode = outcome.ok ? 0 : 1;
}

module.exports = { syncBridge };
