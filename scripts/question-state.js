// Text is only a conservative fallback for completed turns. Real held input
// and permission requests continue to use the bridge's pendingApproval state.
// A punctuation mark anywhere in an answer is not evidence of waiting for its
// reader: code, quoted examples and documentation routinely contain questions.

const examplePrefix = /^(?:例(?:文|示|題)?|文例|表示例|質問例|記載例|操作例|参考例|example(?:s)?|e\.g\.)\s*[:：]/i;
const referenceHeading = /^(?:用語(?:メモ|集|説明)?|凡例|参考(?:資料|文献|情報)?|出典|引用|例(?:文|示|題)?|質問例|表示例|よくある質問|FAQ|glossary|terms|references|sources|examples?)(?:\s|[:：]|$)/i;
const listPrefix = /^\s*(?:[-*+]\s+|\d+[.)、]\s*|[A-Z][.)]\s+|[①-⑳]\s*)/;
const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)+\s*$/;

function readableBlocks(text) {
  const cleaned = String(text || "")
    .replace(/<oai-mem-citation\b[^>]*>[\s\S]*?(?:<\/oai-mem-citation>|$)/gi, "")
    .replace(/<!--[^]*?(?:-->|$)/g, "")
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const blocks = [];
  let lines = [], fence = null, referenceDepth = 0, inTable = false;
  const flush = () => { if (lines.length) blocks.push(lines); lines = []; };
  const sourceLines = cleaned.split(/\r?\n/);
  for (const [index, raw] of sourceLines.entries()) {
    const marker = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) { flush(); fence = marker[1]; continue; }
    const heading = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      if (referenceDepth && heading[1].length <= referenceDepth) referenceDepth = 0;
      if (!referenceDepth && referenceHeading.test(heading[2].replace(/\*\*|__/g, ""))) referenceDepth = heading[1].length;
      continue;
    }
    if (referenceDepth) continue;
    if (inTable && raw.includes("|")) continue;
    inTable = false;
    if (raw.includes("|") && tableSeparator.test(sourceLines[index + 1] || "")) {
      flush(); inTable = true; continue;
    }
    // Quoted material, tables and indented code are not addressed to the user.
    if (/^\s*>|^\s*\||^(?: {4}|\t)/.test(raw)) { flush(); continue; }
    if (!raw.trim() || /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(raw)) { flush(); continue; }
    const listed = listPrefix.test(raw);
    const content = raw.replace(listPrefix, "")
      .replace(/(`+)[^\n]*?\1/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/<[^>\n]+>/g, "")
      .replace(/\*\*|__/g, "").trim();
    if (!content) continue;
    if (lines.length && lines[0].listed !== listed) flush();
    lines.push({ text: content, listed });
  }
  flush();
  return blocks;
}

function directReplyRequest(text) {
  if (examplePrefix.test(text)) return "";
  // Keep quoted choice labels in the returned question, but do not classify
  // quoted questions themselves as direct speech.
  const unquoted = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g, "");
  const sentence = unquoted.split(/[。.!！]/).map((part) => part.trim()).filter(Boolean).at(-1) || "";
  if (!sentence) return "";
  const japaneseQuestion = /(?:ですか|ますか|でしょうか|ませんか|だろうか|でよいか|してよいか|必要か)[?？]?\s*$/u.test(sentence)
    || /(?:大丈夫|よい|いい|問題ない|構わない|OK)[?？]\s*$/iu.test(sentence)
    || /(?:どちら|どれ|どこ|どの|いつ|誰|何|どう|いくつ|いくら)[^?？]{0,100}[?？]\s*$/u.test(sentence);
  const japaneseReply = /(?:(?:回答|返答|返信)(?:を)?(?:してください|お願いします|お願いいたします)|(?:教えて|お知らせ|お聞かせ|お答え)(?:ください|いただけますか))[?？]?\s*$/u.test(sentence)
    || /(?:希望|どちら|どれ|いずれか|候補|選択肢)[^。]{0,100}(?:選んで|選択して|お選び)ください[?？]?\s*$/u.test(sentence);
  const englishQuestion = /^(?:please[,，]?\s+)?(?:can|could|would|will|should|shall|may|do|does|did|is|are|was|were|have|has|what|which|where|when|why|who|how)\b[^?？]+[?？]\s*$/i.test(sentence);
  const englishReply = /^(?:please\s+)?(?:reply|respond|answer|let me know|tell me)\b.+$/i.test(sentence);
  // Conventional offers of future help do not leave completed work waiting
  // on the reader. An actual question still wins over this narrow exclusion.
  const optionalOffer = /(?:必要(?:であれば|なら|でしたら)|(?:不明点|疑問点|質問|問題|不具合)が(?:あれば|ありましたら))/.test(sentence)
    || /^(?:please\s+)?let me know if you (?:need|want)\b/i.test(sentence);
  if (!japaneseQuestion && !englishQuestion && !((japaneseReply || englishReply) && !optionalOffer)) return "";
  // A trailing reported-speech suffix does not satisfy the anchored patterns.
  // Return the actual closing sentence, not unrelated final glossary lines.
  return (text.split(/[。.!！]/).map((part) => part.trim()).filter(Boolean).at(-1) || text).slice(0, 500);
}

function questionFromAssistantText(text) {
  const blocks = readableBlocks(text);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const previous = blocks[index - 1];
    // A standalone "Example:" label also applies across a paragraph break.
    if (previous?.length === 1 && examplePrefix.test(previous[0].text) && /[:：]\s*$/.test(previous[0].text)) {
      index -= 1;
      continue;
    }
    if (block[0].listed) {
      const questions = block.map((line) => directReplyRequest(line.text)).filter(Boolean);
      if (questions.length) return questions.join("\n").slice(0, 500);
      // Short labels can be answer options beneath the question. A completed
      // checklist or a later instruction, however, closes the earlier question.
      if (block.every((line) => line.text.length <= 80 && !/[。.!！?？]|(?:です|ます|ました|ください|済み|完了|done|completed)\s*$/iu.test(line.text))) continue;
      return "";
    }
    const paragraph = block.map((line) => line.text).join(" ");
    if (/^(?:ありがとうございます|よろしくお願いします|thanks|thank you)[。.!！]*$/i.test(paragraph)) continue;
    return directReplyRequest(paragraph);
  }
  return "";
}

function latestAssistantQuestion(bridge, turnId = "") {
  const history = Array.isArray(bridge?.history) ? bridge.history : [];
  const conversation = history.filter((entry) => entry?.type === "user" || entry?.type === "assistant");
  const scoped = turnId ? conversation.filter((entry) => entry.outputGroup === turnId) : conversation;
  const last = scoped.at(-1);
  if (last?.type !== "assistant" || last.phase === "commentary") return "";
  return questionFromAssistantText(last.text);
}

function idleRunStateFromHistory(history = [], recordedRun = null) {
  // Session-file evidence of active work must never be replaced by text from
  // an earlier completed answer. Completed records still need the same reply
  // classification as live completion, so reconnects do not lose a question.
  if (recordedRun && recordedRun.state !== "done") return recordedRun;
  const last = history.findLast((entry) => entry.type === "user" || entry.type === "assistant");
  if (!last) return recordedRun || { state: "ready", label: "未実行・送信できます", turnId: null };
  if (last.type === "assistant") {
    const turnId = recordedRun?.turnId || last.outputGroup || null;
    const question = latestAssistantQuestion({ history }, recordedRun?.turnId || "");
    return { state: question ? "question" : "done", label: question ? "返信待ち" : "前回完了・送信できます", turnId };
  }
  return { state: "ready", label: "前回送信済み・応答未確認", turnId: last.outputGroup || null };
}

module.exports = { questionFromAssistantText, latestAssistantQuestion, idleRunStateFromHistory };
