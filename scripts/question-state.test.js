const test = require("node:test");
const assert = require("node:assert/strict");
const { latestAssistantQuestion, idleRunStateFromHistory } = require("./question-state");

const completionReport = `mini・Airに実装を反映しました。再起動は不要です。

処理中は枠が周回、完了は✓、質問・許可待ちは?、エラーは!で表示。押すと対象の会話へ移動し、完了は確認するまで残ります。

表示が変わらなければ、この処理の完了後に画面を開き直してください。

## やさしい版

会話へ移れる行を追加し、検査も成功しました。

## 用語メモ

- **?**: 質問への回答や許可を待っている印。
- **!**: エラーが起きたことを示す印。`;

function classify(text) {
  return latestAssistantQuestion({ history: [{ type: "assistant", text, outputGroup: "current" }] }, "current");
}

const notQuestions = [
  ["the owner's completed report with the question-symbol legend", completionReport],
  ["standalone legend", "質問・許可待ちは?、エラーは!で表示します。"],
  ["question symbol explained at the end", "返信待ちを示す記号は ?"],
  ["routine inspection instruction", "実装が完了しました。画面で確認してください。"],
  ["optional closing offer", "実装が完了しました。不明点があれば教えてください。"],
  ["optional request for follow-up", "必要でしたらお知らせください。"],
  ["optional English closing offer", "Done. Let me know if you need anything else."],
  ["incidental choice word", "miniとAirのどちらも正常に動作しています。"],
  ["inline code", "設定は完了しました。式は `ready ? done : error` です。"],
  ["fenced example", "実装が完了しました。\n\n```text\n続行しますか？\n```"],
  ["unclosed fenced example", "実装が完了しました。\n\n~~~text\n続行しますか？"],
  ["blockquote", "実装が完了しました。\n\n> 続行しますか？"],
  ["quoted question", "「続行しますか？」と表示する実装です。"],
  ["standalone quoted question", "実装が完了しました。\n\n「続行しますか？」"],
  ["markdown table", "| 表示例 | 意味 |\n| --- | --- |\n| 続行しますか？ | 質問 |"],
  ["markdown table without outside pipes", "状態 | 表示例\n--- | ---\n質問 | 続行しますか？"],
  ["labelled example", "例：続行しますか？"],
  ["labelled example across a paragraph break", "反映しました。\n\n例：\n\n続行しますか？"],
  ["labelled English example", "Example: Would you like me to continue?"],
  ["FAQ section", "実装を反映しました。\n\n## FAQ\n\nWould you like me to continue?"],
  ["glossary containing a real-sounding question", "実装を反映しました。\n\n## 用語メモ\n\n質問例：続行しますか？"],
  ["question in a link target", "手順は [こちら](https://example.test/help?mode=ready) です。"],
  ["an earlier question followed by completion", "この方針でよいですか？\n\n承認に従って反映しました。回答は不要です。"],
  ["reported question", "続行しますか？という文言を表示します。"],
];
for (const [name, text] of notQuestions) test(`done: ${name}`, () => assert.equal(classify(text), ""));

const questions = [
  "この方針で進めてよいですか？",
  "この方針で進めてよいですか",
  "miniとAirのどちらで進めますか？",
  "対象はどれですか？",
  "この内容で大丈夫？",
  "希望する端末名を返信してください。",
  "希望する端末名を教えてください。",
  "使用する端末について回答をお願いします。",
  "はい・いいえでお答えください。",
  "候補から希望する端末を選んでください。",
  "実装の準備ができました。続行しますか？",
  "準備できました。\n\n**続行しますか？**",
  "作業先は「mini」と「Air」のどちらにしますか？",
  "どちらで進めますか？\n\n- mini\n- Air",
  "回答をお願いします。\n\n1. mini\n2. Air",
  "- 作業先はminiでよいですか？\n- 対象のファイル名を教えてください。",
  "Would you like me to continue?",
  "Which machine should I use?",
  "Please reply with the machine name.",
  "続行しますか？\n\n## 用語メモ\n\n- mini: 作業用のMac。",
  "続行しますか？\n\n<oai-mem-citation>\n<citation_entries>reference</citation_entries>\n</oai-mem-citation>",
];
for (const text of questions) test(`question: ${text.split("\n")[0]}`, () => assert.ok(classify(text), text));

test("the notification contains the actual question rather than the glossary/footer", () => {
  assert.equal(classify("準備できました。\n\n続行しますか？\n\n## 用語メモ\n\n- mini: Mac。"), "続行しますか？");
});

test("a user response resolves the previous question", () => {
  assert.equal(latestAssistantQuestion({ history: [{ type: "assistant", text: "続行しますか？" }, { type: "user", text: "続行" }] }), "");
});

test("a completion with no assistant answer must not borrow an older turn's question", () => {
  const history = [{ type: "assistant", text: "続行しますか？", outputGroup: "old" }];
  assert.equal(latestAssistantQuestion({ history }, "new"), "");
});

test("only the latest assistant reply of the requested turn determines its state", () => {
  const history = [
    { type: "assistant", text: "続行しますか？", outputGroup: "old" },
    { type: "user", text: "実装して", outputGroup: "current" },
    { type: "assistant", text: "必要な設定を確認しています。", outputGroup: "current" },
    { type: "assistant", text: completionReport, outputGroup: "current" },
  ];
  assert.equal(latestAssistantQuestion({ history }, "current"), "");
});

test("a progress message is not a final request for a reply", () => {
  const history = [{ type: "assistant", phase: "commentary", text: "こちらで続行しますか？", outputGroup: "current" }];
  assert.equal(latestAssistantQuestion({ history }, "current"), "");
});

test("live completion and history restore agree, including a completed session-file record", () => {
  for (const [text, expected] of [[completionReport, "done"], ["続行しますか？", "question"]]) {
    const history = [{ type: "assistant", text, outputGroup: "current" }];
    const recordedRun = { state: "done", turnId: "current" };
    assert.equal(idleRunStateFromHistory(history).state, expected);
    assert.equal(idleRunStateFromHistory(history, recordedRun).state, expected);
  }
});

test("active work and unresolved input retain their structured state", () => {
  const history = [{ type: "assistant", text: "続行しますか？", outputGroup: "old" }];
  for (const state of ["running", "streaming", "approval", "error", "interrupted"]) {
    const recordedRun = { state, turnId: "current" };
    assert.deepEqual(idleRunStateFromHistory(history, recordedRun), recordedRun);
  }
});
