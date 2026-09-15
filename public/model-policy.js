(function initModelPolicy(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PhoneModelPolicy = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  // A generation floor is independent of task difficulty and reasoning effort.
  // Unknown aliases cannot prove a generation. Never substitute another model.
  function eligibleCodexModel(value) {
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+)*$/i.exec(String(value || "").trim());
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2] || 0);
    return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
      && (major > 5 || (major === 5 && minor >= 6));
  }

  function choices(provider, list) {
    const values = (Array.isArray(list) ? list : []).map(value => String(value || "").trim()).filter(Boolean);
    return [...new Set(values)].filter(value => provider !== "codex" || eligibleCodexModel(value));
  }

  function selectionError(provider, value, available = null) {
    if (provider !== "codex") return "";
    const model = String(value || "").trim();
    if (!eligibleCodexModel(model)) return "GPT-5.6以上のモデルを選んでください。保存済みの会話と入力は残しています。";
    if (Array.isArray(available) && !available.includes(model)) {
      return "この接続先の候補に選択中のモデルがありません。モデル一覧を更新して選び直してください。入力は残しています。";
    }
    return "";
  }

  return { eligibleCodexModel, choices, selectionError };
});
