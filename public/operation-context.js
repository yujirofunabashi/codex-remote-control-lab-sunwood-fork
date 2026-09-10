(function initOperationContext(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PhoneOperationContext = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const maxAgeMs = 12 * 60 * 60 * 1000;
  const storageKey = "codexPhoneOperationContext:v1";
  const machines = { air: "Air", mini: "mini", iphone: "iPhone", ipad: "iPad", windows: "Windows", android: "Android", mac: "Mac" };
  const presets = [
    { id: "air", label: "Airで直接", operator: "air", screen: "air", route: "direct" },
    { id: "mini", label: "miniで直接", operator: "mini", screen: "mini", route: "direct" },
    { id: "air-mini", label: "Airからminiの画面", operator: "air", screen: "mini", route: "screen-sharing" },
    { id: "iphone", label: "iPhone", operator: "iphone", screen: "iphone", route: "direct" },
    { id: "ipad", label: "iPad", operator: "ipad", screen: "ipad", route: "direct" },
    { id: "windows", label: "Windowsで直接", operator: "windows", screen: "windows", route: "direct" },
  ];

  function machine(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(machines, value) ? value : "";
  }

  // Browser families describe where the page runs, never who is holding it.
  // In particular, a Mac user agent cannot distinguish Air from mini.
  function browserScreen(navigatorLike = {}) {
    const ua = String(navigatorLike.userAgent || "");
    if (/iPhone/.test(ua)) return "iphone";
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigatorLike.maxTouchPoints > 1)) return "ipad";
    if (/Android/.test(ua)) return "android";
    if (/Windows/.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/.test(ua)) return "mac";
    return "";
  }

  function selectPreset(id, now = Date.now()) {
    const preset = presets.find((entry) => entry.id === id);
    return preset ? { version: 1, screen: preset.screen, operator: preset.operator, route: preset.route, selectedAt: now } : null;
  }

  function normalize(input, now = Date.now()) {
    const source = input && typeof input === "object" ? input : {};
    const screen = machine(source.screen);
    const operator = machine(source.operator);
    const selectedAt = typeof source.selectedAt === "number" && Number.isFinite(source.selectedAt) && source.selectedAt > 0 ? source.selectedAt : null;
    const fresh = selectedAt !== null && selectedAt <= now + 60_000 && now - selectedAt <= maxAgeMs;
    const routeValid = source.route === "direct" ? screen && operator === screen
      : source.route === "screen-sharing" && screen && operator && screen !== operator;
    if (fresh && routeValid) return { version: 1, screen, operator, route: source.route, selectedAt, evidence: "selected" };
    return { version: 1, screen, operator: "", route: "unknown", selectedAt: null, evidence: "unknown" };
  }

  function forBrowser(saved, navigatorLike = {}, now = Date.now()) {
    const context = normalize(saved, now);
    const detected = browserScreen(navigatorLike);
    // A profile copied to a different browser family is not current evidence.
    if (detected && context.screen && (detected === "mac" ? !["air", "mini", "mac"].includes(context.screen) : detected !== context.screen)) {
      return normalize({ screen: detected }, now);
    }
    return { ...context, screen: context.screen || detected };
  }

  function machineLabel(value) { return machines[machine(value)] || "未確認"; }

  function badge(context) {
    return context.operator ? `操作 ${machineLabel(context.operator)}${context.route === "screen-sharing" ? "·共有" : ""}` : "操作元 ?";
  }

  function describe(context, executor = "未確認") {
    const route = { direct: "直接", "screen-sharing": "画面共有", unknown: "未確認" }[context.route] || "未確認";
    return `手元: ${machineLabel(context.operator)} / 画面: ${machineLabel(context.screen)} / 経路: ${route} / 入口: 自作アプリ / 実行先: ${executor}`;
  }

  // Only fixed vocabularies and timestamps cross into model context. Client
  // input cannot supply instructions, an executor, or claims of verification.
  function modelContext(input, executionMachine, now = Date.now()) {
    const context = normalize(input, now);
    const executor = String(executionMachine || "この接続先").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 32) || "この接続先";
    const selected = context.selectedAt ? `;選択=${new Date(context.selectedAt).toISOString()}` : "";
    const receivedAt = typeof input?.receivedAt === "number" && input.receivedAt > 0 && input.receivedAt <= now ? input.receivedAt : now;
    return `[操作環境 受信=${new Date(receivedAt).toISOString()}] ${describe(context, executor)}${selected}。この送信時のみ。手元・画面・経路は選択またはブラウザ推定。通常は復唱不要。過去の操作元を別の入口へ引き継がず、画面操作に必要な時だけ確認。`;
  }

  return { storageKey, maxAgeMs, presets, machineLabel, browserScreen, selectPreset, normalize, forBrowser, badge, describe, modelContext };
});
