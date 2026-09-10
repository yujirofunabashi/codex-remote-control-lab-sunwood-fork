const uiUtils = window.CodexPhoneUiUtils || {};
const operationContextUtils = window.PhoneOperationContext;
const operationContextButton = document.querySelector("#operationContextButton");
const operationContextDialog = document.querySelector("#operationContextDialog");
let operationContextSelection = (() => {
  try { return JSON.parse(safeReadStorage(localStorage, operationContextUtils?.storageKey, "null")); }
  catch { return null; }
})();

function operationContextForSubmission() {
  return operationContextUtils?.forBrowser(operationContextSelection, navigator) || null;
}

function renderOperationContext() {
  if (!operationContextUtils || !operationContextButton) return;
  const context = operationContextForSubmission();
  // Lab tasks do not use either Mac provider's prompt transport yet.
  operationContextButton.hidden = Boolean(activeLabInfo());
  operationContextButton.textContent = operationContextUtils.badge(context);
  operationContextButton.dataset.known = String(Boolean(context.operator));
  const executor = shortMachineName(activeBridge(), getBridgeState(activeBridgeId)) || "未確認";
  const detail = operationContextUtils.describe(context, executor);
  operationContextButton.title = `${detail}（操作元は利用者の選択）`;
  operationContextButton.setAttribute("aria-label", `操作元の名札を設定: ${detail}`);
  document.querySelector("#operationContextDetail").textContent = detail;
}

function saveOperationContext(id) {
  operationContextSelection = operationContextUtils.selectPreset(id);
  safeWriteStorage(localStorage, operationContextUtils.storageKey, JSON.stringify(operationContextSelection));
  renderOperationContext();
  operationContextDialog.close();
}

operationContextButton?.addEventListener("click", () => {
  if (!operationContextUtils) return;
  renderOperationContext();
  const context = operationContextForSubmission();
  const container = document.querySelector("#operationContextPresets");
  container.replaceChildren();
  for (const preset of operationContextUtils.presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.dataset.operationPreset = preset.id;
    button.setAttribute("aria-pressed", String(context.operator === preset.operator && context.screen === preset.screen && context.route === preset.route));
    button.addEventListener("click", () => saveOperationContext(preset.id));
    container.appendChild(button);
  }
  operationContextDialog.showModal();
});
document.querySelector("#closeOperationContext")?.addEventListener("click", () => operationContextDialog.close());
document.querySelector("#clearOperationContext")?.addEventListener("click", () => saveOperationContext(""));
window.addEventListener("storage", (event) => {
  if (event.key !== operationContextUtils?.storageKey) return;
  try { operationContextSelection = JSON.parse(event.newValue); } catch { operationContextSelection = null; }
  renderOperationContext();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") renderOperationContext();
});
const sessionActivityStrip = document.querySelector("#sessionActivityStrip");
const sessionActivityItems = document.querySelector("#sessionActivityItems");
const sessionActivityCount = document.querySelector("#sessionActivityCount");
const sessionActivityDialog = document.querySelector("#sessionActivityDialog");
const sessionActivityList = document.querySelector("#sessionActivityList");
const sessionActivityStorageKey = "codexPhoneSessionActivity:v1";
let sessionActivityRecords = (() => {
  try {
    const value = JSON.parse(safeReadStorage(localStorage, sessionActivityStorageKey, "[]"));
    return Array.isArray(value) ? value.filter((item) => item && typeof item.key === "string" && typeof item.threadId === "string" && ["codex", "claude"].includes(item.provider) && Number.isInteger(item.ordinal) && item.ordinal > 0 && ["running", "done", "question", "approval", "error", "offline", "interrupted", "idle"].includes(item.status)) : [];
  } catch { return []; }
})();
let sessionActivitySaved = JSON.stringify(sessionActivityRecords);
let sessionActivityViewRequest = null;
const sessionActivityLabels = { running: "処理中", done: "完了・未確認", question: "返信待ち", approval: "許可待ち", error: "エラー", offline: "接続・状態を確認", interrupted: "中断" };
const sessionActivityOrder = ["question", "approval", "error", "offline", "done", "interrupted", "running"];
const log = document.querySelector("#log");
const logShell = document.querySelector("#logShell");
const chatLatestButton = document.querySelector("#chatLatestButton");
const meta = document.querySelector("#meta");
const connectButton = document.querySelector("#connect");
const searchButton = document.querySelector("#searchButton");
const newSessionButton = document.querySelector("#newSessionButton");
const newSessionDialog = document.querySelector("#newSessionDialog");
const newSessionMachine = document.querySelector("#newSessionMachine");
const newSessionProvider = document.querySelector("#newSessionProvider");
const newSessionPath = document.querySelector("#newSessionPath");
const newSessionFolders = document.querySelector("#newSessionFolders");
const newSessionLocation = document.querySelector("#newSessionLocation");
const newSessionStatus = document.querySelector("#newSessionStatus");
const newSessionUp = document.querySelector("#newSessionUp");
const createNewSession = document.querySelector("#createNewSession");
let newSessionBrowseSeq = 0;
let newSessionFolder = null;
let newSessionStarting = false;
const pluginsButton = document.querySelector("#pluginsButton");
const automationsButton = document.querySelector("#automationsButton");
const settingsButton = document.querySelector("#settingsButton");
const menuButton = document.querySelector("#menuButton");
const mobileSettingsButton = document.querySelector("#mobileSettingsButton");
const sidebarRestartButton = document.querySelector("#sidebarRestartButton");
const closePanelButton = document.querySelector("#closePanelButton");
const addButton = document.querySelector("#addButton");
const expandPromptButton = document.querySelector("#expandPromptButton");
const accessButton = document.querySelector("#accessButton");
const modelButton = document.querySelector("#modelButton");
const modelMenu = document.querySelector("#modelMenu");
const labControls = document.querySelector("#labControls");
const labStateLabel = document.querySelector("#labStateLabel");
const labObservedAt = document.querySelector("#labObservedAt");
const labStart = document.querySelector("#labStart");
const labShutdown = document.querySelector("#labShutdown");
const labOperationPending = new Set();
const rateLimitList = document.querySelector("#rateLimitList");
const voiceButton = document.querySelector("#voiceButton");
const fileInput = document.querySelector("#fileInput");
const attachments = document.querySelector("#attachments");
const mobileThreadsButton = document.querySelector("#mobileThreads");
const sidebarScrim = document.querySelector("#sidebarScrim");
const artifactPanel = document.querySelector(".artifact-panel");
const artifactButtons = document.querySelectorAll("[data-artifact]");
const artifactTitle = document.querySelector("#artifactTitle");
const artifactList = document.querySelector("#artifactList");
const artifactPreview = document.querySelector("#artifactPreview");
const terminalList = document.querySelector("#terminalList");
const mainTerminalView = document.querySelector("#mainTerminalView");
const terminalTranscript = document.querySelector("#terminalTranscript");
const terminalCommandForm = document.querySelector("#terminalCommandForm");
const terminalCommandInput = document.querySelector("#terminalCommandInput");
const terminalCommandRunButton = document.querySelector("#terminalCommandRun");
const terminalFilter = document.querySelector("#terminalFilter");
const terminalFilterChips = document.querySelectorAll("[data-terminal-filter]");
const terminalSearchInput = document.querySelector("#terminalSearchInput");
const terminalSearchCount = document.querySelector("#terminalSearchCount");
const terminalSearchPrevButton = document.querySelector("#terminalSearchPrev");
const terminalSearchNextButton = document.querySelector("#terminalSearchNext");
const terminalWrapToggle = document.querySelector("#terminalWrapToggle");
const terminalAutoScrollButton = document.querySelector("#terminalAutoScroll");
const terminalClearButton = document.querySelector("#terminalClear");
const terminalCopyButton = document.querySelector("#terminalCopy");
const terminalLatestButton = document.querySelector("#terminalLatestButton");
const terminalFocusButton = document.querySelector("#terminalFocusButton");
const terminalFontDownButton = document.querySelector("#terminalFontDown");
const terminalFontResetButton = document.querySelector("#terminalFontReset");
const terminalFontUpButton = document.querySelector("#terminalFontUp");
const terminalFilterSheetButton = document.querySelector("#terminalFilterSheetButton");
const terminalCurrentFilterPill = document.querySelector("#terminalCurrentFilterPill");
const terminalCompactSearchButton = document.querySelector("#terminalCompactSearchButton");
const terminalCompactSearchCount = document.querySelector("#terminalCompactSearchCount");
const terminalAutoScrollMini = document.querySelector("#terminalAutoScrollMini");
const terminalToolsButton = document.querySelector("#terminalToolsButton");
const terminalToolsSheet = document.querySelector("#terminalToolsSheet");
const terminalToolsCloseButton = document.querySelector("#terminalToolsClose");
const terminalMaxSheetButton = document.querySelector("#terminalMaxSheetButton");
const terminalQuickbarPinButton = document.querySelector("#terminalQuickbarPin");
const terminalStatusTitle = document.querySelector("#terminalStatusTitle");
const terminalSessionMeta = document.querySelector("#terminalSessionMeta");
const terminalOps = document.querySelector("#terminalOps");
const terminalTextModeButton = document.querySelector("#terminalTextMode");
const terminalKeysModeButton = document.querySelector("#terminalKeysMode");
const terminalInputModeButton = document.querySelector("#terminalInputModeButton");
const terminalHelper = document.querySelector("#terminalHelper");
const statusButton = document.querySelector("#statusButton");
const chatViewButton = document.querySelector("#chatViewButton");
const terminalViewButton = document.querySelector("#terminalViewButton");
const chatUnreadBadge = document.querySelector("#chatUnreadBadge");
const chatViewLabel = document.querySelector("#chatViewLabel");
const terminalUnreadBadge = document.querySelector("#terminalUnreadBadge");
const bottomNav = document.querySelector("#bottomNav");
const bottomNavChatLabel = document.querySelector("#bottomNavChatLabel");
const bottomNavChatBadge = document.querySelector("#bottomNavChatBadge");
const bottomNavTerminalBadge = document.querySelector("#bottomNavTerminalBadge");
const bottomNavApprovalBadge = document.querySelector("#bottomNavApprovalBadge");
const commandSheet = document.querySelector("#commandSheet");
const commandList = document.querySelector("#commandList");
const commandSearch = document.querySelector("#commandSearch");
const commandSheetClose = document.querySelector("#commandSheetClose");
const prevThreadButton = document.querySelector("#prevThread");
const nextThreadButton = document.querySelector("#nextThread");
const threadPositionPill = document.querySelector("#threadPositionPill");
const threadPositionText = document.querySelector("#threadPositionText");
const threadStateText = document.querySelector("#threadStateText");
const headerThreadColorButton = document.querySelector("#headerThreadColorButton");
const threadColorPopover = document.querySelector("#threadColorPopover");
const threadSwitcher = document.querySelector("#threadSwitcher");
const threadSwitcherList = document.querySelector("#threadSwitcherList");
const closeThreadSwitcherButton = document.querySelector("#closeThreadSwitcher");
const swipeFeedback = document.querySelector("#swipeFeedback");
const webSearchButton = document.querySelector("#webSearchButton");
const artifactsTab = document.querySelector("#artifactsTab");
const workspaceTab = document.querySelector("#workspaceTab");
const automationTab = document.querySelector("#automationTab");
const panelTabButtons = document.querySelectorAll("[data-panel-tab]");
const runState = document.querySelector("#runState");
const runStateLabel = document.querySelector("#runStateLabel");
const threadList = document.querySelector("#threadList");
const threadSearch = document.querySelector("#threadSearch");
const threadTitle = document.querySelector("#threadTitle");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const workspaceIndicator = document.querySelector("#workspaceIndicator");
const workspaceSourceTag = document.querySelector("#workspaceSourceTag");
const workspaceRepo = document.querySelector("#workspaceRepo");
const workspaceLocation = document.querySelector("#workspaceLocation");
const workspaceBranchTag = document.querySelector("#workspaceBranchTag");
const branchName = document.querySelector("#branchName");
const workspaceConnectionDot = document.querySelector("#workspaceConnectionDot");
const contextMismatch = document.querySelector("#contextMismatch");
const contextMismatchSummary = document.querySelector("#contextMismatchSummary");
const contextAgentCwd = document.querySelector("#contextAgentCwd");
const contextBridgeCwd = document.querySelector("#contextBridgeCwd");
const contextFreshness = document.querySelector("#contextFreshness");
const sidebarProjectName = document.querySelector("#sidebarProjectName");
const threadSidebar = document.querySelector("#threadSidebar");
const sidebarConnectionsToggle = document.querySelector("#sidebarConnectionsToggle");
const sidebarProjectBridge = document.querySelector("#sidebarProjectBridge");
const bridgeBuildNotice = document.querySelector("#bridgeBuildNotice");
const sendButton = document.querySelector("#send");
const sendLabel = document.querySelector("#sendLabel");
const interruptButton = document.querySelector("#interruptRun");
const promptModal = document.querySelector("#promptModal");
const promptModalInput = document.querySelector("#promptModalInput");
const closePromptModalButton = document.querySelector("#closePromptModalButton");
const cancelPromptModalButton = document.querySelector("#cancelPromptModalButton");
const applyPromptModalButton = document.querySelector("#applyPromptModalButton");
const approval = document.querySelector("#approval");
const approvalText = document.querySelector("#approvalText");
const approvalKind = document.querySelector("#approvalKind");
const approvalSummary = document.querySelector("#approvalSummary");
const approvalReason = document.querySelector("#approvalReason");
const approvalQuestions = document.querySelector("#approvalQuestions");
const approvalDetails = document.querySelector("#approvalDetails");
const approvalTitle = document.querySelector("#approvalTitle");
const approveButton = document.querySelector("#approve");
const declineButton = document.querySelector("#decline");
const quickActions = document.querySelector("#quickActions");
const toastStack = document.querySelector("#toastStack");
const bridgePill = document.querySelector("#bridgePill");
const bridgePillLabel = document.querySelector("#bridgePillLabel");
const bridgePillAgent = document.querySelector("#bridgePillAgent");
const bridgePillMetaText = document.querySelector("#bridgePillMetaText");
const fleetDashboardButton = document.querySelector("#fleetDashboardButton");
const fleetCurrentLabel = document.querySelector("#fleetCurrentLabel");
const fleetCurrentMeta = document.querySelector("#fleetCurrentMeta");
const fleetCurrentBuild = document.querySelector("#fleetCurrentBuild");
const fleetCurrentBadges = document.querySelector("#fleetCurrentBadges");
const bridgeFleetList = document.querySelector("#bridgeFleetList");
const bridgeFleetSheet = document.querySelector("#bridgeFleetSheet");
const closeBridgeFleetButton = document.querySelector("#closeBridgeFleet");
const bridgeFleetSummary = document.querySelector("#bridgeFleetSummary");
const bridgeFleetSheetList = document.querySelector("#bridgeFleetSheetList");
const globalApprovalInbox = document.querySelector("#globalApprovalInbox");
const globalRunningMonitor = document.querySelector("#globalRunningMonitor");
const globalApprovalBanner = document.querySelector("#globalApprovalBanner");
const addBridgeButton = document.querySelector("#addBridgeButton");
const bridgeAddInput = document.querySelector("#bridgeAddInput");
const bridgeRememberToken = document.querySelector("#bridgeRememberToken");
const bridgeAddClear = document.querySelector("#bridgeAddClear");
const bridgeAddSubmit = document.querySelector("#bridgeAddSubmit");
const bridgeAddStatus = document.querySelector("#bridgeAddStatus");
const threadInboxTabs = document.querySelector("#threadInboxTabs");
const threadInboxTabButtons = document.querySelectorAll("[data-thread-filter]");
const threadSortTabButtons = document.querySelectorAll("[data-thread-sort]");
// The list shows one provider across every Mac, and this is where that is
// chosen and seen. It switches the same way the settings sheet does.
const threadProviderTabButtons = document.querySelectorAll("[data-thread-provider]");
for (const button of threadProviderTabButtons) {
  button.addEventListener("click", () => {
    const provider = normalizeProviderName(button.dataset.threadProvider);
    if (provider && provider !== currentThreadProvider()) switchThreadProvider(provider);
  });
}
const approvalStrip = document.querySelector("#approvalStrip");
const taskTemplates = document.querySelector("#taskTemplates");
const taskTemplatesToggle = document.querySelector("#taskTemplatesToggle");
const reviewTabButtons = document.querySelectorAll("[data-review-tab]");

const tokenStorageKey = "codexPhoneToken:v1";
const params = new URLSearchParams(location.search);
const startupHashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const startupHashToken = startupHashParams.get("token") || "";
const initialToken = params.get("token") || startupHashToken;
const initialProviderParam = (() => {
  const value = String(params.get("provider") || "").trim().toLowerCase();
  return value === "codex" || value === "claude" ? value : "";
})();
let storedToken = "";
try {
  storedToken = localStorage.getItem(tokenStorageKey) || localStorage.getItem("codexPhoneToken") || "";
} catch {
  storedToken = "";
}
let token = initialToken || storedToken;
// /bookmark and /install are served without a manifest so that "ホーム画面に追加"
// captures what is in the address bar. Both need their token left there until
// the user has added it; every other page hides the token straight away.
const preserveEntryUrl = /\/(?:bookmark|install)$/.test(location.pathname.replace(/\/+$/, ""));
let selectedThread = preserveEntryUrl ? "" : params.get("thread") || "";
let initialUrlThreadPending = Boolean(selectedThread);
try {
  if (initialToken) {
    localStorage.setItem(tokenStorageKey, initialToken);
    localStorage.removeItem("codexPhoneToken");
  }
} catch {
  // localStorage may be unavailable; the URL token still works for this page load.
}
// Safari and a Home Screen web app have separate storage. The authenticated
// install manifest therefore launches the app once with its token in the URL
// fragment. Persist it inside the web app, then remove it before anything can
// copy or display the launch URL. Fragments are never sent to the bridge.
if (startupHashToken && window.history?.replaceState) {
  const nextUrl = new URL(location.href);
  nextUrl.hash = "";
  window.history.replaceState(null, "", nextUrl);
}
// A previous protected visit may have left the token in Safari storage even
// when the user opens the short /install URL later. Reload that browser page
// with the credential so the server can attach the authenticated install
// manifest. Never do this inside the already installed Home Screen app.
const reloadInstallWithStoredToken = uiUtils.shouldReloadInstallWithStoredToken
  ? uiUtils.shouldReloadInstallWithStoredToken({
      pathname: location.pathname,
      search: location.search,
      storedToken,
      standalone: Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone === true),
    })
  : preserveEntryUrl && Boolean(storedToken) && !params.has("token") && window.navigator?.standalone !== true;
if (reloadInstallWithStoredToken) {
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("token", storedToken);
  window.location.replace(nextUrl.href);
}
// Everywhere else the token leaves the address bar as soon as it has been read.
if (!preserveEntryUrl && params.has("token") && window.history?.replaceState) {
  const nextUrl = uiUtils.urlWithoutTokenParam ? uiUtils.urlWithoutTokenParam(location.href) : (() => {
    const url = new URL(location.href);
    url.searchParams.delete("token");
    return url.href;
  })();
  window.history.replaceState(null, "", nextUrl);
}
if (preserveEntryUrl && params.has("thread") && window.history?.replaceState) {
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.delete("thread");
  window.history.replaceState(null, "", nextUrl);
}
const manifestLink = document.querySelector('link[rel="manifest"]');

function proxyBasePath() {
  const match = location.pathname.match(/^\/(?:abs)?proxy\/\d+(?=\/|$)/);
  return match ? match[0] : "";
}

const appBasePath = proxyBasePath();

// The URL to add to the home screen. /install keeps the token in the address bar,
// so the icon iOS creates launches an app that can already reach the bridge -
// unlike the root page, whose manifest start_url is deliberately token-free.
function installEntryUrl() {
  const url = new URL(appPath("/install"), location.href);
  const value = effectiveBridgeToken(activeBridge()) || token;
  if (value) url.searchParams.set("token", value);
  // The icon opens in the AI this chat is using, so a Codex chat on a
  // Claude-default bridge yields a Codex icon, with its own picture and name.
  const provider = currentThreadProvider();
  if (provider) url.searchParams.set("provider", provider);
  return url.href;
}

function rememberTokenForCurrentOrigin(value) {
  const text = String(value || "");
  if (!text) return;
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    const path = appBasePath || "/";
    document.cookie = `codex_phone_token=${encodeURIComponent(text)}; Path=${path}; SameSite=Lax${secure}`;
  } catch {
    // Cookie storage is a fallback for non-fetch resources and WebSocket reconnects.
  }
}

rememberTokenForCurrentOrigin(token);

function appPath(path) {
  const raw = String(path || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;
  return `${appBasePath}${raw}`;
}

function readJsonStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return uiUtils.safeJsonParse ? uiUtils.safeJsonParse(value, fallback, { objectOnly: true }) : JSON.parse(value || "null") || fallback;
  } catch {
    return fallback;
  }
}

function readStringListStorage(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, uiUtils.safeJsonStringify ? uiUtils.safeJsonStringify(value) : JSON.stringify(value));
  } catch {
    // localStorage may be unavailable or full; keep the in-memory state usable.
  }
}

function writeSessionJsonStorage(key, value) {
  try {
    sessionStorage.setItem(key, uiUtils.safeJsonStringify ? uiUtils.safeJsonStringify(value) : JSON.stringify(value));
  } catch {
    // Session-only bridge tokens are best effort.
  }
}

function safeReadStorage(storage, key, fallback = "") {
  try {
    return storage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeWriteStorage(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Non-critical browser preference.
  }
}

function isMobileViewport() {
  if (uiUtils.isMobileViewport) return uiUtils.isMobileViewport(window.innerWidth);
  return window.innerWidth <= 820;
}

function isStandaloneDisplayMode() {
  if (uiUtils.isStandaloneDisplayMode) return uiUtils.isStandaloneDisplayMode(window);
  return Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone === true);
}

function applyStandaloneState() {
  const standalone = isStandaloneDisplayMode();
  document.body.dataset.standalone = standalone ? "true" : "false";
  document.body.classList.toggle("app--pwa-standalone", standalone);
  return standalone;
}

function isEditableElementFocused() {
  const element = document.activeElement;
  if (!element) return false;
  const tag = String(element.tagName || "").toLowerCase();
  return tag === "textarea" || tag === "input" || element.isContentEditable === true;
}

function setupVisualViewportVars() {
  const vars = uiUtils.visualViewportVars
    ? uiUtils.visualViewportVars(window)
    : {
        visualViewportHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
        visualViewportOffsetTop: Math.round(window.visualViewport?.offsetTop || 0),
        keyboardInset: window.visualViewport
          ? Math.max(0, Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop))
          : 0,
      };
  const terminalInputFocused = document.activeElement === terminalCommandInput && mainViewMode === "terminal";
  const keyboardOpen = (vars.keyboardInset || 0) > 80 && (promptInputFocused || terminalInputFocused || isEditableElementFocused());
  const useVisualViewportForTerminal = keyboardOpen && terminalInputFocused && vars.visualViewportHeight;
  const appViewportHeight = useVisualViewportForTerminal
    ? Math.round(vars.visualViewportHeight)
    : uiUtils.effectiveAppViewportHeight
      ? uiUtils.effectiveAppViewportHeight(window, {
          viewportVars: { ...vars, keyboardInset: keyboardOpen ? vars.keyboardInset : 0 },
          standalone: isStandaloneDisplayMode(),
        })
      : Math.round((keyboardOpen && window.innerHeight) || vars.visualViewportHeight || window.innerHeight || 0);
  if (vars.visualViewportHeight) {
    document.documentElement.style.setProperty("--visual-viewport-height", `${vars.visualViewportHeight}px`);
  }
  if (appViewportHeight) {
    document.documentElement.style.setProperty("--app-viewport-height", `${appViewportHeight}px`);
  }
  document.documentElement.style.setProperty("--visual-viewport-offset-top", `${vars.visualViewportOffsetTop || 0}px`);
  document.documentElement.style.setProperty("--keyboard-inset", `${vars.keyboardInset || 0}px`);
  document.body.classList.toggle("keyboard-open", keyboardOpen);
  document.body.classList.toggle("terminal-command-focused", terminalInputFocused);
  if (document.activeElement === promptInput) keepComposerVisible();
  if (terminalInputFocused) window.requestAnimationFrame(() => window.scrollTo(0, 0));
  measureTerminalLayout();
}

function pwaDiagnosticsSnapshot() {
  const manifestHref = manifestLink ? new URL(manifestLink.href, location.href).href : "";
  const manifestUrl = manifestHref ? new URL(manifestHref) : null;
  return {
    secureContext: Boolean(window.isSecureContext),
    displayMode: isStandaloneDisplayMode() ? "standalone" : "browser",
    standalone: isStandaloneDisplayMode(),
    manifestHref: manifestUrl ? `${manifestUrl.pathname}${manifestUrl.search}` : "missing",
    manifestTokenFree: manifestUrl ? !manifestUrl.searchParams.has("token") : true,
    serviceWorker: "serviceWorker" in navigator ? "available" : "unavailable",
    tokenAvailable: Boolean(effectiveBridgeToken(activeBridge()) || token),
    cacheMode: "app-shell-only",
  };
}

function renderViewportDebug() {
  const enabled = params.get("debugViewport") === "1" || params.get("pwaDiagnostics") === "1";
  let panel = document.querySelector("#viewportDebugPanel");
  if (!enabled) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "viewportDebugPanel";
    panel.className = "viewport-debug-panel";
    panel.setAttribute("aria-label", "表示領域の診断");
    document.body.appendChild(panel);
  }
  const terminalRect = terminalTranscript?.getBoundingClientRect?.();
  const composerRect = composer?.getBoundingClientRect?.();
  const titleRect = document.querySelector(".titlebar")?.getBoundingClientRect?.();
  const toolbarRect = document.querySelector(".terminal-toolbar")?.getBoundingClientRect?.();
  const workspaceRect = workspaceIndicator?.getBoundingClientRect?.();
  const diagnostics = pwaDiagnosticsSnapshot();
  panel.textContent = [
    `ログ ${Math.round(terminalRect?.height || 0)}px`,
    `表示領域 ${Math.round(window.visualViewport?.height || window.innerHeight)}px`,
    `入力欄 ${Math.round(composerRect?.height || 0)}px`,
    `ヘッダー ${Math.round(titleRect?.height || 0)}px`,
    `作業場所 ${Math.round(workspaceRect?.height || 0)}px`,
    `操作列 ${Math.round(toolbarRect?.height || 0)}px`,
    `表示モード ${diagnostics.displayMode}`,
    `起動URLの接続キー ${diagnostics.manifestTokenFree ? "なし" : "あり"}`,
    `ホーム画面保存 ${diagnostics.serviceWorker}`,
    `接続キー ${diagnostics.tokenAvailable ? "あり" : "なし"}`,
  ].join("\n");
}

function measureTerminalLayout() {
  if (params.get("debugViewport") !== "1" && params.get("pwaDiagnostics") !== "1") return null;
  window.requestAnimationFrame(renderViewportDebug);
  const rect = terminalTranscript?.getBoundingClientRect?.();
  return {
    terminalBodyHeight: Math.round(rect?.height || 0),
    visualViewportHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
    composerHeight: Math.round(composer?.getBoundingClientRect?.().height || 0),
  };
}

function canSuggestPwaInstall() {
  const dismissed = safeReadStorage(localStorage, pwaInstallHintStorageKey, "") === "dismissed";
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (uiUtils.canSuggestPwaInstall) {
    return uiUtils.canSuggestPwaInstall({
      mobile: isMobileViewport(),
      standalone: isStandaloneDisplayMode(),
      dismissed,
      secureContext: window.isSecureContext,
      isLocalhost,
      allowInsecureHint: location.protocol === "http:",
    });
  }
  return isMobileViewport() && !isStandaloneDisplayMode() && !dismissed;
}

function showPwaInstallHint() {
  if (!canSuggestPwaInstall() || document.querySelector(".pwa-install-hint")) return;
  const hint = document.createElement("section");
  hint.className = "pwa-install-hint";
  hint.setAttribute("role", "status");
  const hasToken = Boolean(effectiveBridgeToken(activeBridge()) || token);
  const secure = window.isSecureContext;
  // No point offering the install page to someone already standing on it.
  const showInstallLink = hasToken && !preserveEntryUrl;
  hint.innerHTML = `
    <div>
      <strong>ホーム画面に追加</strong>
      <span>${secure ? "ホーム画面版では表示領域が少し増えます。" : "ローカル接続ではホーム画面版に制限があります。通常表示はこのまま使えます。"}</span>
      <small>${showInstallLink ? "「追加用」から登録すると、接続キーの再入力が要りません。" : hasToken ? "接続キーはホーム画面の起動URLに保存しません。" : "起動できない時は接続キー付きURLで開き直してください。"}</small>
    </div>
    ${showInstallLink ? '<a class="pwa-install-open" data-pwa-install>追加用</a>' : ""}
    <button type="button" data-pwa-dismiss>閉じる</button>
  `;
  const installLink = hint.querySelector("[data-pwa-install]");
  if (installLink) installLink.href = installEntryUrl();
  hint.querySelector("[data-pwa-dismiss]")?.addEventListener("click", () => {
    safeWriteStorage(localStorage, pwaInstallHintStorageKey, "dismissed");
    hint.remove();
    resumeDeferredSwipeHint();
  });
  document.body.appendChild(hint);
  deferSwipeHint();
}

// The hint is fixed-position and has to hang below the header stack, whose
// height moves when the title wraps or the workspace strip is hidden. Publishing
// the measured bottom edge keeps the CSS off a guessed pixel offset.
function trackHeaderBlockEnd() {
  const titlebar = document.querySelector(".titlebar");
  if (!titlebar) return;
  const strip = document.querySelector(".workspace-strip");
  const update = () => {
    const anchor = sessionActivityStrip && !sessionActivityStrip.hidden && sessionActivityStrip.getBoundingClientRect().height > 0
      ? sessionActivityStrip : strip && strip.getBoundingClientRect().height > 0 ? strip : titlebar;
    const bottom = Math.round(anchor.getBoundingClientRect().bottom);
    if (bottom > 0) document.documentElement.style.setProperty("--app-header-block-end", `${bottom}px`);
  };
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(update);
    observer.observe(titlebar);
    if (strip) observer.observe(strip);
    if (sessionActivityStrip) observer.observe(sessionActivityStrip);
  }
  window.addEventListener("resize", update);
  update();
}

async function unregisterStaleServiceWorkersIfNeeded() {
  if (!("serviceWorker" in navigator)) return;
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const canRegister = Boolean(window.isSecureContext || isLocalhost);
  try {
    if (canRegister) {
      const registration = await navigator.serviceWorker.register(appPath("/service-worker.js"), { scope: appPath("/") });
      // Ask on every load rather than waiting for the browser to decide it is
      // time. A phone that has the app on its home screen is the last place a
      // stale build should be able to sit unnoticed.
      registration.update?.().catch(() => {});
      return;
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    const base = `${location.origin}${appBasePath || "/"}`;
    for (const registration of registrations) {
      const script = registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || "";
      const sameScope = registration.scope.startsWith(base) || base.startsWith(registration.scope);
      const looksLikePhoneSw = /(?:^|\/)(?:sw|service-worker)(?:[.-]|\.js|$)/i.test(new URL(script || location.href).pathname);
      if (sameScope && looksLikePhoneSw) await registration.unregister();
    }
    if (window.caches?.keys) {
      const keys = await window.caches.keys();
      await Promise.all(keys.filter((key) => /^codex-phone|^codex-remote/i.test(key)).map((key) => window.caches.delete(key)));
    }
  } catch {
    // Stale SW cleanup must not affect the normal UI.
  }
}

function homeBridgeBaseUrl() {
  return `${location.origin}${appBasePath}`;
}

function normalizeBridgeEntry(entry, options = {}) {
  if (uiUtils.normalizeBridgeEntry) return uiUtils.normalizeBridgeEntry(entry, options);
  return entry;
}

function bridgeIdFromBaseUrl(baseUrl) {
  if (uiUtils.bridgeIdFromBaseUrl) return uiUtils.bridgeIdFromBaseUrl(baseUrl);
  return String(baseUrl || "home").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "home";
}

function bridgeThreadKey(bridgeId, threadId) {
  if (uiUtils.bridgeThreadKey) return uiUtils.bridgeThreadKey(bridgeId, threadId);
  return `${bridgeId || "home"}::${threadId || "new"}`;
}

function bridgeColorFor(entry = {}) {
  return sanitizeHexColor(entry.color) || fallbackThreadColor(`bridge:${entry.id || entry.baseUrl || "home"}`);
}

function maskToken(value) {
  if (uiUtils.maskToken) return uiUtils.maskToken(value);
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function saveBridgeSessionTokens() {
  writeSessionJsonStorage(bridgeSessionTokensStorageKey, bridgeSessionTokens);
}

function saveBridgeLocalTokens() {
  writeJsonStorage(bridgeLocalTokensStorageKey, bridgeLocalTokens);
  writeJsonStorage(bridgeTokenTimesStorageKey, bridgeTokenUpdatedAt);
}

// When a token was last set, so the newest one wins a sync rather than the
// nearest one. Kept beside the tokens instead of inside them because the rest
// of the app reads bridgeLocalTokens as a plain id-to-string map.
function stampBridgeToken(bridgeId, at = Date.now()) {
  if (bridgeId) bridgeTokenUpdatedAt[bridgeId] = Number(at) || Date.now();
}

function forgetBridgeToken(bridgeId) {
  delete bridgeLocalTokens[bridgeId];
  delete bridgeTokenUpdatedAt[bridgeId];
}

function bridgeTokenRecords() {
  const records = {};
  for (const [id, value] of Object.entries(bridgeLocalTokens)) {
    if (value) records[id] = { token: String(value), updatedAt: Number(bridgeTokenUpdatedAt[id] || 0) };
  }
  return records;
}

function adoptBridgeTokenRecords(records = {}) {
  bridgeLocalTokens = {};
  bridgeTokenUpdatedAt = {};
  for (const [id, record] of Object.entries(records)) {
    if (!record?.token) continue;
    bridgeLocalTokens[id] = String(record.token);
    bridgeTokenUpdatedAt[id] = Number(record.updatedAt || 0);
  }
}

function effectiveBridgeToken(entry = {}) {
  return String(entry.token || bridgeSessionTokens[entry.id] || bridgeLocalTokens[entry.id] || (entry.id === homeBridgeId ? token || storedToken : "") || "");
}

function persistBridgeRegistry() {
  const sanitized = [];
  for (const entry of bridgeRegistry.bridges || []) {
    if (entry.token && entry.rememberToken !== false && bridgeLocalTokens[entry.id] !== String(entry.token)) {
      bridgeLocalTokens[entry.id] = String(entry.token);
      stampBridgeToken(entry.id);
    }
    if (entry.rememberToken === false) forgetBridgeToken(entry.id);
    sanitized.push({
      ...entry,
      baseUrl: uiUtils.normalizeBridgeBaseUrl ? uiUtils.normalizeBridgeBaseUrl(entry.baseUrl || "", location.origin) || entry.baseUrl : entry.baseUrl,
      token: "",
    });
  }
  bridgeRegistry = {
    version: 1,
    bridges: sanitized,
    // Carried, not rebuilt: dropping the removal records here would let the
    // next restore grow every deleted bridge back.
    deleted: Array.isArray(bridgeRegistry.deleted) ? bridgeRegistry.deleted : [],
  };
  saveBridgeLocalTokens();
  writeJsonStorage(bridgeRegistryStorageKey, bridgeRegistry);
  scheduleBridgeRegistryBackup();
}

// The registry backup lives on the bridge this app was installed from, so it
// survives the phone deleting the Home Screen icon and everything under it.
// Two rules keep the recovery from becoming its own kind of loss: nothing is
// ever pushed before a restore has succeeded, and a failed restore is not a
// restore. Anything else lets a freshly installed app - which legitimately
// knows about no machines at all - overwrite the list it came back for.
function bridgeRegistryStore() {
  return bridgeById(homeBridgeId);
}

// The service worker answers each shell file on its own and falls back to its
// cache per file, so this page can be running beside an older cached
// phone-ui-utils.js that has no merge helpers. Syncing then would mean pushing
// an unmerged list over the backup - the exact loss the restore exists to
// prevent - so a shell that cannot merge does not sync at all.
function bridgeRegistrySyncSupported() {
  return Number(uiUtils.bridgeRegistrySyncVersion || 0) >= requiredBridgeRegistrySyncVersion;
}

async function bridgeRegistryRequest(method, body = null) {
  const bridge = bridgeRegistryStore();
  if (!bridge) throw new Error("home bridge is not registered yet");
  const response = await fetchWithTimeout(urlWithBridgeToken("/api/bridge/registry", bridge), {
    method,
    headers: authHeadersForBridge(bridge, body ? { "content-type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  return { ok: response.ok, status: response.status, result };
}

// Session-only tokens are excluded by construction rather than by filtering
// later: "remember this on the device" was already the owner's answer to
// whether the token may be written down.
function bridgeRegistryTokensForBackup() {
  const tokens = {};
  for (const entry of bridgeRegistry.bridges || []) {
    if (!entry?.id || entry.rememberToken === false) continue;
    const value = bridgeLocalTokens[entry.id] || (entry.id === homeBridgeId ? storedToken || token : "");
    if (value) tokens[entry.id] = { token: String(value), updatedAt: Number(bridgeTokenUpdatedAt[entry.id] || 0) };
  }
  return tokens;
}

// Exactly what the backup carries. Connectivity, run state and the moment of
// the last poll are deliberately absent: they change every few seconds without
// the owner doing anything, and treating them as changes is what made a poll
// look like an edit.
// Normalized the way the store normalizes, so a fingerprint taken from the
// bridge's copy and one taken from this device's copy of the same entry match.
function bridgeSyncFingerprint(entry = {}) {
  return JSON.stringify([
    String(entry.id || ""),
    String(entry.baseUrl || ""),
    String(entry.name || ""),
    String(entry.label || ""),
    String(entry.group || ""),
    String(entry.kind || "lan"),
    String(entry.note || ""),
    String(entry.color || ""),
    String(entry.workdir || ""),
    Number(entry.port) || null,
    entry.rememberToken !== false,
  ]);
}

// updatedAt means "last deliberately changed", so it only moves when something
// the backup carries actually differs.
function touchBridgeEntry(previous = {}, next = {}) {
  if (bridgeSyncFingerprint(previous) === bridgeSyncFingerprint(next)) return { ...next, updatedAt: previous.updatedAt };
  return { ...next, updatedAt: Date.now() };
}

function bridgeRegistryBackupPayload() {
  return {
    revision: bridgeRegistryRevision,
    bridges: (bridgeRegistry.bridges || []).map((entry) => ({ ...entry, token: "" })),
    deleted: Array.isArray(bridgeRegistry.deleted) ? bridgeRegistry.deleted : [],
    tokens: bridgeRegistryTokensForBackup(),
  };
}

// A loopback address names whichever device reads it, so one written into the
// shared backup by the Mac's own browser - `http://127.0.0.1:45234` - arrives
// at the phone pointing at the phone, which runs no bridge. That is the second
// `mini Claude`: a row for a Mac already listed, stuck at 切断 for good because
// there is nothing at the other end to answer.
//
// Dropped on the way in rather than on the way out: the backup is the only copy
// of the list a reinstalled app has, so refusing to write these would quietly
// remove a connection someone added from the Mac itself. Here nothing is lost -
// the device that owns the address still holds it locally, and it is kept when
// it is this device's own, where it does point at the bridge serving the page.
function sharedRemoteRegistry(remote = {}) {
  const bridges = remote.bridges || [];
  const shared = bridges.filter(
    (entry) => !uiUtils.isDeviceLocalBridgeUrl(entry?.baseUrl) || uiUtils.bridgeIdFromBaseUrl(entry?.baseUrl) === homeBridgeId,
  );
  return shared.length === bridges.length ? remote : { ...remote, bridges: shared };
}

function applyRemoteBridgeRegistry(remote = {}) {
  const before = new Set((bridgeRegistry.bridges || []).map((entry) => entry.id));
  bridgeRegistry = uiUtils.mergeBridgeRegistries(bridgeRegistry, sharedRemoteRegistry(remote));
  // Merged against the surviving list, so a token cannot outlive the bridge it
  // belongs to or land on a connection the owner asked not to remember.
  adoptBridgeTokenRecords(uiUtils.mergeBridgeTokens(bridgeTokenRecords(), remote.tokens, bridgeRegistry.bridges));
  saveBridgeLocalTokens();
  writeJsonStorage(bridgeRegistryStorageKey, bridgeRegistry);
  return (bridgeRegistry.bridges || []).filter((entry) => !before.has(entry.id)).length;
}

async function restoreBridgeRegistryFromHome() {
  if (bridgeRegistryRestored) return true;
  if (bridgeRegistryRestorePromise) return bridgeRegistryRestorePromise;
  bridgeRegistryRestoreAttemptedAt = Date.now();
  bridgeRegistryRestorePromise = (async () => {
    if (!bridgeRegistrySyncSupported()) throw new Error("this app shell cannot merge a registry backup");
    const { ok, status, result } = await bridgeRegistryRequest("GET");
    if (!ok) {
      if (result?.code === "registry-unreadable") bridgeRegistryBlocked = result.error || "registry is unreadable";
      throw new Error(result?.error || `${status}`);
    }
    bridgeRegistryRevision = Number(result.revision || 0);
    // What the bridge already holds. The reconcile push below then only goes
    // out if merging actually changed something, so an app that opens, agrees
    // with the backup, and sits there writes nothing.
    bridgeRegistryPushedFingerprint = bridgeRegistryPayloadFingerprint(result);
    const restored = applyRemoteBridgeRegistry(result);
    bridgeRegistryRestored = true;
    bridgeRegistryBlocked = "";
    if (restored > 0) {
      renderFleet();
      refreshFleet({ force: true });
      showToast(`保存済みの接続先 ${restored} 件を復元しました`);
    }
    // The device may have learned about machines while the backup was
    // unreachable, so the first push after a restore is what reconciles them.
    scheduleBridgeRegistryBackup();
    return true;
  })()
    .catch((error) => {
      console.warn("bridge registry restore failed:", error?.message || error);
      return false;
    })
    .finally(() => {
      bridgeRegistryRestorePromise = null;
    });
  return bridgeRegistryRestorePromise;
}

// An installed app can stay open for days, and the restore only runs at
// startup. Without a slow re-read, a bridge deleted on another phone keeps
// being offered here for as long as this one stays on screen - it will not be
// pushed back, but it is still a machine the owner already said to forget.
async function refreshBridgeRegistryFromHome() {
  if (!bridgeRegistryRestored || bridgeRegistryBlocked || !bridgeRegistrySyncSupported()) return false;
  try {
    const { ok, result } = await bridgeRegistryRequest("GET");
    if (!ok) return false;
    const before = (bridgeRegistry.bridges || []).map((entry) => entry.id).join(",");
    bridgeRegistryRevision = Number(result.revision || 0);
    bridgeRegistryPushedFingerprint = bridgeRegistryPayloadFingerprint(result);
    applyRemoteBridgeRegistry(result);
    if ((bridgeRegistry.bridges || []).map((entry) => entry.id).join(",") !== before) {
      if (!bridgeById(activeBridgeId)) await setActiveBridge(homeBridgeId, { silent: true });
      renderFleet();
    }
    scheduleBridgeRegistryBackup();
    return true;
  } catch (error) {
    console.warn("bridge registry refresh failed:", error?.message || error);
    return false;
  }
}

function bridgeRegistryPayloadFingerprint(payload = {}) {
  return JSON.stringify([
    (payload.bridges || []).map((entry) => bridgeSyncFingerprint(entry)),
    (payload.deleted || []).map((record) => [record.id, record.deletedAt]),
    Object.entries(payload.tokens || {})
      .map(([id, record]) => [id, record?.updatedAt])
      .sort(),
  ]);
}

function scheduleBridgeRegistryBackup() {
  if (!bridgeRegistryRestored) {
    if (Date.now() - bridgeRegistryRestoreAttemptedAt >= bridgeRegistryRestoreRetryMs) restoreBridgeRegistryFromHome();
    return;
  }
  if (bridgeRegistryBackupTimer) window.clearTimeout(bridgeRegistryBackupTimer);
  bridgeRegistryBackupTimer = window.setTimeout(() => {
    bridgeRegistryBackupTimer = null;
    pushBridgeRegistryBackup();
  }, bridgeRegistryBackupDebounceMs);
}

async function pushBridgeRegistryBackup(attempt = 0) {
  if (!bridgeRegistryRestored || bridgeRegistryBlocked || !bridgeRegistrySyncSupported()) return false;
  const payload = bridgeRegistryBackupPayload();
  // Rewriting the backup with what it already holds costs a disk write and a
  // revision on every poll, and puts every remembered token back on the wire
  // for nothing.
  const fingerprint = bridgeRegistryPayloadFingerprint(payload);
  if (attempt === 0 && fingerprint === bridgeRegistryPushedFingerprint) return true;
  try {
    const { ok, status, result } = await bridgeRegistryRequest("POST", payload);
    if (ok) {
      bridgeRegistryRevision = Number(result.revision || bridgeRegistryRevision);
      bridgeRegistryPushedFingerprint = fingerprint;
      return true;
    }
    if (result?.code === "registry-unreadable") {
      // Overwriting a backup we cannot read would destroy the only copy of
      // whatever is still in it, so stop and let the owner decide. The restore
      // is reset with it, so once the owner clears the file the retry in
      // scheduleBridgeRegistryBackup picks the sync back up without a reload -
      // which an installed app rarely gets.
      bridgeRegistryBlocked = result.error || "registry is unreadable";
      bridgeRegistryRestored = false;
      bridgeRegistryPushedFingerprint = "";
      showToast("接続先のバックアップを読めません。復旧するまで保存を止めます", "warn");
      return false;
    }
    // Another device wrote first. Its copy came back with the conflict, so
    // merge both lists and try once more rather than dropping either.
    if (status === 409 && result?.current && attempt < 1) {
      bridgeRegistryRevision = Number(result.current.revision || 0);
      if (applyRemoteBridgeRegistry(result.current) > 0) renderFleet();
      return pushBridgeRegistryBackup(attempt + 1);
    }
    console.warn("bridge registry backup failed:", result?.error || status);
    return false;
  } catch (error) {
    // A push that never reached the bridge leaves the backup exactly as it
    // was, which is the safe outcome; the next change retries.
    console.warn("bridge registry backup failed:", error?.message || error);
    return false;
  }
}

function updateActiveBridgeStorage() {
  try {
    localStorage.setItem(activeBridgeStorageKey, activeBridgeId || "");
  } catch {
    // Ignore storage failures.
  }
  writeJsonStorage(bridgeViewStateStorageKey, bridgeViewState);
}

const homeBridgeId = bridgeIdFromBaseUrl(homeBridgeBaseUrl()) || "home";

function ensureHomeBridge() {
  const home = normalizeBridgeEntry(
    {
      id: homeBridgeId,
      // A seed, not a name. This used to be the phrase the sidebar shows above
      // whatever is current, written straight into the registry - so the bridge
      // serving the page appeared in the switcher under the heading's own words,
      // directly below the card already showing it. `Home bridge` is the seed
      // the refresh knows to replace with the label the bridge reports.
      label: "Home bridge",
      baseUrl: homeBridgeBaseUrl(),
      token,
      port: Number(location.port || 0) || null,
      rememberToken: Boolean(token),
    },
    { fallbackOrigin: location.origin },
  );
  if (!home) return;
  if (token && !home.rememberToken) bridgeSessionTokens[home.id] = token;
  const existing = (bridgeRegistry.bridges || []).find((bridge) => bridge.id === home.id || bridge.baseUrl === home.baseUrl);
  if (!existing) bridgeRegistry = { ...bridgeRegistry, version: 1, bridges: [home, ...(bridgeRegistry.bridges || [])] };
  else {
    bridgeRegistry = {
      ...bridgeRegistry,
      version: 1,
      bridges: (bridgeRegistry.bridges || []).map((bridge) =>
        bridge.id === existing.id ? { ...bridge, ...home, label: bridge.label || home.label, color: bridge.color || home.color } : bridge,
      ),
    };
  }
  persistBridgeRegistry();
  saveBridgeSessionTokens();
}

function bridgeById(bridgeId = activeBridgeId) {
  return (bridgeRegistry.bridges || []).find((bridge) => bridge.id === bridgeId) || null;
}

function activeBridge() {
  return bridgeById(activeBridgeId) || bridgeById(homeBridgeId) || (bridgeRegistry.bridges || [])[0] || null;
}

function getBridgeState(bridgeId = activeBridgeId) {
  const id = bridgeId || homeBridgeId;
  if (!bridgeStates.has(id)) {
    bridgeStates.set(id, {
      connected: false,
      reconnecting: false,
      runState: "connecting",
      info: null,
      status: null,
      sessionRuns: new Map(),
      sessionTitles: new Map(),
      statusRequestedAt: 0,
      threadCache: [],
      hiddenProjects: [],
      selectedThread: "",
      pendingApproval: null,
      artifactItems: [],
      unreadChat: 0,
      unreadTerminal: 0,
      lastEventAt: 0,
      lastError: "",
      currentWorkspace: { repoName: "", workspaceLocation: "", gitBranch: "" },
      workspaceFollowsSelectedThread: false,
      // A Mac the app has not opened yet still has the provider it was last
      // used with, remembered on this phone. Seeding from it means the sidebar
      // lists that Mac's Codex chats from the first refresh, instead of showing
      // its Claude chats until the connection is switched over to it.
      activeProvider: normalizeProviderName(bridgeViewState[id]?.provider) || "codex",
      threadProvider: normalizeProviderName(bridgeViewState[id]?.provider) || "",
      threadProviderExplicit: Boolean(normalizeProviderName(bridgeViewState[id]?.provider)),
    });
  }
  return bridgeStates.get(id);
}

function bridgeAbsoluteUrl(path, entry = activeBridge()) {
  const bridge = entry || activeBridge();
  if (!bridge) return appPath(path);
  const raw = String(path || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  const base = String(bridge.baseUrl || homeBridgeBaseUrl()).replace(/\/+$/, "");
  return `${base}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function urlWithBridgeToken(url, entry = activeBridge()) {
  const bridge = entry || activeBridge();
  return new URL(bridgeAbsoluteUrl(url, bridge), location.href).href;
}

function authHeadersForBridge(entry = activeBridge(), headers = {}, tokenOverride = "") {
  const bridge = entry || activeBridge();
  const next = { ...headers };
  const bridgeToken = tokenOverride || effectiveBridgeToken(bridge);
  if (bridgeToken && !next.authorization && !next.Authorization) next.authorization = `Bearer ${bridgeToken}`;
  return next;
}

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function wsProtocolsForBridge(entry = activeBridge()) {
  const bridgeToken = effectiveBridgeToken(entry);
  if (!bridgeToken) return ["phone-bridge-v1"];
  return ["phone-bridge-v1", `phone-token.${base64UrlEncode(bridgeToken)}`];
}

function wsUrlForBridge(entry = activeBridge(), provider = currentThreadProvider(), threadId = selectedThread, options = {}) {
  const target = new URL(urlWithBridgeToken("/bridge", entry));
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("provider", provider || "codex");
  if (threadId) target.searchParams.set("thread", threadId);
  if (options.fresh) target.searchParams.set("fresh", "1");
  if (options.fresh && options.newSessionId) target.searchParams.set("newSessionId", options.newSessionId);
  if (options.workdir) target.searchParams.set("workdir", options.workdir);
  if (Object.prototype.hasOwnProperty.call(options, "serviceTier") && options.serviceTier !== undefined) {
    target.searchParams.set("serviceTier", options.serviceTier || "standard");
  }
  return target.href;
}

function setBridgeToken(entry, nextToken, rememberToken = true) {
  const tokenValue = String(nextToken || "");
  if (!entry?.id) return entry;
  if (rememberToken) {
    bridgeLocalTokens[entry.id] = tokenValue;
    stampBridgeToken(entry.id);
    delete bridgeSessionTokens[entry.id];
  } else {
    forgetBridgeToken(entry.id);
    bridgeSessionTokens[entry.id] = tokenValue;
  }
  saveBridgeLocalTokens();
  saveBridgeSessionTokens();
  return { ...entry, token: "", rememberToken };
}

function setSidebarVisible(visible) {
  document.body.classList.toggle("show-sidebar", visible);
  mobileThreadsButton.setAttribute("aria-expanded", visible ? "true" : "false");
  // Opening the list is the moment the other Macs' sessions have to be current.
  if (visible) loadFleetThreads({ force: true }).catch(() => {});
}

if (manifestLink && appBasePath) {
  manifestLink.href = appPath(`/site.webmanifest?base=${encodeURIComponent(appBasePath)}`);
}

const themeOptions = [
  { id: "simple", name: "シンプル", detail: "今のCodex Desktop風" },
  { id: "cyberpunk", name: "サイバーパンク", detail: "暗め / ネオンアクセント" },
  { id: "botanical", name: "ボタニカル", detail: "葉色 / 紙のような柔らかさ" },
];
const repoColorStorageKey = "codexPhoneRepoColors:v1";
const threadDraftStorageKey = "codexPhoneThreadDrafts:v1";
const mainViewStorageKey = "codexPhoneMainView:v1";
const swipeHintStorageKey = "codexPhoneSwipeHintSeen:v1";
const terminalFontSizeStorageKey = "codexPhoneTerminalFontSize:v1";
const terminalWrapStorageKey = "codexPhoneTerminalWrap:v1";
const terminalFilterStorageKey = "codexPhoneTerminalFilter:v1";
const terminalScrollStorageKey = "codexPhoneTerminalScroll:v1";
const terminalInputModeStorageKey = "codexPhoneTerminalInputMode:v1";
const terminalQuickbarPinStorageKey = "codexPhoneTerminalQuickbarPin:v1";
const chatScrollStorageKey = "codexPhoneChatScroll:v1";
const quickActionsStorageKey = "codexPhoneQuickActions:v1";
const firstUseHintsStorageKey = "codexPhoneFirstUseHints:v1";
const terminalFocusSessionKey = "codexPhoneTerminalFocus:v1";
const pwaInstallHintStorageKey = "codexPhonePwaInstallHint:v1";
const pwaDiagnosticsStorageKey = "codexPhonePwaDiagnostics:v1";
const bridgeRegistryStorageKey = "codexPhoneBridgeRegistry:v1";
const bridgeLocalTokensStorageKey = "codexPhoneBridgeTokens:v1";
const bridgeTokenTimesStorageKey = "codexPhoneBridgeTokenTimes:v1";
const activeBridgeStorageKey = "codexPhoneActiveBridgeId:v1";
const bridgeSessionTokensStorageKey = "codexPhoneBridgeSessionTokens:v1";
const bridgeViewStateStorageKey = "codexPhoneBridgeViewState:v1";
const threadInboxFilterStorageKey = "codexPhoneThreadInboxFilter:v1";
const threadSortModeStorageKey = "codexPhoneThreadSortMode:v1";
const expandedProjectsStorageKey = "codexPhoneExpandedProjects:v1";
const collapsedProjectsStorageKey = "codexPhoneCollapsedProjects:v1";
const threadWorkdirStorageKey = "codexPhoneThreadWorkdirs:v1";
// How many chats keep a remembered folder. Only the chats that have not been
// sent to yet need one, and they stop needing it the moment they have a
// transcript, so this is far more than the phone will ever draw on.
const threadWorkdirLimit = 300;
// Not a project name, so it cannot collide with one.
const recentViewKey = "\u0000recent";
const taskTemplateStorageKey = "codexPhoneLastTaskTemplate:v1";
const serviceTierStorageKey = "codexPhoneServiceTier:v1";
const explicitModelStorageKey = "codexPhoneModelByProvider:v1";
const terminalHistoryLimit = 300;
const terminalSurfaceKinds = new Set(["command", "error", "approval", "file"]);
const threadColorPalette = [
  "#ff5d22",
  "#7c3aed",
  "#2563eb",
  "#0f766e",
  "#3f7f4b",
  "#ca8a04",
  "#dc2626",
  "#db2777",
  "#475569",
];
let selectedTheme = localStorage.getItem("codexPhoneTheme") || "simple";
let repoColorOverrides = readJsonStorage(repoColorStorageKey, {});
let threadDrafts = readJsonStorage(threadDraftStorageKey, {});
let terminalScrollPositions = readJsonStorage(terminalScrollStorageKey, {});
let chatScrollPositions = readJsonStorage(chatScrollStorageKey, {});
let firstUseHints = readJsonStorage(firstUseHintsStorageKey, {});
let bridgeRegistry = readJsonStorage(bridgeRegistryStorageKey, { version: 1, bridges: [] });
let bridgeLocalTokens = readJsonStorage(bridgeLocalTokensStorageKey, {});
let bridgeTokenUpdatedAt = readJsonStorage(bridgeTokenTimesStorageKey, {});
let bridgeViewState = readJsonStorage(bridgeViewStateStorageKey, {});
// Which folder each chat was opened in. A Claude session that has not been sent
// to yet writes no transcript, so the Mac has nothing to read its folder back
// out of: the folder lives only in the phone that picked it, and a reload or a
// bridge restart used to lose it. What the phone then dialled with was this
// bridge's own folder, and the session was opened there for real - the chat did
// not just look like it had moved, it had.
let threadWorkdirs = readJsonStorage(threadWorkdirStorageKey, {});
// Declared ahead of the first ensureHomeBridge() call, which persists the
// registry - and therefore reaches the backup scheduler - during startup.
const bridgeRegistryBackupDebounceMs = 1500;
const bridgeRegistryRestoreRetryMs = 30_000;
const bridgeRegistryRefreshMs = Number(params.get("registryRefreshMs")) || 5 * 60_000;
// Raised in step with phone-ui-utils.js when its merge behaviour changes.
const requiredBridgeRegistrySyncVersion = 1;
let bridgeRegistryRestored = false;
let bridgeRegistryRestorePromise = null;
let bridgeRegistryRestoreAttemptedAt = 0;
let bridgeRegistryRevision = 0;
let bridgeRegistryBackupTimer = null;
let bridgeRegistryBlocked = "";
let bridgeRegistryPushedFingerprint = "";
// Opening on the attention filter made a quiet moment look like a lost account:
// the list was filtered, not empty, and nothing on screen said so. Start from
// the unfiltered view and let the narrower ones be asked for.
let threadInboxFilter = localStorage.getItem(threadInboxFilterStorageKey) || "recent";
// Grouping by project is the default because it is what the list has always
// done; date order is the view that answers "what was I just doing" when the
// work is spread across several folders.
let threadSortMode = localStorage.getItem(threadSortModeStorageKey) === "recent" ? "recent" : "project";
// Which projects are showing every row. A view preference, so it stays on the
// device rather than following the bridge like the hidden list does.
// readJsonStorage is objectOnly, which would reject this array outright.
let expandedProjects = new Set(readStringListStorage(expandedProjectsStorageKey));
// Which projects are folded away to their heading. Kept apart from
// expandedProjects on purpose: that one is about the 6-row cap inside a
// project, this one is about whether the project is showing at all.
let collapsedProjects = new Set(readStringListStorage(collapsedProjectsStorageKey));
let quickActionState = uiUtils.safeJsonParse
  ? uiUtils.safeJsonParse(localStorage.getItem(quickActionsStorageKey), {}, { objectOnly: true })
  : {};
let bridgeSessionTokens = {};
try {
  bridgeSessionTokens = uiUtils.safeJsonParse
    ? uiUtils.safeJsonParse(sessionStorage.getItem(bridgeSessionTokensStorageKey), {}, { objectOnly: true })
    : {};
} catch {
  bridgeSessionTokens = {};
}

let ws = null;
let pendingApproval = null;
// What has been picked for the open question card, keyed by question text -
// the same key the tool reads its answers under.
let questionAnswerDraft = new Map();
let assistantEntry = null;
let liveOutputGroup = "";
let statusGroup = null;
let reconnectTimer = null;
let threadCache = [];
let threadListRequestId = 0;
// Which project folders the sidebar is keeping out of the list. Kept on the
// bridge rather than in this browser: it is a property of the machine's folders,
// and the same choice should hold from any phone.
let hiddenProjects = [];
let liveTurnActive = false;
let connectionReady = false;
const threadOpenFailures = new Set();
const threadOpenFailureDetails = new Map();
let pendingSubmission = null;
let pendingSubmissionTimer = null;
let lastHistorySignature = "";
let lastThreadListError = "";
let lastThreadRefreshError = "";
let lastDisplayedErrorSignature = "";
let lastDisplayedErrorAt = 0;
let lastResumeRefreshAt = 0;
let lastWsMessageAt = 0;
let selectedThreadRefreshActive = false;
let activeProvider = "codex";
let threadProvider = initialProviderParam || normalizeProviderName(selectedThread.startsWith("claude:") ? "claude" : "");
let threadProviderExplicit = Boolean(threadProvider);
let workspaceFollowsSelectedThread = Boolean(selectedThread);
const selectedThreadByProvider = new Map();
if (selectedThread && threadProvider) selectedThreadByProvider.set(threadProvider, selectedThread);
let activeDraftKey = "";
const threadDraftFiles = new Map();
let mainViewMode = localStorage.getItem(mainViewStorageKey) === "terminal" ? "terminal" : "chat";
let terminalFilterMode = localStorage.getItem(terminalFilterStorageKey) || "all";
if (terminalFilterMode !== "all" && !terminalSurfaceKinds.has(terminalFilterMode)) terminalFilterMode = "all";
let terminalSearchQuery = "";
let terminalSearchIndex = 0;
let terminalAutoScroll = true;
let terminalWrapMode = localStorage.getItem(terminalWrapStorageKey) !== "scroll";
let terminalFontSize = Math.max(10, Math.min(18, Number(localStorage.getItem(terminalFontSizeStorageKey)) || 12));
let terminalInputMode = localStorage.getItem(terminalInputModeStorageKey) === "keys" ? "keys" : "text";
let terminalQuickbarPinned = localStorage.getItem(terminalQuickbarPinStorageKey) === "1";
let terminalCommandRunning = false;
let promptInputFocused = false;
let unreadChatCount = 0;
let unreadTerminalCount = 0;
let threadSwitchBusy = false;
const terminalHistories = new Map();
let swipeStart = null;
let sidebarEdgeSwipeStart = null;
let swipeFeedbackTimer = null;
let selectedModel = localStorage.getItem("codexPhoneModel") || "";
let selectedModelLabel = localStorage.getItem("codexPhoneModelLabel") || "5.5";
// A model picked in the composer belongs to the person who picked it, and to the
// provider they picked it for. The bridge announces its own model on every
// `ready` - which arrives again on each reconnect, each thread switch and each
// return from the background - so the two are kept apart: the explicit choice is
// remembered per provider, the bridge's answer is only the fallback.
let explicitModelByProvider = readJsonStorage(explicitModelStorageKey, {});
const bridgeModelByProvider = {};
migrateLegacySelectedModel();
let selectedReasoning = localStorage.getItem("codexPhoneReasoning") || "medium";
let selectedServiceTier = localStorage.getItem(serviceTierStorageKey) || "";
let settingsRenderSeq = 0;
let artifactItems = [];
let activeArtifactPath = "";
let activeReviewTab = "summary";
let latestRateLimits = null;
let selectedExtensionView = localStorage.getItem("codexPhoneExtensionView") || "plugins";
let extensionPanelState = null;
const currentWorkspace = {
  repoName: "",
  workspaceLocation: "",
  gitBranch: "",
};
let currentHostName = "";
let currentRunState = "connecting";
let interruptRequestPending = false;
let accessMode = {
  label: "フルアクセス",
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
};
let pendingFiles = [];
const bridgeStates = new Map();
let activeBridgeId = "";
let fleetPollTimer = null;
let fleetRefreshInFlight = false;
let fleetRefreshPromise = null;
const suppressedSocketReconnects = new WeakSet();
const apiTimeoutMs = 9000;
const uploadTimeoutMs = 60_000;
const resumeRefreshDebounceMs = 1200;
const staleSocketMs = 45_000;

ensureHomeBridge();
try {
  activeBridgeId = params.get("bridge") || localStorage.getItem(activeBridgeStorageKey) || homeBridgeId;
} catch {
  activeBridgeId = params.get("bridge") || homeBridgeId;
}
if (!bridgeById(activeBridgeId)) activeBridgeId = homeBridgeId;
// The provider in the launch URL belongs to the icon that was tapped, so it
// seeds the Mac that icon opens and nothing else. Carrying it into every switch
// made the drawer answer as the icon's provider on every Mac at once, which is
// the opposite of the point: each Mac keeps its own choice.
const launchProviderBridgeId = initialProviderParam ? activeBridgeId : "";
token = effectiveBridgeToken(activeBridge()) || token;
getBridgeState(activeBridgeId).selectedThread = selectedThread;
// Usually joins the attempt ensureHomeBridge() already started, and covers the
// case where it returned early. Either way the first await hands control back,
// so the rest of this module - including the DOM bindings renderFleet() needs -
// is evaluated before any restored bridge reaches the screen.
restoreBridgeRegistryFromHome();

function sanitizeHexColor(value) {
  if (uiUtils.sanitizeHexColor) return uiUtils.sanitizeHexColor(value);
  const text = String(value || "").trim();
  const match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return "";
  if (match[1].length === 6) return `#${match[1].toLowerCase()}`;
  return `#${match[1]
    .split("")
    .map((char) => `${char}${char}`)
    .join("")
    .toLowerCase()}`;
}

function hashString(value) {
  if (uiUtils.hashString) return uiUtils.hashString(value);
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackThreadColor(key) {
  if (uiUtils.fallbackThreadColor) return uiUtils.fallbackThreadColor(key, threadColorPalette);
  return threadColorPalette[hashString(key || "thread") % threadColorPalette.length];
}

function contrastColorFor(hex) {
  if (uiUtils.contrastColorFor) return uiUtils.contrastColorFor(hex);
  const color = sanitizeHexColor(hex) || "#000000";
  const r = Number.parseInt(color.slice(1, 3), 16) / 255;
  const g = Number.parseInt(color.slice(3, 5), 16) / 255;
  const b = Number.parseInt(color.slice(5, 7), 16) / 255;
  const linear = [r, g, b].map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.58 ? "#141414" : "#ffffff";
}

function threadColorKeyFor(thread) {
  const provider = normalizeProviderName(thread?.provider) || currentThreadProvider();
  const bridgePrefix = activeBridgeId || homeBridgeId || "home";
  if (thread?.id) return `${bridgePrefix}:${provider}:thread:${thread.id}`;
  const cwd = String(thread?.cwd || currentWorkspace.workspaceLocation || "").trim();
  if (cwd) return `${bridgePrefix}:${provider}:new:${cwd}`;
  return `${bridgePrefix}:${provider}:new:${location.host}${appBasePath || "/"}`;
}

function currentThreadColorKey() {
  const selected = threadCache.find((thread) => thread.id === selectedThread);
  if (selected) return threadColorKeyFor(selected);
  return threadColorKeyFor({
    id: selectedThread,
    provider: currentThreadProvider(),
    cwd: currentWorkspace.workspaceLocation || currentWorkspace.repoName || "",
  });
}

function repoColorKeyForContext(context = {}) {
  const workspace =
    workspaceKeyForThread(context) ||
    String(context?.cwd || context?.workdir || context?.workspaceLocation || currentWorkspace.workspaceLocation || currentWorkspace.repoName || "").trim();
  const repo = String(context?.repoName || "").trim();
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() || "";
  const project = projectForThread(context);
  const projectName = project && project !== "No project" ? project : "";
  const keyBase = repo || workspaceName || projectName || currentWorkspace.repoName || `${location.host}${appBasePath || "/"}`;
  return `repo:${keyBase}`;
}

function repoLabelForContext(context = {}, fallback = "このリポ") {
  const repoName = String(context?.repoName || "").trim();
  if (repoName) return repoName;
  const project = projectForThread(context);
  if (project && project !== "No project") return project;
  return currentWorkspace.repoName || fallback;
}

function currentRepoColorKey() {
  const selected = threadCache.find((thread) => thread.id === selectedThread);
  if (selected) return repoColorKeyForContext(selected);
  return repoColorKeyForContext({
    provider: currentThreadProvider(),
    cwd: currentWorkspace.workspaceLocation || currentWorkspace.repoName || "",
    repoName: currentWorkspace.repoName,
  });
}

function repoColorForKey(key) {
  return sanitizeHexColor(repoColorOverrides[key]) || fallbackThreadColor(key);
}

// Paints a machine label in that machine's colour. The mini and the Air are
// named in CSS, so they follow the theme and match their app icons; anything
// else takes a stable colour from the palette so a third Mac still reads apart.
function applyMachineAccent(element, machineLabel = "", machineKey = "") {
  const identity = String(machineKey || machineLabel || "");
  const token = uiUtils.machineAccentToken ? uiUtils.machineAccentToken(identity) : "";
  if (token) element.dataset.machine = token;
  else if (identity) element.style.setProperty("--machine-color", fallbackThreadColor(`machine:${identity.toLowerCase()}`));
}

function repoColorForThread(thread) {
  return repoColorForKey(repoColorKeyForContext(thread));
}

function setRepoColorOverride(key, color) {
  const sanitized = sanitizeHexColor(color);
  if (!key || !sanitized) return;
  repoColorOverrides = { ...repoColorOverrides, [key]: sanitized };
  writeJsonStorage(repoColorStorageKey, repoColorOverrides);
  applyCurrentThreadAccent();
  renderThreadList();
  renderTerminalTranscript();
}

function resetRepoColorOverride(key) {
  if (!key || !Object.prototype.hasOwnProperty.call(repoColorOverrides, key)) return;
  const next = { ...repoColorOverrides };
  delete next[key];
  repoColorOverrides = next;
  writeJsonStorage(repoColorStorageKey, repoColorOverrides);
  applyCurrentThreadAccent();
  renderThreadList();
  renderTerminalTranscript();
}

function applyCurrentThreadAccent() {
  const key = currentRepoColorKey();
  const color = repoColorForKey(key);
  const contrast = contrastColorFor(color);
  document.documentElement.style.setProperty("--thread-accent", color);
  document.documentElement.style.setProperty("--thread-accent-contrast", contrast);
  document.documentElement.style.setProperty("--thread-accent-soft", `color-mix(in srgb, ${color} 12%, transparent)`);
  document.documentElement.style.setProperty("--thread-accent-ring", `color-mix(in srgb, ${color} 42%, transparent)`);
  document.documentElement.dataset.threadColorMode = repoColorOverrides[key] ? "custom" : "auto";
  document.documentElement.dataset.repoColorMode = repoColorOverrides[key] ? "custom" : "auto";
  if (headerThreadColorButton) {
    headerThreadColorButton.style.backgroundColor = color;
    headerThreadColorButton.style.color = contrast;
    headerThreadColorButton.title = `リポ色: ${repoColorOverrides[key] ? "カスタム" : "自動"} ${color}`;
  }
}

const runStateText = {
  connecting: "接続中",
  ready: "未実行・送信できます",
  running: "処理中",
  streaming: "回答生成中",
  approval: "承認待ち",
  question: "返信待ち",
  interrupting: "中断中",
  interrupted: "中断しました",
  syncing: "履歴同期中",
  done: "完了しました",
  disconnected: "切断",
  error: "エラー",
};
const interruptibleRunStates = new Set(["running", "streaming", "approval", "interrupting"]);
const terminalRunStates = new Set(["ready", "question", "done", "interrupted", "disconnected", "error"]);

function runStateShortLabel(state = currentRunState) {
  if (state === "approval") return "承認待ち";
  if (state === "question") return "返信待ち";
  if (state === "running" || state === "streaming" || state === "syncing" || state === "interrupting") return "稼働中";
  if (state === "connecting") return "接続中";
  if (state === "disconnected") return "切断";
  if (state === "error") return "エラー";
  return "待機中";
}

function threadStatusRuntime() {
  const state = getBridgeState(activeBridgeId);
  return {
    selectedThread,
    currentRunState,
    pendingApproval,
    bridgeRuns: Array.isArray(state.status?.bridges) ? state.status.bridges : [],
    terminalEntries: currentTerminalHistory(),
  };
}

function deriveThreadStatus(thread) {
  if (uiUtils.deriveThreadStatus) return uiUtils.deriveThreadStatus(thread, threadStatusRuntime());
  if (thread.id === selectedThread && pendingApproval) return { key: "approval_required", label: "承認待ち", tone: "approval", group: "attention", priority: 100 };
  if (thread.id === selectedThread && ["running", "streaming"].includes(currentRunState)) return { key: "running", label: "実行中", tone: "running", group: "running", priority: 60 };
  return { key: "recent", label: "最近", tone: "recent", group: "recent", priority: 20 };
}

function sortThreadsForInbox(threads) {
  if (uiUtils.sortThreadsForInbox) return uiUtils.sortThreadsForInbox(threads, threadStatusRuntime());
  return [...threads].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function threadMatchesInboxFilter(thread) {
  const status = deriveThreadStatus(thread);
  if (threadInboxFilter === "attention") return status.group === "attention";
  if (threadInboxFilter === "running") return status.group === "running";
  return true;
}

function setThreadInboxFilter(value) {
  threadInboxFilter = value || "recent";
  localStorage.setItem(threadInboxFilterStorageKey, threadInboxFilter);
  renderThreadList();
}

// What the narrow filters are keeping out of the list, counted the way the list
// itself counts: a search already in the box still applies, so the number is
// what clearing the filter would actually reveal. The selected thread shows
// under every filter, so it is never something being held back.
function threadsHiddenByInboxFilter() {
  if (threadInboxFilter === "recent") return 0;
  const query = threadSearch.value.trim().toLowerCase();
  // Counted across the same set the list draws from, which is every registered
  // bridge, so the number matches what clearing the filter puts on screen.
  return fleetThreadRecords().filter((thread) => {
    if (thread.id === selectedThread && isActiveBridgeThread(thread)) return false;
    if (
      query &&
      !projectForThread(thread).toLowerCase().includes(query) &&
      !titleForThread(thread).toLowerCase().includes(query) &&
      !String(thread.machineLabel || "").toLowerCase().includes(query)
    ) {
      return false;
    }
    return !threadMatchesInboxFilter(thread);
  }).length;
}

// Marks the provider the list is showing. Nothing else in the drawer said
// which of the two it was, and a Codex list and a Claude list of the same Mac
// read as the same screen.
function renderThreadProviderTabs() {
  const provider = currentThreadProvider();
  for (const button of threadProviderTabButtons) {
    const active = normalizeProviderName(button.dataset.threadProvider) === provider;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function renderThreadInboxTabs() {
  renderThreadProviderTabs();
  for (const button of threadInboxTabButtons) {
    const active = button.dataset.threadFilter === threadInboxFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const button of threadSortTabButtons) {
    const active = button.dataset.threadSort === threadSortMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function updateUnreadBadges() {
  for (const [badge, count] of [
    [chatUnreadBadge, unreadChatCount],
    [terminalUnreadBadge, unreadTerminalCount],
    [bottomNavChatBadge, unreadChatCount],
    [bottomNavTerminalBadge, unreadTerminalCount],
  ]) {
    if (!badge) continue;
    badge.textContent = count > 9 ? "9+" : count ? String(count) : "";
    badge.classList.toggle("hidden", !count);
  }
}

// The bar mirrors controls that already exist in the titlebar rather than
// owning behaviour of its own, so there is one implementation of each action
// and the two stay in step by construction.
function syncBottomNav() {
  if (!bottomNav) return;
  const approvalPending = Boolean(pendingApproval);
  for (const item of bottomNav.querySelectorAll(".bottom-nav-item")) {
    const nav = item.dataset.nav;
    const current = (nav === "chat" && mainViewMode === "chat") || (nav === "terminal" && mainViewMode === "terminal");
    if (current) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
    if (nav === "approval") {
      item.dataset.pending = String(approvalPending);
      item.disabled = !approvalPending;
    }
    if (nav === "commands" && commandSheet && !commandSheet.classList.contains("hidden")) {
      item.setAttribute("aria-current", "page");
    }
  }
  if (bottomNavChatLabel && chatViewLabel) bottomNavChatLabel.textContent = chatViewLabel.textContent || "チャット";
  if (bottomNavApprovalBadge) {
    bottomNavApprovalBadge.textContent = approvalPending ? "1" : "";
    bottomNavApprovalBadge.classList.toggle("hidden", !approvalPending);
  }
}

// The list Claude reported for this session. Empty until the first turn of a
// fresh bridge has opened, which is why the sheet says so rather than looking
// broken.
let slashCommands = [];

function setSlashCommands(next) {
  if (!Array.isArray(next)) return;
  slashCommands = next;
  if (commandSheet && !commandSheet.classList.contains("hidden")) renderCommandList();
  syncBottomNav();
}

const commandKindLabels = { builtin: "組み込み", skill: "スキル", plugin: "プラグイン" };

function renderCommandList() {
  if (!commandList) return;
  const query = String(commandSearch?.value || "").trim().toLowerCase();
  const matches = slashCommands.filter(
    (command) => !query || command.name.toLowerCase().includes(query) || String(command.description || "").toLowerCase().includes(query),
  );
  commandList.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "command-empty";
    empty.textContent = slashCommands.length
      ? "一致するコマンドはありません"
      : currentThreadProvider() === "claude"
        ? "コマンドは最初のやり取りのあとに読み込まれます"
        : "このチャットにコマンドはありません";
    commandList.appendChild(empty);
    return;
  }
  let lastKind = "";
  for (const command of matches) {
    if (command.kind !== lastKind) {
      lastKind = command.kind;
      const heading = document.createElement("div");
      heading.className = "command-group";
      heading.textContent = commandKindLabels[command.kind] || command.kind;
      commandList.appendChild(heading);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "command-item";
    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = `/${command.name}`;
    item.appendChild(name);
    if (command.description) {
      const description = document.createElement("span");
      description.className = "command-description";
      description.textContent = command.description;
      item.appendChild(description);
    }
    // Inserted rather than sent: several take an argument, and a command fired
    // straight off the list would rule that out.
    item.addEventListener("click", () => {
      insertPromptText(`/${command.name} `);
      toggleCommandSheet(false);
      promptInput?.focus();
    });
    commandList.appendChild(item);
  }
}

function toggleCommandSheet(open) {
  if (!commandSheet) return;
  const willOpen = open ?? commandSheet.classList.contains("hidden");
  commandSheet.classList.toggle("hidden", !willOpen);
  bottomNav?.querySelector('[data-nav="commands"]')?.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    renderCommandList();
    commandList.scrollTop = 0;
  } else if (commandSearch) {
    commandSearch.value = "";
  }
  syncBottomNav();
}

commandSearch?.addEventListener("input", renderCommandList);
commandSheetClose?.addEventListener("click", () => toggleCommandSheet(false));

function revealPendingApproval() {
  if (!pendingApproval) return;
  if (mainViewMode !== "chat") chatViewButton?.click();
  const target = approval && !approval.classList.contains("hidden") ? approval : document.querySelector("#approvalStrip");
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

bottomNav?.addEventListener("click", (event) => {
  const item = event.target.closest(".bottom-nav-item");
  if (!item || item.disabled) return;
  switch (item.dataset.nav) {
    case "chat":
      chatViewButton?.click();
      break;
    case "terminal":
      terminalViewButton?.click();
      break;
    case "approval":
      revealPendingApproval();
      break;
    case "threads":
      mobileThreadsButton?.click();
      break;
    case "commands":
      toggleCommandSheet();
      return;
    default:
      break;
  }
  syncBottomNav();
});

function currentThreadIndexInfo() {
  const threads = visibleThreadsInListOrder();
  if (!threads.length) return { label: selectedThread ? "1/1" : "新規", index: -1, total: 0 };
  const index = threads.findIndex((thread) => thread.id === selectedThread);
  if (index < 0) return { label: selectedThread ? `?/${threads.length}` : `新規/${threads.length}`, index: -1, total: threads.length };
  return { label: `${index + 1}/${threads.length}`, index, total: threads.length };
}

function updateHeaderStatus() {
  renderBridgePillAgent();
  if (!threadPositionPill || !threadPositionText || !threadStateText) return;
  const info = currentThreadIndexInfo();
  threadPositionText.textContent = info.label;
  threadStateText.textContent = threadSwitchBusy ? "切替中" : runStateShortLabel();
  threadPositionPill.dataset.state = threadSwitchBusy ? "switching" : currentRunState;
  threadPositionPill.disabled = !threadCache.length;
}

function updateComposerState() {
  const state = currentRunState;
  composer.dataset.runState = state;
  if (state === "approval") {
    promptInput.placeholder = questionsForApproval(pendingApproval || {}).length ? "上の質問に回答してください" : "承認リクエストに対応してください";
  }
  else if (state === "running" || state === "streaming" || state === "syncing") {
    promptInput.placeholder = "実行中です。追加指示は必要なら送信できます";
  } else if (state === "connecting" || state === "disconnected") {
    promptInput.placeholder = "接続後にフォローアップを送信できます";
  } else promptInput.placeholder = "フォローアップの変更を求める";
  if (sendLabel) {
    if (pendingSubmission) sendLabel.textContent = "送信中";
    else sendLabel.textContent = mainViewMode === "terminal" ? (state === "approval" ? "承認へ" : state === "disconnected" ? "切断" : state === "running" || state === "streaming" ? "送信" : "Enter ↵") : "送信";
  }
  syncBottomNav();
  // Every run-state change lands here, which is where a hidden composer has to
  // come back: an approval, a question, or a turn that started while the reader
  // was somewhere up the page.
  refreshReadingMode();
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function updateTerminalHeader() {
  if (!terminalStatusTitle || !terminalSessionMeta) return;
  terminalStatusTitle.textContent = `${providerLabel(currentThreadProvider())} Terminal`;
  const connected = connectionReady && ws?.readyState === WebSocket.OPEN;
  const pieces = [
    connected ? "接続済み" : currentRunState === "connecting" ? "接続中" : "切断",
    selectedThread ? shortId(selectedThread) : "新しいチャット",
    selectedModel || selectedModelLabel,
    accessMode.label,
  ].filter(Boolean);
  terminalSessionMeta.textContent = pieces.join(" / ");
  mainTerminalView.dataset.state = currentRunState;
}

function applyTerminalDisplaySettings() {
  document.documentElement.style.setProperty("--terminal-font-size", `${terminalFontSize}px`);
  document.body.classList.toggle("terminal-nowrap", !terminalWrapMode);
  terminalWrapToggle?.classList.toggle("active", terminalWrapMode);
  terminalWrapToggle?.setAttribute("aria-pressed", String(terminalWrapMode));
}

function setTerminalFontSize(nextSize) {
  terminalFontSize = Math.max(10, Math.min(18, Number(nextSize) || 12));
  localStorage.setItem(terminalFontSizeStorageKey, String(terminalFontSize));
  applyTerminalDisplaySettings();
}

function setTerminalFocusMode(enabled) {
  document.body.classList.toggle("terminal-focus-mode", enabled);
  document.body.classList.toggle("app--terminal-max", enabled);
  try {
    sessionStorage.setItem(terminalFocusSessionKey, enabled ? "1" : "0");
  } catch {
    // Transient only.
  }
  toggleTerminalToolsSheet(false);
  if (enabled) {
    closeRightPanel();
    setSidebarVisible(false);
    terminalFocusButton?.setAttribute("aria-label", "Terminal拡大表示を閉じる");
    terminalFocusButton.textContent = "戻す";
    if (terminalMaxSheetButton) terminalMaxSheetButton.textContent = "元に戻す";
    mainTerminalView?.focus?.({ preventScroll: true });
    showToast("Terminalを拡大表示しました。");
  } else if (terminalFocusButton) {
    terminalFocusButton.setAttribute("aria-label", "Terminalを拡大表示");
    terminalFocusButton.textContent = "拡大";
    if (terminalMaxSheetButton) terminalMaxSheetButton.textContent = "最大化";
  }
  updateQuickBarVisibility();
  measureTerminalLayout();
}

function updateInterruptButton() {
  if (!interruptButton) return;
  const visible = interruptibleRunStates.has(currentRunState);
  const disabled =
    !visible || currentRunState === "interrupting" || interruptRequestPending || !ws || ws.readyState !== WebSocket.OPEN;
  let label = "現在の処理を中断";
  if (visible && (currentRunState === "interrupting" || interruptRequestPending)) label = "中断要求を送信中です";
  else if (visible && (!ws || ws.readyState !== WebSocket.OPEN)) label = "接続後に処理を中断";
  interruptButton.classList.toggle("hidden", !visible);
  interruptButton.disabled = disabled;
  interruptButton.title = label;
  interruptButton.setAttribute("aria-label", label);
}

function setRunState(state, label) {
  if (!runState || !runStateLabel) return;
  if (state === "ready" && !connectionReady && threadOpenFailures.has(currentThreadColorKey())) {
    state = "error";
    label = "会話を開けません";
  }
  const nextLabel = label || runStateText[state] || state;
  currentRunState = state;
  if (terminalRunStates.has(state)) interruptRequestPending = false;
  if (runState.dataset.state !== state || runStateLabel.textContent !== nextLabel) {
    runState.dataset.state = state;
    runStateLabel.textContent = nextLabel;
  }
  updateInterruptButton();
  updateThreadNavigation();
  updateHeaderStatus();
  updateComposerState();
  updateTerminalHeader();
  const bridgeState = getBridgeState(activeBridgeId);
  bridgeState.runState = state;
  bridgeState.lastEventAt = Date.now();
  if (selectedThread && ["running", "streaming", "approval", "question", "syncing", "interrupting", "done", "interrupted"].includes(state)) {
    const key = `${currentThreadProvider()}:${selectedThread}`;
    const previous = bridgeState.sessionRuns.get(key);
    bridgeState.sessionRuns.set(key, {
      threadId: selectedThread, provider: currentThreadProvider(),
      workdir: selectedThreadWorkdir("") || currentWorkspaceWorkdir(), observedAt: Date.now(),
      run: { ...previous?.run, state, updatedAt: previous?.run?.state === state ? previous.run.updatedAt : Date.now(), pendingApproval: state === "approval" ? pendingApproval || previous?.run?.pendingApproval : null },
    });
  }
  renderFleet();
  renderThreadList();
  refreshReviewCenterIfOpen();
  syncLogEmptyState();
}

function applyServerRunState(run = {}) {
  if (selectedThread) {
    getBridgeState().sessionRuns.set(`${currentThreadProvider()}:${selectedThread}`, {
      threadId: selectedThread, provider: currentThreadProvider(), run: { ...run },
      workdir: selectedThreadWorkdir("") || currentWorkspaceWorkdir(), observedAt: Date.now(),
    });
  }
  const state = run.state || "ready";
  if (terminalRunStates.has(state)) interruptRequestPending = false;
  if (state !== "approval" && pendingApproval) {
    pendingApproval = null;
    getBridgeState().pendingApproval = null;
    questionAnswerDraft = new Map();
    approval.classList.add("hidden");
    renderApprovalStrip(null);
  }
  // The bridge holds the open question, so a phone that reloaded or dropped its
  // socket while one was waiting gets the card back with the run state instead
  // of watching a spinner it cannot answer.
  if (state === "approval" && run.pendingApproval && run.pendingApproval.id !== pendingApproval?.id) {
    pendingApproval = run.pendingApproval;
    getBridgeState().pendingApproval = run.pendingApproval;
    renderApprovalRequest(run.pendingApproval);
  }
  const activeStates = new Set(["running", "streaming", "approval", "syncing", "interrupting"]);
  liveTurnActive = activeStates.has(state);
  if (liveTurnActive && run.turnId) liveOutputGroup = run.turnId;
  if (!liveTurnActive && (state === "done" || state === "ready" || state === "interrupted" || state === "error")) {
    assistantEntry = null;
    if (state !== "streaming") liveOutputGroup = "";
  }
  setRunState(state, run.label);
}

function applyTheme(themeId) {
  const nextTheme = themeOptions.some((theme) => theme.id === themeId) ? themeId : "simple";
  selectedTheme = nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("codexPhoneTheme", nextTheme);
}

applyTheme(selectedTheme);

const accessModes = [
  { label: "フルアクセス", approvalPolicy: "never", sandboxMode: "danger-full-access" },
  { label: "確認モード", approvalPolicy: "on-request", sandboxMode: "workspace-write" },
  { label: "読み取り専用", approvalPolicy: "on-request", sandboxMode: "read-only" },
];
// The level is kept under the provider's own name (`low` ... `ultra`) rather
// than a four-step code of our own, because that code had to be mapped back and
// the top step was labelled "最大" while mapping to `xhigh` -- neither provider's
// maximum. The old codes are still read so a stored choice survives.
const reasoningAliases = new Map([
  ["L", "low"],
  ["LOW", "low"],
  ["低", "low"],
  ["M", "medium"],
  ["MEDIUM", "medium"],
  ["中", "medium"],
  ["H", "high"],
  ["HIGH", "high"],
  ["高", "high"],
  ["XH", "xhigh"],
  ["XHIGH", "xhigh"],
  ["EXTRA HIGH", "xhigh"],
  ["EXTRA-HIGH", "xhigh"],
  ["非常に高", "xhigh"],
  ["MAX", "max"],
  ["ULTRA", "ultra"],
]);
// Only for a bridge that has not answered yet. The levels a model really takes
// come from `model/list` by way of the bridge, so a model with `ultra` offers it
// without a release of this page.
const fallbackReasoningChoices = {
  codex: ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};
// Deepest last. Used to pick the closest level a model does have when the one
// that was chosen is not on its list.
const reasoningDepthOrder = ["low", "medium", "high", "xhigh", "max", "ultra"];
const reasoningChoicesByBridge = new Map();
const serviceTierAliases = new Map([
  ["", ""],
  ["STANDARD", ""],
  ["NORMAL", ""],
  ["FLEX", ""],
  ["FAST", "fast"],
]);
// Only what the menu shows before a bridge has answered. The bridge reports the
// models its account actually has, and that list replaces these.
const inlineModelChoices = {
  codex: ["gpt-5.6-sol", "gpt-5.5"],
  claude: ["sonnet", "opus", "haiku"],
};
let liveModelChoices = {};

// The bridge's `modelChoices` follows the app-server's own list, so a model
// that reaches the account shows up here the next time Codex runs, with no
// release of this page. Kept per provider and refreshed on every bridge answer.
function adoptModelChoices(choices) {
  if (!choices || typeof choices !== "object") return;
  const next = {};
  for (const [provider, list] of Object.entries(choices)) {
    const key = normalizeProviderName(provider);
    const models = (Array.isArray(list) ? list : []).map((item) => String(item || "").trim()).filter(Boolean);
    if (key && models.length) next[key] = models;
  }
  if (!Object.keys(next).length) return;
  liveModelChoices = { ...liveModelChoices, ...next };
  if (typeof updateModelButton === "function" && modelMenu) updateModelButton();
}

// The bridge reports the levels each model advertises, so the menu names them
// the way the model does instead of guessing a fixed set.
function adoptReasoningChoices(choices, { bridgeId = activeBridgeId } = {}) {
  if (!choices || typeof choices !== "object") return;
  const previous = reasoningChoicesByBridge.get(bridgeId) || {};
  // A partial reconnect answer must not erase model capabilities already
  // learned from this Mac, or borrow those of the other Mac.
  const byModel = { ...previous.byModel };
  for (const [model, levels] of Object.entries(choices.byModel || {})) {
    if (Array.isArray(levels) && levels.length) byModel[model] = levels;
  }
  reasoningChoicesByBridge.set(bridgeId, { ...previous, ...choices, byModel });
  if (bridgeId === activeBridgeId && typeof updateModelButton === "function" && modelMenu) updateModelButton();
}

function reasoningChoicesForModel(provider, model) {
  const liveReasoningChoices = reasoningChoicesByBridge.get(activeBridgeId) || {};
  const known = liveReasoningChoices.byModel?.[String(model || "").trim()];
  if (Array.isArray(known) && known.length) return known;
  const perProvider = liveReasoningChoices[provider];
  if (Array.isArray(perProvider) && perProvider.length) return perProvider;
  return fallbackReasoningChoices[provider] || fallbackReasoningChoices.codex;
}

// A level the model does not have would be dropped on the way through, leaving
// the turn on the Codex config's default -- the silent miss this replaces. The
// closest level at or below the choice is used instead, and it is what the menu
// then shows, so the button never claims a depth the turn will not run at.
function nearestSupportedReasoning(requested, choices) {
  if (!choices.length) return requested;
  if (choices.includes(requested)) return requested;
  const wanted = reasoningDepthOrder.indexOf(requested);
  const ranked = choices.filter((name) => reasoningDepthOrder.includes(name)).sort((a, b) => reasoningDepthOrder.indexOf(a) - reasoningDepthOrder.indexOf(b));
  if (wanted < 0 || !ranked.length) return choices[0];
  const below = ranked.filter((name) => reasoningDepthOrder.indexOf(name) <= wanted);
  return below.length ? below[below.length - 1] : ranked[0];
}

function normalizeReasoning(value) {
  const key = String(value || "").trim();
  if (reasoningDepthOrder.includes(key.toLowerCase())) return key.toLowerCase();
  return reasoningAliases.get(key) || reasoningAliases.get(key.toUpperCase()) || "medium";
}

function normalizeServiceTier(value) {
  const key = String(value || "").trim();
  return serviceTierAliases.get(key) ?? serviceTierAliases.get(key.toUpperCase()) ?? "";
}

selectedReasoning = normalizeReasoning(selectedReasoning);
localStorage.setItem("codexPhoneReasoning", selectedReasoning);
selectedServiceTier = normalizeServiceTier(selectedServiceTier);
localStorage.setItem(serviceTierStorageKey, selectedServiceTier);

function labelForModel(model) {
  const label = String(model || "").replace(/^GPT-/, "").replace(/^gpt-/, "");
  return label || "model";
}

function displayModelName(model) {
  const value = String(model || "");
  if (/^gpt-/i.test(value)) return value.toUpperCase();
  if (/^claude-/i.test(value)) return value.replace(/-/g, " ");
  return value ? value[0].toUpperCase() + value.slice(1) : "Model";
}

// `persist` is what separates the two callers: a model the person chose is
// stored against its provider and outlives every reconnect, while the model the
// bridge reports is only remembered until it reports another one.
function setSelectedModel(model, { persist = true, provider = currentThreadProvider() } = {}) {
  const value = String(model || "");
  const scope = normalizeProviderName(provider) || currentThreadProvider();
  if (persist) {
    if (value) explicitModelByProvider = { ...explicitModelByProvider, [scope]: value };
    else {
      const next = { ...explicitModelByProvider };
      delete next[scope];
      explicitModelByProvider = next;
    }
    writeJsonStorage(explicitModelStorageKey, explicitModelByProvider);
  } else {
    bridgeModelByProvider[scope] = value;
  }
  applySelectedModel(scope);
}

// The one place the effective model is decided, so the button, the terminal
// header and the next prompt cannot disagree about it.
function applySelectedModel(provider = currentThreadProvider()) {
  const scope = normalizeProviderName(provider) || currentThreadProvider();
  selectedModel = String(explicitModelByProvider[scope] || bridgeModelByProvider[scope] || "");
  selectedModelLabel = labelForModel(selectedModel);
  localStorage.setItem("codexPhoneModel", selectedModel);
  localStorage.setItem("codexPhoneModelLabel", selectedModelLabel);
  updateModelButton();
  updateTerminalHeader();
}

// Carries a choice made before models were remembered per provider. A Codex
// model name never applied to Claude, so it is filed by the name it carries.
function migrateLegacySelectedModel() {
  if (Object.keys(explicitModelByProvider).length) return;
  const legacy = String(localStorage.getItem("codexPhoneModel") || "").trim();
  if (!legacy) return;
  explicitModelByProvider = { [/^gpt-/i.test(legacy) ? "codex" : "claude"]: legacy };
  writeJsonStorage(explicitModelStorageKey, explicitModelByProvider);
}

// Codex calls it reasoning, Claude calls it effort, and both are chosen from the
// same four-step menu.
function providerSupportsReasoning() {
  return activeProvider === "codex" || activeProvider === "claude";
}

// Both providers take the level by name, so there is nothing left to translate.
// The bridge validates it again, because `claude --effort` and the app-server
// both accept an unknown value and quietly ignore it.
function effortForSubmission() {
  const lab = activeLabInfo();
  if (lab) return lab.effort;
  const provider = currentThreadProvider();
  if (!provider) return undefined;
  const choices = reasoningChoicesForModel(provider, selectedModel);
  return nearestSupportedReasoning(normalizeReasoning(selectedReasoning), choices);
}

function providerSupportsServiceTier() {
  return activeProvider === "codex";
}

function normalizeProviderName(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "codex" || value === "claude") return value;
  return "";
}

function currentThreadProvider() {
  return normalizeProviderName(threadProvider || activeProvider) || "codex";
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

// Which agent this chat is talking to, on the chip that is always on screen.
// The thread list and the chat tab both name it, and neither is in view while a
// reply is being read - so the header said which Mac and which folder the work
// was in, and never who was doing it, on two Macs that each run both.
function renderBridgePillAgent() {
  if (!bridgePillAgent) return;
  const label = providerLabel(currentThreadProvider());
  bridgePillAgent.textContent = label;
  if (bridgePill) bridgePill.setAttribute("aria-label", `接続先を切り替え（${label}）`);
}

// A bridge used to serve exactly one provider, so its own answer had to win: a
// stored choice it could not serve kept asking for the impossible and the
// connection never settled. A bridge now serves both, chosen per chat, and its
// startup provider is only where a Mac begins. So an explicit choice — the
// icon's provider, the settings switch, or the one remembered for this Mac —
// survives, and the bridge's answer wins only where it is the one provider that
// bridge lists. Without this, every switch between Macs snapped both of them
// back to whichever provider they had started with.
function adoptBridgeProvider(provider, servedProviders = []) {
  const next = normalizeProviderName(provider);
  if (!next) return;
  const served = (Array.isArray(servedProviders) ? servedProviders : []).map(normalizeProviderName).filter(Boolean);
  const current = currentThreadProvider();
  if (threadProviderExplicit && current && (!served.length || served.includes(current))) {
    setActiveProvider(current);
    return;
  }
  if (threadProvider && threadProvider !== next) {
    threadProvider = next;
    threadProviderExplicit = false;
  }
  setActiveProvider(next);
}

async function syncProviderFromBridge() {
  const bridgeId = activeBridgeId;
  try {
    const info = await apiGet("/api/info");
    if (bridgeId !== activeBridgeId) return;
    adoptBridgeProvider(info?.provider, info?.providers);
    adoptModelChoices(info?.modelChoices);
    adoptReasoningChoices(info?.reasoningChoices);
  } catch {
    // Falls back to whatever the thread list reports once it loads.
  }
}

function setActiveProvider(provider) {
  const previousProvider = activeProvider;
  activeProvider = normalizeProviderName(provider) || "codex";
  if (!threadProviderExplicit && (!threadProvider || threadProvider === previousProvider)) {
    threadProvider = activeProvider;
  }
  document.documentElement.dataset.provider = activeProvider;
  renderThreadProviderTabs();
  // The chat tab used to be a hardcoded "Codex". With several bridges open at
  // once, every tab read the same regardless of which agent was behind it.
  if (chatViewLabel) chatViewLabel.textContent = providerLabel(currentThreadProvider());
  renderBridgePillAgent();
  // Codex and Claude do not share model names, so the composer follows the
  // provider back to whichever model was last chosen for it.
  applySelectedModel();
}

// "M" was the only thing on screen saying how hard the model was being asked to
// think, and it says nothing. The menu already carried these words as tooltips;
// now the button, the menu rows and the tooltip all use the same four.
const reasoningDisplayLabels = new Map([
  ["low", "軽め"],
  ["medium", "標準"],
  ["high", "深め"],
  ["xhigh", "かなり深め"],
  ["max", "最大"],
  ["ultra", "最大＋自動分担"],
]);

function reasoningDisplayLabel(value) {
  // Keyed by the provider's own lowercase name; upper-casing here is what made
  // the menu fall through to the bare English level.
  return reasoningDisplayLabels.get(String(value || "").trim().toLowerCase()) || String(value || "");
}

// The rows the model actually has, replacing whatever the menu held before.
// Mirrors renderInlineModelChoices: the markup carries no fixed set any more.
function renderReasoningChoices() {
  const separator = modelMenu.querySelector("[data-reasoning-separator]");
  if (!separator) return;
  for (const row of modelMenu.querySelectorAll("[data-reasoning]")) row.remove();
  for (const name of reasoningChoicesForModel(currentThreadProvider(), selectedModel)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-menu-row";
    row.dataset.reasoning = name;
    // The provider's own name beside the label, so a level is recognisable as
    // the one named in Codex's and Claude's own settings.
    row.append(document.createTextNode(`${reasoningDisplayLabel(name)} (${name})`));
    separator.before(row);
  }
}

function updateModelButton() {
  const lab = activeLabInfo();
  modelButton.disabled = Boolean(lab);
  if (lab) {
    modelButton.textContent = `${lab.model}・${reasoningDisplayLabel(lab.effort)}（実験用固定）`;
    modelButton.title = "実験室では確認済みの設定を使います。普段の設定は変更しません。";
    closeModelMenu();
    return;
  }
  const showReasoning = providerSupportsReasoning();
  // Rendering is not a user choice. Startup and reconnect initially have only
  // fallback levels; persisting their clamp permanently lost max/ultra. Keep
  // the requested preference intact and derive what this model can run.
  const effectiveReasoning = effortForSubmission();
  if (showReasoning) {
    renderReasoningChoices();
  }
  const showServiceTier = providerSupportsServiceTier();
  const serviceTierSuffix = showServiceTier && selectedServiceTier === "fast" ? " ⚡" : "";
  modelButton.textContent = showReasoning
    ? `${selectedModelLabel}・${reasoningDisplayLabel(effectiveReasoning)}${serviceTierSuffix}`
    : selectedModelLabel;
  modelButton.title = showReasoning && effectiveReasoning !== selectedReasoning
    ? `保存した深さ：${reasoningDisplayLabel(selectedReasoning)} / このモデルで使う深さ：${reasoningDisplayLabel(effectiveReasoning)}`
    : "";
  modelMenu.classList.toggle("no-reasoning", !showReasoning);
  renderInlineModelChoices();
  for (const row of modelMenu.querySelectorAll(".model-menu-label, [data-reasoning]")) {
    row.hidden = !showReasoning;
  }
  for (const row of modelMenu.querySelectorAll("[data-service-tier-toggle], [data-service-tier-separator]")) {
    row.hidden = !showServiceTier;
  }
  for (const row of modelMenu.querySelectorAll("[data-reasoning-separator]")) {
    row.hidden = !showReasoning;
  }
  const serviceTierToggle = modelMenu.querySelector("[data-service-tier-toggle]");
  if (serviceTierToggle) {
    const fastMode = selectedServiceTier === "fast";
    serviceTierToggle.classList.toggle("active", fastMode);
    serviceTierToggle.setAttribute("aria-pressed", String(fastMode));
  }
  for (const row of modelMenu.querySelectorAll("[data-reasoning]")) {
    const active = row.dataset.reasoning === effectiveReasoning;
    row.classList.toggle("active", active);
    let mark = row.querySelector(".checkmark");
    if (active && !mark) {
      mark = document.createElement("span");
      mark.className = "checkmark";
      mark.textContent = "✓";
      row.appendChild(mark);
    } else if (!active && mark) {
      mark.remove();
    }
  }
  for (const row of modelMenu.querySelectorAll("[data-model-choice]")) {
    row.classList.toggle("active", row.dataset.modelChoice === selectedModel);
  }
}

function renderInlineModelChoices() {
  const moreButton = modelMenu.querySelector("#moreModelsButton");
  if (!moreButton) return;
  for (const row of modelMenu.querySelectorAll("[data-model-choice]")) row.remove();
  const choices = [...(liveModelChoices[activeProvider] || inlineModelChoices[activeProvider] || inlineModelChoices.codex)].slice(0, 6);
  if (selectedModel && !choices.includes(selectedModel)) choices.unshift(selectedModel);
  for (const choice of choices) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-menu-row submenu-row";
    row.dataset.modelChoice = choice;
    row.append(document.createTextNode(displayModelName(choice)));
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "›";
    row.appendChild(chevron);
    moreButton.before(row);
  }
}

function closeModelMenu() {
  modelMenu.classList.add("hidden");
}

function toggleModelMenu() {
  updateModelButton();
  const willOpen = modelMenu.classList.contains("hidden");
  modelMenu.classList.toggle("hidden");
  if (willOpen) refreshRateLimits().catch(() => {});
}

function normalizeRateLimitWindows(rateLimits) {
  const rawWindows = Array.isArray(rateLimits) ? rateLimits : rateLimits?.windows || rateLimits?.limits || [];
  return rawWindows
    .map((item) => {
      const remainingPercent = Number(item.remainingPercent ?? item.remaining ?? item.percent);
      const label = String(item.label || item.window || item.name || "").trim();
      const resetsAt = String(item.resetsAt || item.resetAt || item.reset || "").trim();
      if (!label && !Number.isFinite(remainingPercent) && !resetsAt) return null;
      return {
        label: label || "制限",
        remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, Math.round(remainingPercent))) : null,
        resetsAt,
      };
    })
    .filter(Boolean);
}

function renderRateLimitCard(rateLimits = latestRateLimits) {
  if (!rateLimitList) return;
  const windows = normalizeRateLimitWindows(rateLimits);
  rateLimitList.replaceChildren();
  if (!windows.length) {
    const empty = document.createElement("span");
    empty.className = "rate-limit-empty";
    empty.textContent = rateLimits?.error ? "取得エラー" : rateLimits?.source === "unavailable" ? "取得元未設定" : "未取得";
    rateLimitList.appendChild(empty);
    return;
  }
  for (const item of windows) {
    const row = document.createElement("div");
    row.className = "rate-limit-row";
    const label = document.createElement("span");
    label.textContent = item.label;
    const value = document.createElement("strong");
    const percent = item.remainingPercent === null ? "--" : `${item.remainingPercent}%`;
    value.textContent = item.resetsAt ? `${percent} ${item.resetsAt}` : percent;
    row.append(label, value);
    rateLimitList.appendChild(row);
  }
}

function addRateLimitPanelRows(rateLimits) {
  const windows = normalizeRateLimitWindows(rateLimits);
  if (!windows.length) {
    const detail = rateLimits?.error ? "取得エラー" : rateLimits?.source === "unavailable" ? "取得元未設定" : "未取得";
    addPanelRow("レート制限", detail);
    return;
  }
  for (const item of windows) {
    const percent = item.remainingPercent === null ? "--" : `${item.remainingPercent}%`;
    addPanelRow(`レート制限 ${item.label}`, item.resetsAt ? `${percent} / ${item.resetsAt}` : percent);
  }
}

async function refreshRateLimits() {
  const result = await apiGet(`/api/status?refreshRateLimits=1&provider=${encodeURIComponent(currentThreadProvider())}`);
  setWorkspaceMeta(result);
  latestRateLimits = result.rateLimits || null;
  renderRateLimitCard(latestRateLimits);
  return latestRateLimits;
}

function selectReasoning(value) {
  if (!providerSupportsReasoning()) return;
  selectedReasoning = normalizeReasoning(value);
  localStorage.setItem("codexPhoneReasoning", selectedReasoning);
  updateModelButton();
  closeModelMenu();
  addStatus(`思考の深さを ${reasoningDisplayLabel(selectedReasoning)} (${selectedReasoning}) にしました。次の送信から反映します。`);
}

function selectServiceTier(value) {
  if (!providerSupportsServiceTier()) return;
  selectedServiceTier = normalizeServiceTier(value);
  localStorage.setItem(serviceTierStorageKey, selectedServiceTier);
  updateModelButton();
  updateTerminalHeader();
  closeModelMenu();
  addStatus(selectedServiceTier === "fast" ? "速度を Fast に切り替えました。次の送信から反映します。" : "速度を Standard に切り替えました。次の送信から反映します。");
}

function selectModel(model) {
  setSelectedModel(model);
  closeModelMenu();
  addStatus(`モデルを ${model.toUpperCase()} に設定しました。次の送信から反映します。`);
}

function resumeCommandForThread(thread) {
  // An older cached helper ignores ownership and returns local-only commands.
  if (uiUtils.portableResumeVersion === 2 && uiUtils.resumeCommandForThread) {
    // Resolve the row's owner, not the currently selected bridge or the phone's
    // origin. Display labels may be renamed and are not routing information.
    const owner = getBridgeState(thread.bridgeId || activeBridgeId);
    const endpoint = Object.prototype.hasOwnProperty.call(owner.info || {}, "codexUrl") ? owner.info : owner.status || {};
    return uiUtils.resumeCommandForThread(thread, {
      hostName: owner.info?.hostName || "",
      codexUrl: endpoint.codexUrl,
      codexSocketPath: endpoint.codexSocketPath,
    });
  }
  return "";
}

function titleForThread(thread) {
  if (uiUtils.threadDisplayTitle) return uiUtils.threadDisplayTitle(thread, { fallback: "名前未設定のチャット", max: 54 });
  const raw = thread.name || thread.preview || thread.cwd || "";
  const firstLine = raw.split("\n").find(Boolean) || "";
  if (!firstLine || firstLine === thread.id || isOpaqueThreadId(firstLine)) return "名前未設定のチャット";
  return firstLine.length > 54 ? `${firstLine.slice(0, 54)}...` : firstLine;
}

function setThreadHeading(title) {
  if (threadTitle) threadTitle.textContent = title || "新しいチャット";
}

function isOpaqueThreadId(value) {
  if (uiUtils.isOpaqueThreadId) return uiUtils.isOpaqueThreadId(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function selectedThreadRecord() {
  return threadCache.find((thread) => thread.id === selectedThread) || null;
}

function selectedThreadHeadingText(fallback = "新しいチャット") {
  const selected = selectedThreadRecord();
  if (selected) return titleForThread(selected);
  return selectedThread ? "名前未設定のチャット" : fallback;
}

function updateSelectedThreadHeading(fallback = "新しいチャット") {
  setThreadHeading(selectedThreadHeadingText(fallback));
}

function projectForThread(thread) {
  const cwd = String(thread.cwd || "").replace(/\/+$/, "");
  if (!cwd) return "No project";
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function projectWorkdirForThreads(threads = []) {
  const record = threads.find((thread) => workspaceKeyForThread(thread));
  return workspaceKeyForThread(record);
}

function workspaceKeyForThread(thread, fallback = "") {
  if (uiUtils.workspaceKeyForThreadRecord) return uiUtils.workspaceKeyForThreadRecord(thread, fallback);
  return String(thread?.cwd || thread?.workspaceLocation || thread?.workdir || fallback || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function usableWorkspaceLocation(value = "") {
  const location = workspaceKeyForThread({ cwd: value });
  return location && location !== "." ? location : "";
}

function currentThreadWorkspaceKey() {
  const selected = threadCache.find((thread) => thread.id === selectedThread);
  return workspaceKeyForThread(selected, currentWorkspace.workspaceLocation || currentWorkspace.repoName || "");
}

function rememberedThreadWorkdir(threadId = selectedThread) {
  return threadId ? workspaceKeyForThread({ cwd: threadWorkdirs[threadId] || "" }) : "";
}

function rememberThreadWorkdir(threadId, workdir) {
  const key = String(threadId || "");
  const target = workspaceKeyForThread({ cwd: workdir || "" });
  if (!key || !target || threadWorkdirs[key] === target) return;
  threadWorkdirs = { ...threadWorkdirs, [key]: target };
  const keys = Object.keys(threadWorkdirs);
  // Oldest first: string keys keep the order they were added in.
  if (keys.length > threadWorkdirLimit) {
    threadWorkdirs = Object.fromEntries(keys.slice(keys.length - threadWorkdirLimit).map((id) => [id, threadWorkdirs[id]]));
  }
  writeJsonStorage(threadWorkdirStorageKey, threadWorkdirs);
}

function selectedThreadWorkdir(fallback = currentWorkspace.workspaceLocation || "") {
  // The list the bridge sends is built from transcripts, so a chat that has not
  // been sent to yet is not in it and has no record here to carry its folder.
  // What the phone remembered when the folder was picked stands in until it is.
  const remembered = rememberedThreadWorkdir();
  const record = selectedThreadRecord();
  // The stand-in record made for such a chat carries a guessed folder. It must
  // not pass for one the chat named, because this is what the phone dials with.
  if (record?.cwdGuessed && !remembered) return workspaceKeyForThread({}, fallback);
  return workspaceKeyForThread(record, remembered || fallback);
}

function selectedThreadWorkdirKnown() {
  return Boolean(selectedThread && (selectedThreadRecord() || rememberedThreadWorkdir()) && selectedThreadWorkdir(""));
}

function shouldDeferSelectedThreadWorkdir() {
  return initialUrlThreadPending && !selectedThreadWorkdirKnown();
}

function currentWorkspaceWorkdir() {
  return usableWorkspaceLocation(currentWorkspace.workspaceLocation || "");
}

function activeBridgeWorkdir(fallback = "") {
  const entry = activeBridge();
  const state = getBridgeState(activeBridgeId);
  return workspaceKeyForThread({
    cwd: entry?.workdir || state.info?.cwd || state.info?.workdir || state.status?.workdir || fallback,
  });
}

function currentRequestWorkdir(fallback = "") {
  const selected = shouldDeferSelectedThreadWorkdir() ? "" : selectedThreadWorkdir("");
  return workspaceKeyForThread({
    cwd: (workspaceFollowsSelectedThread ? selected : "") || currentWorkspaceWorkdir() || activeBridgeWorkdir() || selected || fallback,
  });
}

function connectionWorkdir(explicitWorkdir = "") {
  const explicit = workspaceKeyForThread({ cwd: explicitWorkdir });
  if (explicit) return explicit;
  const selected = shouldDeferSelectedThreadWorkdir() ? "" : selectedThreadWorkdir("");
  const followed = workspaceFollowsSelectedThread ? selected : "";
  if (followed) return followed;
  // Dialling an existing chat with a folder that is only a guess is how a chat
  // gets moved: with no transcript to read one from, the folder in the request
  // is the folder the session opens in, so a guess becomes the answer. Saying
  // nothing leaves the question with the bridge, which is the side that knows.
  if (selectedThread && workspaceFollowsSelectedThread) return "";
  return workspaceKeyForThread({ cwd: currentWorkspaceWorkdir() || activeBridgeWorkdir() || selected });
}

function isSameCurrentWorkspaceThread(thread, baseKey = currentThreadWorkspaceKey()) {
  if (uiUtils.sameWorkspaceThreadRecord) return uiUtils.sameWorkspaceThreadRecord(thread, baseKey);
  const candidate = workspaceKeyForThread(thread);
  return !baseKey || !candidate || candidate === baseKey;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const ms = uiUtils.timestampValueMs ? uiUtils.timestampValueMs(timestamp) : timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  if (!ms) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const hours = Math.floor(diffSeconds / 3600);
  const days = Math.floor(diffSeconds / 86400);
  const months = Math.floor(days / 30);
  if (diffSeconds < 3600) return "今";
  if (hours < 24) return `${hours}時間`;
  if (days < 30) return `${days}日`;
  return `${months || 1}か月`;
}

// A table needs its divider row to identify itself, so this takes the whole
// list: called with one line it could not tell a table apart from prose.
function isBlockStart(lines, index) {
  const line = lines[index];
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    Boolean(uiUtils.isMarkdownTableStart?.(lines, index))
  );
}

function sanitizeHref(value) {
  try {
    const url = new URL(value, location.href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
  } catch {
    return "";
  }
  return "";
}

function isImageHref(value) {
  return /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(String(value || ""));
}

function normalizeImageHref(value) {
  if (/^https?:\/\//i.test(value)) return value;
  const clean = String(value || "").replace(/^\.\//, "");
  if (clean.startsWith("/api/file/raw") || clean.startsWith("/api/uploaded")) return urlWithToken(clean);
  const localPath = clean.replace(/[?#].*$/, "");
  const repoImage = localPath.match(/(?:^|[/\\])(docs[/\\](?:assets|public)[/\\].+\.(?:png|jpe?g|gif|webp|svg))$/i);
  if (repoImage) {
    const relativeAsset = repoImage[1].replace(/\\/g, "/");
    return urlWithToken(`/api/file/raw?path=${encodeURIComponent(relativeAsset)}`);
  }
  if (/^[^?#]+\/[^?#]+\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(clean)) {
    return urlWithToken(`/api/file/raw?path=${encodeURIComponent(localPath)}`);
  }
  if (/^[^/\\]+$/.test(clean) && isImageHref(clean)) {
    return urlWithToken(`/api/file/raw?path=${encodeURIComponent(`docs/assets/${clean}`)}`);
  }
  return value;
}

function sanitizeMarkdownHtml(html) {
  const allowedTags = new Set([
    "A",
    "B",
    "BR",
    "CODE",
    "DEL",
    "DETAILS",
    "DIV",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "IMG",
    "KBD",
    "P",
    "PRE",
    "S",
    "SPAN",
    "STRONG",
    "SUB",
    "SUMMARY",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "UL",
    "OL",
    "LI",
  ]);
  const template = document.createElement("template");
  template.innerHTML = html;

  const sanitizeNode = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !allowedTags.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ""));
        continue;
      }

      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (name.startsWith("on") || name === "style" || name === "class" || name === "id") {
          child.removeAttribute(attribute.name);
          continue;
        }
        if (child.tagName === "A" && name === "href") {
          const safeHref = sanitizeHref(value);
          if (safeHref) {
            child.setAttribute("href", safeHref);
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noreferrer");
          } else {
            child.removeAttribute(attribute.name);
          }
          continue;
        }
        if (child.tagName === "IMG" && name === "src") {
          child.setAttribute("src", normalizeImageHref(value));
          child.setAttribute("loading", "lazy");
          continue;
        }
        if (child.tagName === "IMG" && ["alt", "width", "height"].includes(name)) continue;
        if (["align", "colspan", "rowspan"].includes(name)) continue;
        child.removeAttribute(attribute.name);
      }

      sanitizeNode(child);
    }
  };

  sanitizeNode(template.content);
  return template.innerHTML;
}

function isHtmlBlockStart(line) {
  return /^<\/?(p|div|table|thead|tbody|tr|td|th|a|img|br|h[1-6]|details|summary)\b/i.test(line.trim());
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  const imageTokens = [];
  let source = String(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(escapeHtml(code));
    return token;
  });

  source = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (!isImageHref(href)) return _;
    const token = `\u0000IMAGE${imageTokens.length}\u0000`;
    imageTokens.push({ name: label || href.split("/").pop(), url: normalizeImageHref(href) });
    return token;
  });

  source = escapeHtml(source)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      if (isImageHref(href)) {
        const token = `\u0000IMAGE${imageTokens.length}\u0000`;
        imageTokens.push({ name: label, url: normalizeImageHref(href) });
        return token;
      }
      const safeHref = sanitizeHref(href);
      if (!safeHref) return label;
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  return source
    .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${codeTokens[Number(index)] || ""}</code>`)
    .replace(/\u0000IMAGE(\d+)\u0000/g, (_, index) => {
      const image = imageTokens[Number(index)];
      if (!image) return "";
      return `<figure class="image-preview markdown-image"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || "image")}" loading="lazy"><figcaption>${escapeHtml(image.name || "image")}</figcaption></figure>`;
    });
}

function parseMarkdownTable(lines, index) {
  if (!uiUtils.parseMarkdownTable) return null;
  return uiUtils.parseMarkdownTable(lines, index);
}

// Wrapped in its own scroller: a table wide enough to matter is wider than a
// phone, and the alternative is the whole conversation scrolling sideways.
function renderMarkdownTable(table) {
  const cell = (tag, value, align) => {
    const style = align ? ` style="text-align:${align}"` : "";
    return `<${tag}${style}>${renderInlineMarkdown(value)}</${tag}>`;
  };
  const head = `<tr>${table.header.map((value, column) => cell("th", value, table.align[column])).join("")}</tr>`;
  const body = table.rows
    .map((row) => `<tr>${row.map((value, column) => cell("td", value, table.align[column])).join("")}</tr>`)
    .join("");
  return `<div class="markdown-table"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
}

function renderMarkdown(text, options = {}) {
  const headingOffset = options.headingOffset ?? 1;
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (options.allowHtml && isHtmlBlockStart(line)) {
      const html = [line];
      const open = line.trim().match(/^<([a-z0-9]+)\b/i)?.[1]?.toLowerCase();
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() &&
        open &&
        !new RegExp(`</${open}>`, "i").test(html.join("\n"))
      ) {
        html.push(lines[index]);
        index += 1;
      }
      blocks.push(sanitizeMarkdownHtml(html.join("\n")));
      continue;
    }

    const fence = line.match(/^```\s*([a-z0-9_-]+)?\s*$/i);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] ? ` data-language="${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre${language}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(renderMarkdownTable(table));
      index = table.endIndex;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + headingOffset, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${quote.map(renderInlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return blocks.join("");
}

function stripUiDirectives(text, preserveWhitespace = false) {
  const cleaned = String(text || "")
    .replace(/(?:^|\n)::[a-z0-9-]+\{[^\n]*\}(?=\n|$)/gi, "")
    .replace(/\[CODEX_TASK_COMPLETED\]/g, "\n\n**完了**")
    .replace(/\[CODEX_TASK_FAILED\]/g, "\n\n**エラー**")
    .replace(/\n{3,}/g, "\n\n");
  return preserveWhitespace ? cleaned : cleaned.trim();
}

function parseJsonish(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || !/^[{[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compactBridgeError(raw) {
  const text = (uiUtils.redactSensitiveText ? uiUtils.redactSensitiveText(raw) : String(raw || "")).trim();
  const parsed = parseJsonish(text);
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const error = root.error && typeof root.error === "object" ? root.error : root;
  const message = String(error.message || root.message || text || "エラー");
  const info = error.codexErrorInfo || root.codexErrorInfo || {};
  const code = Object.keys(info)[0] || "";
  const additional = String(error.additionalDetails || root.additionalDetails || "");
  const requestId = (additional.match(/request ID\s+([a-f0-9-]+)/i) || text.match(/request ID\s+([a-f0-9-]+)/i))?.[1] || "";
  const willRetry = root.willRetry === true || /reconnecting/i.test(message);
  const streamDisconnected =
    code === "responseStreamDisconnected" || /responseStreamDisconnected|stream disconnected before completion/i.test(text);

  if (streamDisconnected) {
    const lines = [willRetry ? "Codexの応答ストリームが切断されました。再接続中です。" : "Codexの応答ストリームが切断されました。"];
    if (message && !/^reconnecting/i.test(message)) lines.push(message);
    if (requestId) lines.push(`Request ID: ${requestId}`);
    return {
      text: lines.join("\n"),
      label: willRetry ? "再接続中" : "ストリーム切断",
      retrying: willRetry,
      signature: `stream-disconnected:${requestId || message}`,
    };
  }

  const shortened = text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
  const known = knownConnectionFailure(text);
  if (known) {
    return {
      text: [known.headline, known.hint, shortened].filter(Boolean).join("\n"),
      label: known.label,
      retrying: false,
      signature: `${known.label}:${shortened.slice(0, 120)}`,
    };
  }
  return {
    text: shortened || "エラー",
    label: "エラー",
    retrying: false,
    signature: shortened.slice(0, 180),
  };
}

// Connection failures reach the chat as the raw Node error: a syscall, an errno
// and a port, which says nothing a person can act on and reads as a crash. Each
// entry here replaces the headline with what broke and what to do; the original
// line stays underneath, where it is useful without being the message.
const connectionFailures = [
  {
    match: /ECONNREFUSED/,
    label: "接続できません",
    headline: "エージェントのプロセスに接続できませんでした。",
    hint: "PC側でbridgeが動いているか確認し、必要なら起動し直してください。",
  },
  {
    match: /spawn .*ENOENT|ENOENT.*spawn/,
    label: "実行ファイルなし",
    headline: "エージェントの実行ファイルが見つかりませんでした。",
    hint: "PC側で依存関係を入れ直すと復帰します。",
  },
  {
    match: /ENOTFOUND|EAI_AGAIN/,
    label: "宛先不明",
    headline: "接続先のホスト名を解決できませんでした。",
    hint: "接続先の設定と、PCとの経路を確認してください。",
  },
  {
    match: /ETIMEDOUT|ESOCKETTIMEDOUT/,
    label: "応答なし",
    headline: "エージェントから応答がありませんでした。",
    hint: "処理が長引いているか、経路が切れています。少し待ってから再試行してください。",
  },
  {
    match: /ECONNRESET|EPIPE/,
    label: "接続が切れました",
    headline: "エージェントとの接続が切れました。",
    hint: "再接続すると続きから操作できます。",
  },
  {
    match: /EADDRINUSE/,
    label: "ポート使用中",
    headline: "使おうとしたポートが既に使われています。",
    hint: "PC側で別のbridgeが動いていないか確認してください。",
  },
];

function knownConnectionFailure(text) {
  return connectionFailures.find((entry) => entry.match.test(text)) || null;
}

function showBridgeError(rawText) {
  const error = compactBridgeError(rawText);
  const now = Date.now();
  if (error.signature && error.signature === lastDisplayedErrorSignature && now - lastDisplayedErrorAt < 15_000) {
    return;
  }
  lastDisplayedErrorSignature = error.signature;
  lastDisplayedErrorAt = now;
  if (error.retrying) {
    setRunState("running", error.label);
    addStatus(error.text);
    return;
  }
  setRunState("error", error.label);
  addEntry("error", error.text);
}

function setEntryText(body, kind, text) {
  body.markdownSource = kind === "assistant" ? stripUiDirectives(text, true) : text || "";
  if (kind === "assistant" || kind === "user") body.innerHTML = renderMarkdown(body.markdownSource);
  else body.textContent = body.markdownSource;
}

function urlWithToken(url) {
  return urlWithBridgeToken(url, activeBridge());
}

function renderImageGallery(images = []) {
  if (!images.length) return null;
  const gallery = document.createElement("div");
  gallery.className = "image-gallery";
  for (const image of images) {
    const figure = document.createElement("figure");
    figure.className = "image-preview";
    const img = document.createElement("img");
    img.src = image.dataUrl || urlWithToken(image.url);
    img.alt = image.name || "添付画像";
    img.loading = "lazy";
    const caption = document.createElement("figcaption");
    caption.textContent = image.name || "image";
    figure.append(img, caption);
    gallery.appendChild(figure);
  }
  return gallery;
}

function summarizeStatus(items) {
  if (items.some((item) => item.includes("音声入力"))) return "音声入力";
  const reads = items.filter((item) => /^Read\s+/i.test(item)).length;
  const commands = items.filter((item) => /command|コマンド|\$\s/.test(item)).length;
  const files = items.filter((item) => /file|ファイル/i.test(item)).length;
  const parts = [];
  if (reads) parts.push(`${reads}個のファイルを調査`);
  if (commands) parts.push(`${commands}件のコマンドを実行`);
  if (files && !reads) parts.push(`${files}件のファイル操作`);
  // No count here: the row already carries one in its own badge, and spelling it
  // out twice read as "4件の作業ログ 4件".
  return parts.length ? parts.join("、") : "作業ログ";
}

function updateStatusGroup(group) {
  const count = group.items.length;
  group.summaryText.textContent = summarizeStatus(group.items);
  group.count.textContent = `${count}件`;
  group.list.replaceChildren(
    ...group.items.map((item) => {
      const row = document.createElement("li");
      row.textContent = item;
      return row;
    }),
  );
}

// The chat log repinned itself to the bottom on every streaming delta, so
// scrolling back through an answer while it was still being written yanked the
// view away again. Terminal already had the rule this borrows: follow the tail
// only for a reader who is parked at it, and offer 最新へ to anyone who is not.
const chatBottomThreshold = 40;

function isChatNearBottom() {
  if (!log) return true;
  return log.scrollHeight - log.scrollTop - log.clientHeight < chatBottomThreshold;
}

function updateChatLatestButton() {
  if (!chatLatestButton || !log) return;
  chatLatestButton.classList.toggle("hidden", mainViewMode !== "chat" || isChatNearBottom());
}

function scrollChatToBottom() {
  if (!log) return;
  log.scrollTop = log.scrollHeight;
  updateChatLatestButton();
}

// Reading a long answer, the composer and the bar below it are not being used,
// and on a 390x844 phone they hold 212px of the 549px the conversation gets.
// They leave while the reader is going down through an answer and come back the
// moment they are wanted: a scroll back up, the end of the chat, or a run that
// needs something. 最新へ stays behind as the way back for a thumb that would
// rather tap than scroll.
const chatRestStates = new Set(["done", "ready", "interrupted", "error", "disconnected"]);
// Wider apart than the 212px the two rows are worth. Hiding them makes the log
// that much taller, which moves the reader that much closer to the end - close
// thresholds would meet in the middle and the chrome would flicker in and out.
const readingHideDistance = 300;
const readingShowDistance = 24;
let lastLogScrollTop = 0;

function chromeMayHide() {
  if (mainViewMode !== "chat") return false;
  if (pendingApproval) return false;
  if (!chatRestStates.has(currentRunState)) return false;
  // A draft is the one thing on that bar nobody would want taken away.
  if (promptInputFocused || String(promptInput?.value || "").trim()) return false;
  return true;
}

function setReadingMode(on) {
  const next = Boolean(on) && chromeMayHide();
  if (document.body.classList.contains("reading-mode") === next) return;
  document.body.classList.toggle("reading-mode", next);
  updateChatLatestButton();
}

function refreshReadingMode() {
  if (!chromeMayHide()) setReadingMode(false);
}

// Either direction: going back up through an answer is reading too, and it was
// the direction that kept handing the space back. What ends it is arriving at
// the end of the chat, or a tap - on the composer to write, or on the page to
// ask for the controls back.
function updateReadingMode() {
  if (!log) return;
  const top = log.scrollTop;
  const moved = Math.abs(top - lastLogScrollTop);
  lastLogScrollTop = top;
  const fromBottom = log.scrollHeight - top - log.clientHeight;
  if (fromBottom < readingShowDistance) setReadingMode(false);
  else if (moved > 6 && fromBottom > readingHideDistance) setReadingMode(true);
}

// renderHistory wipes the log and replays every message through addEntry. Those
// replays are not new arrivals and must not each decide where the view sits, so
// the bulk redraw owns the scroll position for its whole run.
let chatBulkRender = false;

// Callers measure before they append: once the new content is in the DOM the
// reader is no longer "near the bottom" by their own doing.
function settleChatScroll(stickToBottom) {
  if (chatBulkRender) return;
  if (stickToBottom) scrollChatToBottom();
  else updateChatLatestButton();
}

function addStatusGroupItem(text) {
  const stickToBottom = isChatNearBottom();
  if (!statusGroup || statusGroup.items.length >= 12) {
    const el = document.createElement("article");
    el.className = "entry status status-group";

    const avatar = document.createElement("div");
    avatar.className = "entry-avatar";
    avatar.textContent = "›";

    const details = document.createElement("details");
    details.className = "status-details";

    const summary = document.createElement("summary");
    const summaryText = document.createElement("span");
    summaryText.className = "status-summary-text";
    const count = document.createElement("span");
    count.className = "status-count";
    summary.append(summaryText, count);

    const list = document.createElement("ul");
    list.className = "status-list";
    details.append(summary, list);

    const tools = document.createElement("div");
    tools.className = "entry-tools";

    el.append(avatar, details, tools);
    log.appendChild(el);
    syncLogEmptyState();
    statusGroup = { items: [], summaryText, count, list };
  }
  statusGroup.items.push(text);
  updateStatusGroup(statusGroup);
  settleChatScroll(stickToBottom);
}

// An empty thread used to be an empty scroll area: most of the screen blank,
// with nothing saying whether that was the state of the chat or a failure to
// load it. Removed again the moment anything real is appended.
function syncThreadRecoveryActions() {
  const existing = log.querySelector(".thread-recovery");
  if (!selectedThread || connectionReady || (currentRunState !== "error" && !threadOpenFailures.has(currentThreadColorKey()))) {
    existing?.remove();
    return;
  }
  const target = { threadId: selectedThread, bridgeId: activeBridgeId, provider: currentThreadProvider(), workdir: selectedThreadWorkdir("") };
  const failure = threadOpenFailureDetails.get(currentThreadColorKey());
  const signature = JSON.stringify({ ...target, code: failure?.code });
  if (existing?.dataset.target === signature) return;
  existing?.remove();
  const panel = document.createElement("div");
  panel.className = "thread-recovery";
  panel.dataset.target = signature;
  const hint = document.createElement("p");
  hint.textContent = failure?.text || "履歴と下書きを残したまま、同じ会話への接続をやり直せます。";
  const actions = document.createElement("div");
  const find = document.createElement("button");
  find.type = "button";
  find.textContent = "履歴を探す";
  find.addEventListener("click", () => { setSidebarVisible(true); loadThreads({ background: true }).catch(() => {}); });
  const create = document.createElement("button");
  create.type = "button";
  create.textContent = target.workdir ? "同じフォルダで新しく開く" : "フォルダを選んで新しく開く";
  const isCurrent = () => selectedThread === target.threadId && activeBridgeId === target.bridgeId
    && currentThreadProvider() === target.provider && selectedThreadWorkdir("") === target.workdir && !connectionReady;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "同じ会話に再接続";
  retry.addEventListener("click", () => {
    if (retry.disabled || !isCurrent()) return;
    retry.disabled = true;
    threadOpenFailures.delete(currentThreadColorKey());
    threadOpenFailureDetails.delete(currentThreadColorKey());
    connect({ preserveHistory: true, workdir: target.workdir });
  });
  create.addEventListener("click", async () => {
    if (create.disabled || !isCurrent()) return;
    if (!target.workdir) { showNewSessionPicker(); return; }
    create.disabled = true;
    try {
      const result = await apiPost("/api/workspaces", { path: target.workdir }, { bridgeId: target.bridgeId });
      if (!isCurrent()) return;
      if (result.workspace?.path !== target.workdir) throw new Error("元のフォルダを確認できませんでした。フォルダを選び直してください。");
      await startNewThread({ workdir: target.workdir, bridgeId: target.bridgeId, provider: target.provider });
    } catch (error) {
      if (isCurrent()) showToast(error.message);
    } finally { create.disabled = false; }
  });
  actions.append(retry, find, create);
  panel.append(hint, actions);
  if (failure?.code === "thread_writer_conflict") {
    const help = document.createElement("details");
    help.className = "thread-handoff-help";
    const summary = document.createElement("summary");
    summary.textContent = "公式アプリと切り替えるには";
    summary.addEventListener("click", () => {
      if (help.open) return;
      // Reading the instructions ends input focus, not the draft. Otherwise
      // the mobile fixed composer can cover the final paragraph and link.
      promptInput.blur();
      promptInputFocused = false;
      updateQuickBarVisibility();
    });
    const entry = document.createElement("p");
    entry.textContent = "公式の /app（同じ会話を公式アプリで開く命令）は、ターミナル内で動くCodexの入力欄に入れます。Macの通常の命令欄や、このスマホの入力欄には入れません。";
    const limit = document.createElement("p");
    limit.textContent = "この中継アプリと公式アプリとの往復は未検証です。/appだけで使用権（会話を実行・保存する権利）が解放されるとは限りません。切り替え後もエラーになるときは、再接続を連打せず元の画面で続けてください。";
    const shared = document.createElement("p");
    shared.textContent = "スマホとターミナルは、一覧の >_ からコピーした命令で同じ実行元（会話を動かす本体）に接続します。この命令で公式アプリも同じ実行元になるわけではありません。";
    const docs = document.createElement("a");
    docs.href = "https://learn.chatgpt.com/docs/developer-commands#continue-in-the-desktop-app-with-app";
    docs.target = "_blank";
    docs.rel = "noopener noreferrer";
    docs.textContent = "公式の引継ぎ手順を見る";
    help.append(summary, entry, limit, shared, docs);
    panel.append(help);
  }
  log.appendChild(panel);
}

function syncLogEmptyState() {
  if (!log) return;
  syncThreadRecoveryActions();
  const existing = log.querySelector(".log-empty");
  // A collapsed "作業ログ" group is bookkeeping, not conversation. A thread that
  // has only that is exactly the screen this is for: one grey row at the top and
  // the rest of the height blank.
  const hasConversation = [...log.children].some(
    (child) => child !== existing && !child.classList.contains("status") && !child.classList.contains("thread-recovery"),
  );
  if (hasConversation) {
    existing?.remove();
    log.classList.remove("has-empty-state");
    return;
  }
  log.classList.add("has-empty-state");
  const failed = currentRunState === "error" || (!connectionReady && threadOpenFailures.has(currentThreadColorKey()));
  const emptyState = failed ? "error" : selectedThread && !connectionReady ? "loading" : "empty";
  if (existing?.dataset.state === emptyState) {
    log.appendChild(existing);
    return;
  }
  existing?.remove();
  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.dataset.state = emptyState;
  const title = document.createElement("strong");
  title.textContent = emptyState === "error" ? "会話を読み込めませんでした" : emptyState === "loading" ? "会話を読み込み中…" : "まだやり取りはありません";
  const lead = document.createElement("p");
  lead.textContent = emptyState === "error" ? "履歴を表示できていません。会話が空になったことを示すものではありません。" : emptyState === "loading" ? "保存済みの会話を確認しています。" : "下の入力欄から依頼を送ると、ここに応答が表示されます。";
  const hint = document.createElement("p");
  hint.className = "log-empty-hint";
  hint.textContent = emptyState === "error" ? "一覧で、会話を保存したMacとAIを確認して選び直してください。" : emptyState === "loading" ? "下書きはそのまま保持しています。" : "よく使う依頼は、入力欄の上のボタンから選べます。";
  empty.append(title, lead, hint);
  log.appendChild(empty);
}

function addEntry(kind, text, images = [], options = {}) {
  if (kind === "status") {
    addStatusGroupItem(text);
    return null;
  }
  if (kind === "user" && !String(text || "").trim() && !images.length) return null;
  // Your own message is the exception: you just sent it, so you want to see it.
  const stickToBottom = kind === "user" || isChatNearBottom();
  statusGroup = null;
  const el = document.createElement("article");
  el.className = `entry ${kind}`;

  const avatar = document.createElement("div");
  avatar.className = "entry-avatar";
  // "U" and "C" meant nothing in a Japanese interface, and the letters were the
  // last text-as-icon left in the message list. Status rows keep their chevron.
  avatar.textContent = kind === "user" || kind === "assistant" ? "" : "›";

  const body = document.createElement("div");
  body.className = "entry-body";
  if (options.outputGroup) body.dataset.outputGroup = options.outputGroup;
  setEntryText(body, kind, text);
  const gallery = kind === "user" ? renderImageGallery(images) : null;
  if (gallery) body.appendChild(gallery);

  const tools = document.createElement("div");
  tools.className = "entry-tools";
  if (kind === "assistant") {
    tools.appendChild(createCopyOutputButton(body));
    if (options.showBulkCopy) tools.appendChild(createCopyOutputButton(body, { mode: "group" }));
  }

  el.append(avatar, body, tools);
  log.appendChild(el);
  syncLogEmptyState();
  settleChatScroll(stickToBottom);
  return body;
}

function createCopyOutputButton(body, options = {}) {
  const isGroupCopy = options.mode === "group";
  const button = document.createElement("button");
  button.type = "button";
  button.className = isGroupCopy ? "copy-output-button bulk" : "copy-output-button";
  button.title = isGroupCopy ? "このターンの出力を一括コピー" : "この出力をコピー";
  button.textContent = isGroupCopy ? "一括コピー" : "コピー";
  button.addEventListener("click", async () => {
    const originalText = button.textContent;
    button.disabled = true;
    try {
      const copyText = isGroupCopy ? textForOutputGroup(body) : body.markdownSource || body.innerText || "";
      await copyTextToClipboard(copyText);
      button.textContent = "コピー済み";
    } catch (error) {
      button.textContent = "失敗";
      addStatus(`コピーできませんでした: ${error.message}`);
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 1400);
    }
  });
  return button;
}

function textForOutputGroup(body) {
  const outputGroup = body.dataset.outputGroup;
  if (!outputGroup) return body.markdownSource || body.innerText || "";
  const bodies = Array.from(log.querySelectorAll(".entry.assistant .entry-body")).filter(
    (candidate) => candidate.dataset.outputGroup === outputGroup,
  );
  return bodies.map((candidate) => candidate.markdownSource || candidate.innerText || "").filter(Boolean).join("\n\n");
}

async function copyTextToClipboard(text) {
  const value = String(text || "").trimEnd();
  if (!value) throw new Error("コピーする出力がありません");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("ブラウザがコピーを許可しませんでした");
}

function addStatus(text) {
  addStatusGroupItem(text);
}

function renderContextMismatch(snapshot = contextSnapshot()) {
  if (!contextMismatch) return;
  const agent = snapshot.agent;
  const bridge = snapshot.bridge;
  const show = Boolean(snapshot.mismatch && agent?.workspaceLocation && bridge?.workspaceLocation);
  contextMismatch.classList.toggle("hidden", !show);
  document.body.classList.toggle("context-mismatch-visible", show);
  if (!show) {
    if (contextMismatchSummary) contextMismatchSummary.textContent = "確認してください";
    if (contextAgentCwd) contextAgentCwd.textContent = "--";
    if (contextBridgeCwd) contextBridgeCwd.textContent = "--";
    if (contextFreshness) contextFreshness.textContent = "--";
    contextMismatch.removeAttribute("title");
    contextMismatch.removeAttribute("aria-label");
    return;
  }
  const agentRepo = agent.repoName || basenameFromPath(agent.workspaceLocation);
  const bridgeRepo = bridge.repoName || basenameFromPath(bridge.workspaceLocation);
  const compactAgent = compactWorkspaceLocation(agent.workspaceLocation);
  const compactBridge = compactWorkspaceLocation(bridge.workspaceLocation);
  if (contextMismatchSummary) {
    contextMismatchSummary.textContent = `${agentRepo || "Agent"} / ${bridgeRepo || "Bridge"}`;
  }
  if (contextAgentCwd) {
    contextAgentCwd.textContent = agent.workspaceLocation;
    contextAgentCwd.title = agent.workspaceLocation;
  }
  if (contextBridgeCwd) {
    contextBridgeCwd.textContent = bridge.workspaceLocation;
    contextBridgeCwd.title = bridge.workspaceLocation;
  }
  if (contextFreshness) {
    contextFreshness.textContent = agent.updatedAt ? `${timestampLabel(agent.updatedAt)} の thread metadata` : "thread metadata";
  }
  contextMismatch.title = `Agent cwd: ${agent.workspaceLocation}\nBridge repo: ${bridge.workspaceLocation}`;
  contextMismatch.setAttribute(
    "aria-label",
    `Agent cwd ${compactAgent} と Bridge repo ${compactBridge} が違います。詳細を開くとフルパスを確認できます。`,
  );
}

function compactWorkspaceLocation(location) {
  if (uiUtils.compactWorkspacePath) return uiUtils.compactWorkspacePath(location, { keepStart: 1, keepEnd: 1 });
  const value = String(location || "").trim();
  if (!value || value === ".") return value;
  const normalized = value.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/);
  const prefix = driveMatch ? `${driveMatch[1]}/` : normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
  const rest = prefix ? normalized.slice(prefix.length) : normalized;
  const parts = rest.split("/").filter(Boolean);
  if (parts.length <= 2) return value;
  return `${prefix}.../${parts.slice(-2).join("/")}`;
}

function setWorkspaceMeta(meta = {}) {
  if (!workspaceIndicator || !workspaceRepo || !workspaceLocation || !branchName) return;
  if (Object.prototype.hasOwnProperty.call(meta, "repoName")) currentWorkspace.repoName = String(meta.repoName || "").trim();
  if (Object.prototype.hasOwnProperty.call(meta, "workspaceLocation")) {
    currentWorkspace.workspaceLocation = String(meta.workspaceLocation || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(meta, "gitBranch")) currentWorkspace.gitBranch = String(meta.gitBranch || "").trim();
  if (Object.prototype.hasOwnProperty.call(meta, "hostName")) currentHostName = String(meta.hostName || "").trim();
  if (!currentHostName && meta.health?.hostName) currentHostName = String(meta.health.hostName || "").trim();

  const snapshot = contextSnapshot();
  const displayMeta = snapshot.display || {};
  const repo = displayMeta.repoName || "";
  const location = displayMeta.workspaceLocation || "";
  const displayLocation = compactWorkspaceLocation(location);
  const branch = snapshot.bridge.gitBranch || displayMeta.gitBranch || currentWorkspace.gitBranch;
  if (workspaceSourceTag) workspaceSourceTag.textContent = snapshot.agent ? "実行中の場所" : "bridgeの場所";
  if (workspaceBranchTag) workspaceBranchTag.textContent = snapshot.agent ? "bridgeのブランチ" : "ブランチ";
  workspaceRepo.textContent = repo || "--";
  if (sidebarProjectName) sidebarProjectName.textContent = repo || location.split(/[\\/]/).filter(Boolean).pop() || "作業場所";
  workspaceLocation.textContent = displayLocation || "--";
  branchName.textContent = branch || "--";
  const empty = !repo && !location && !branch;
  workspaceIndicator.classList.toggle("empty", empty);
  const sourceLabel = snapshot.agent ? "実行中の場所" : "bridgeの場所";
  const label = empty ? "作業場所を取得できません" : `${sourceLabel}: ${repo || "--"} / 現在地: ${location || "--"} / ブランチ: ${branch || "--"}`;
  workspaceIndicator.title = label;
  workspaceIndicator.setAttribute("aria-label", label);
  workspaceIndicator.dataset.fullPath = location || repo || "";
  renderContextMismatch(snapshot);
  if (!selectedThread) {
    applyCurrentThreadAccent();
    activeDraftKey = currentThreadColorKey();
  }
  if (mainViewMode === "terminal") renderTerminalTranscript();
}

function setReady(ready) {
  connectionReady = ready;
  if (ready) {
    threadOpenFailures.delete(currentThreadColorKey());
    threadOpenFailureDetails.delete(currentThreadColorKey());
  }
  const bridgeState = getBridgeState(activeBridgeId);
  bridgeState.connected = ready;
  bridgeState.lastEventAt = Date.now();
  sendButton.disabled = !ready || Boolean(pendingSubmission);
  promptInput.disabled = false;
  composer.dataset.ready = ready ? "true" : "false";
  sendButton.title = pendingSubmission ? "送信確認中です" : ready ? "送信" : "接続後に送信できます";
  if (workspaceConnectionDot) workspaceConnectionDot.dataset.connected = ready ? "true" : "false";
  updateInterruptButton();
  updateThreadNavigation();
  updateHeaderStatus();
  updateComposerState();
  updateTerminalHeader();
  renderFleet();
}

function clientMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `phone-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileDraftSignature(files = pendingFiles) {
  return JSON.stringify(files.map((file) => [file.name, file.absolutePath || file.path || file.url || "", file.size || 0]));
}

function saveDraftForActiveThread() {
  const key = activeDraftKey || currentThreadColorKey();
  if (!key) return;
  const text = promptInput.value || "";
  if (text) threadDrafts[key] = text;
  else delete threadDrafts[key];
  if (pendingFiles.length) threadDraftFiles.set(key, pendingFiles.map((file) => ({ ...file })));
  else threadDraftFiles.delete(key);
  writeJsonStorage(threadDraftStorageKey, threadDrafts);
}

function restoreDraftForCurrentThread() {
  activeDraftKey = currentThreadColorKey();
  promptInput.value = threadDrafts[activeDraftKey] || "";
  pendingFiles = (threadDraftFiles.get(activeDraftKey) || []).map((file) => ({ ...file }));
  renderAttachments();
  autoGrowPrompt();
}

function migrateThreadScopedState(previousKey, nextKey) {
  if (!previousKey || !nextKey || previousKey === nextKey) return;
  if (Object.prototype.hasOwnProperty.call(threadDrafts, previousKey) && !Object.prototype.hasOwnProperty.call(threadDrafts, nextKey)) {
    threadDrafts[nextKey] = threadDrafts[previousKey];
    delete threadDrafts[previousKey];
    writeJsonStorage(threadDraftStorageKey, threadDrafts);
  }
  if (threadDraftFiles.has(previousKey) && !threadDraftFiles.has(nextKey)) {
    threadDraftFiles.set(nextKey, threadDraftFiles.get(previousKey));
    threadDraftFiles.delete(previousKey);
  }
  if (terminalHistories.has(previousKey) && !terminalHistories.has(nextKey)) {
    terminalHistories.set(nextKey, terminalHistories.get(previousKey));
  }
  if (Object.prototype.hasOwnProperty.call(chatScrollPositions, previousKey) && !Object.prototype.hasOwnProperty.call(chatScrollPositions, nextKey)) {
    chatScrollPositions[nextKey] = chatScrollPositions[previousKey];
    delete chatScrollPositions[previousKey];
    writeJsonStorage(chatScrollStorageKey, chatScrollPositions);
  }
  if (
    Object.prototype.hasOwnProperty.call(terminalScrollPositions, previousKey) &&
    !Object.prototype.hasOwnProperty.call(terminalScrollPositions, nextKey)
  ) {
    terminalScrollPositions[nextKey] = terminalScrollPositions[previousKey];
    delete terminalScrollPositions[previousKey];
    writeJsonStorage(terminalScrollStorageKey, terminalScrollPositions);
  }
}

function saveScrollPositions() {
  const key = currentThreadColorKey();
  if (!key) return;
  if (log) chatScrollPositions[key] = Math.round(log.scrollTop || 0);
  if (terminalTranscript) terminalScrollPositions[key] = Math.round(terminalTranscript.scrollTop || 0);
  writeJsonStorage(chatScrollStorageKey, chatScrollPositions);
  writeJsonStorage(terminalScrollStorageKey, terminalScrollPositions);
}

function restoreScrollPositions() {
  const key = currentThreadColorKey();
  requestAnimationFrame(() => {
    if (log && Object.prototype.hasOwnProperty.call(chatScrollPositions, key)) log.scrollTop = chatScrollPositions[key] || 0;
    if (terminalTranscript && Object.prototype.hasOwnProperty.call(terminalScrollPositions, key) && !liveTurnActive) {
      terminalTranscript.scrollTop = terminalScrollPositions[key] || 0;
    } else if (terminalTranscript && liveTurnActive) {
      terminalTranscript.scrollTop = terminalTranscript.scrollHeight;
    }
    updateTerminalLatestButton();
    updateChatLatestButton();
    // A restored position is not a reader travelling down the page, so it must
    // not read as one and take the composer away on arrival.
    if (log) lastLogScrollTop = log.scrollTop;
  });
}

function currentTerminalHistory() {
  const key = currentThreadColorKey();
  if (!terminalHistories.has(key)) terminalHistories.set(key, []);
  return terminalHistories.get(key);
}

function isTerminalSurfaceEntry(entry = {}) {
  return entry.source === "manual" && terminalSurfaceKinds.has(normalizeTerminalKind(entry.kind));
}

function currentTerminalSurfaceHistory() {
  return currentTerminalHistory().filter(isTerminalSurfaceEntry);
}

function capTerminalHistory(entries) {
  if (uiUtils.capTerminalHistory) return uiUtils.capTerminalHistory(entries, terminalHistoryLimit);
  return entries.slice(-terminalHistoryLimit);
}

function normalizeTerminalKind(kind) {
  if (uiUtils.normalizeTerminalKind) return uiUtils.normalizeTerminalKind(kind);
  const value = String(kind || "").toLowerCase();
  if (["command", "file", "error", "approval", "user", "assistant", "lifecycle"].includes(value)) return value;
  return "status";
}

function terminalFilterMatches(entry) {
  if (uiUtils.terminalEntryMatches) {
    return uiUtils.terminalEntryMatches(entry, { filter: terminalFilterMode, query: terminalSearchQuery });
  }
  if (terminalFilterMode !== "all" && normalizeTerminalKind(entry.kind) !== terminalFilterMode) return false;
  if (!terminalSearchQuery) return true;
  return `${entry.message || ""}\n${entry.detail || ""}`.toLowerCase().includes(terminalSearchQuery.toLowerCase());
}

function terminalTimestampLabel(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function filePathFromTerminalEntry(entry = {}) {
  const text = `${entry.message || ""}\n${entry.detail || ""}`;
  const match =
    text.match(/\b((?:docs|public|scripts|src|test|tests)\/[^\s:)]+(?:\.[A-Za-z0-9]+)?)/) ||
    text.match(/\b([A-Za-z0-9._-]+\.md)\b/);
  return match ? match[1].replace(/[.,;]+$/, "") : "";
}

function updateTerminalLatestButton() {
  if (!terminalLatestButton || !terminalTranscript) return;
  const nearBottom =
    terminalTranscript.scrollHeight - terminalTranscript.scrollTop - terminalTranscript.clientHeight < 40;
  terminalLatestButton.classList.toggle("hidden", terminalAutoScroll || nearBottom);
}

function terminalFilterLabel(filter = terminalFilterMode) {
  const labels = {
    all: "すべて",
    command: "コマンド",
    file: "ファイル",
    status: "状態",
    error: "エラー",
    approval: "承認",
    user: "ユーザー",
    assistant: "返信",
    lifecycle: "処理",
  };
  return labels[filter] || "状態";
}

function terminalUserName() {
  const cwd = currentWorkspaceWorkdir() || currentWorkspace.workspaceLocation || "";
  const match = String(cwd).replace(/\\/g, "/").match(/^\/Users\/([^/]+)/);
  return match?.[1] || "user";
}

function terminalHostLabel() {
  return (currentHostName || location.hostname || "host").replace(/\.local$/i, "");
}

function terminalCwdLabel() {
  const cwd = currentWorkspaceWorkdir() || currentWorkspace.workspaceLocation || "";
  const repo = currentWorkspace.repoName || basenameFromPath(cwd) || "~";
  if (!cwd || cwd === ".") return repo;
  const normalized = String(cwd).replace(/\\/g, "/");
  const user = terminalUserName();
  if (normalized === `/Users/${user}`) return "~";
  if (normalized.startsWith(`/Users/${user}/`)) return `~/${compactWorkspaceLocation(normalized.slice(`/Users/${user}/`.length))}`;
  if (!normalized.startsWith("/")) return repo && normalized === "." ? repo : normalized;
  return compactWorkspaceLocation(normalized);
}

function renderTerminalPromptLine() {
  const row = document.createElement("div");
  row.className = "terminal-prompt-line";
  const label = document.createElement("span");
  label.className = "terminal-prompt-label";
  label.textContent = `${terminalUserName()}@${terminalHostLabel()} ${terminalCwdLabel()} %`;
  const cursor = document.createElement("span");
  cursor.className = "terminal-prompt-cursor";
  cursor.setAttribute("aria-hidden", "true");
  row.append(label, cursor);
  return row;
}

function toggleTerminalToolsSheet(open) {
  if (!terminalToolsSheet) return;
  const willOpen = open ?? terminalToolsSheet.classList.contains("hidden");
  terminalToolsSheet.classList.toggle("hidden", !willOpen);
  terminalToolsButton?.setAttribute("aria-expanded", String(willOpen));
  terminalFilterSheetButton?.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) terminalToolsSheet.scrollTop = 0;
  measureTerminalLayout();
}

function setTerminalAutoScroll(enabled, { toast = true, render = true } = {}) {
  terminalAutoScroll = Boolean(enabled);
  terminalAutoScrollButton?.classList.toggle("active", terminalAutoScroll);
  terminalAutoScrollButton?.setAttribute("aria-pressed", String(terminalAutoScroll));
  terminalAutoScrollMini?.classList.toggle("active", terminalAutoScroll);
  terminalAutoScrollMini?.setAttribute("aria-pressed", String(terminalAutoScroll));
  if (terminalAutoScroll) {
    if (terminalTranscript) terminalTranscript.scrollTop = terminalTranscript.scrollHeight;
    if (render) renderTerminalTranscript();
  } else if (toast) {
    showToast("ログの自動スクロールを一時停止しました。");
  }
  updateTerminalLatestButton();
}

function updateTerminalInputModeButton() {
  document.body.dataset.terminalInputMode = terminalInputMode;
  if (terminalInputModeButton) {
    terminalInputModeButton.textContent = terminalInputMode === "keys" ? "キー操作" : "文章";
    terminalInputModeButton.setAttribute("aria-pressed", String(terminalInputMode === "keys"));
    terminalInputModeButton.title = terminalInputMode === "keys" ? "キー操作モード" : "文章入力モード";
  }
  terminalQuickbarPinButton?.classList.toggle("active", terminalQuickbarPinned);
  terminalQuickbarPinButton?.setAttribute("aria-pressed", String(terminalQuickbarPinned));
}

function updateQuickBarVisibility() {
  const visible = uiUtils.shouldShowQuickBar
    ? uiUtils.shouldShowQuickBar({
        mainViewMode,
        inputFocused: promptInputFocused,
        inputMode: terminalInputMode,
        pinned: terminalQuickbarPinned,
      })
    : mainViewMode === "terminal" && (promptInputFocused || terminalInputMode === "keys" || terminalQuickbarPinned);
  document.body.classList.toggle("terminal-quickbar-visible", visible);
  document.body.classList.toggle("composer-focused", promptInputFocused);
  updateTerminalInputModeButton();
  measureTerminalLayout();
}

function setTerminalQuickbarPinned(enabled) {
  terminalQuickbarPinned = Boolean(enabled);
  safeWriteStorage(localStorage, terminalQuickbarPinStorageKey, terminalQuickbarPinned ? "1" : "0");
  updateQuickBarVisibility();
}

function updateTerminalFilterControls() {
  if (terminalFilter) terminalFilter.value = terminalFilterMode;
  for (const chip of terminalFilterChips) {
    const active = chip.dataset.terminalFilter === terminalFilterMode;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
  const surfaceEntries = currentTerminalSurfaceHistory();
  const visibleCount = surfaceEntries.filter(terminalFilterMatches).length;
  const totalCount = surfaceEntries.length;
  if (terminalCurrentFilterPill) terminalCurrentFilterPill.textContent = terminalFilterLabel(terminalFilterMode);
  if (terminalCompactSearchCount) terminalCompactSearchCount.textContent = terminalSearchQuery ? `${visibleCount}/${totalCount}` : String(totalCount);
  setTerminalAutoScroll(terminalAutoScroll, { toast: false, render: false });
}

function renderTerminalTranscript() {
  if (!terminalTranscript) return;
  const surfaceEntries = currentTerminalSurfaceHistory();
  const entries = surfaceEntries.filter(terminalFilterMatches);
  const query = terminalSearchQuery.trim().toLowerCase();
  terminalTranscript.replaceChildren();
  if (terminalSearchCount) terminalSearchCount.textContent = query ? String(entries.length) : String(surfaceEntries.length);
  if (terminalCompactSearchCount) {
    terminalCompactSearchCount.textContent = query ? `${entries.length}/${surfaceEntries.length}` : String(surfaceEntries.length);
  }
  if (!entries.length) {
    if (query) {
      const empty = document.createElement("div");
      empty.className = "terminal-empty";
      empty.textContent = "検索条件に一致する出力はありません。";
      terminalTranscript.appendChild(empty);
    } else {
      terminalTranscript.appendChild(renderTerminalPromptLine());
    }
    return;
  }
  terminalSearchIndex = Math.min(Math.max(0, terminalSearchIndex), Math.max(0, entries.length - 1));
  for (const [index, entry] of entries.entries()) {
    const row = document.createElement("div");
    row.className = `terminal-line ${normalizeTerminalKind(entry.kind)}${query && index === terminalSearchIndex ? " search-active" : ""}`;
    const time = document.createElement("time");
    time.dateTime = new Date(Number(entry.ts) || Date.now()).toISOString();
    time.textContent = terminalTimestampLabel(entry.ts);
    const kind = document.createElement("span");
    kind.className = "terminal-kind";
    kind.textContent = terminalFilterLabel(normalizeTerminalKind(entry.kind));
    const message = document.createElement("span");
    message.className = "terminal-message";
    message.textContent = entry.message || "";
    row.append(time, kind, message);
    const filePath = filePathFromTerminalEntry(entry);
    if (filePath) {
      const openFile = document.createElement("button");
      openFile.type = "button";
      openFile.className = "terminal-open-file";
      openFile.textContent = "表示";
      openFile.addEventListener("click", () => showArtifact(filePath));
      row.appendChild(openFile);
    }
    if (entry.detail) {
      const detail = document.createElement("pre");
      detail.className = "terminal-detail";
      detail.textContent = entry.detail;
      row.appendChild(detail);
    }
    terminalTranscript.appendChild(row);
  }
  if (!query) terminalTranscript.appendChild(renderTerminalPromptLine());
  if (terminalAutoScroll) terminalTranscript.scrollTop = terminalTranscript.scrollHeight;
  updateTerminalLatestButton();
}

function appendTerminalEntry(entry, { key = currentThreadColorKey() } = {}) {
  if (!entry) return;
  const normalized = uiUtils.normalizeTerminalEntry
    ? uiUtils.normalizeTerminalEntry(entry)
    : {
        id: entry.id || `client-terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: Number(entry.ts) || Date.now(),
        kind: normalizeTerminalKind(entry.kind),
        message: String(entry.message || "").slice(0, 1200),
        detail: entry.detail ? String(entry.detail).slice(0, 4000) : "",
        source: entry.source || null,
      };
  const history = capTerminalHistory([...(terminalHistories.get(key) || []), normalized]);
  terminalHistories.set(key, history);
  if (key === currentThreadColorKey() && mainViewMode !== "terminal" && isTerminalSurfaceEntry(normalized)) {
    unreadTerminalCount += 1;
    updateUnreadBadges();
  }
  if (key === currentThreadColorKey()) renderTerminalTranscript();
  if (key === currentThreadColorKey()) refreshReviewCenterIfOpen();
}

function replaceTerminalHistory(entries = [], { key = currentThreadColorKey() } = {}) {
  const normalized = capTerminalHistory(
    (entries || []).map((entry) =>
      uiUtils.normalizeTerminalEntry
        ? uiUtils.normalizeTerminalEntry(entry)
        : {
            id: entry.id || `terminal-${entry.ts || Date.now()}-${Math.random().toString(16).slice(2)}`,
            ts: Number(entry.ts) || Date.now(),
            kind: normalizeTerminalKind(entry.kind),
            message: String(entry.message || "").slice(0, 1200),
            detail: entry.detail ? String(entry.detail).slice(0, 4000) : "",
            source: entry.source || null,
          },
      ),
  );
  terminalHistories.set(key, normalized);
  if (key === currentThreadColorKey()) renderTerminalTranscript();
  if (key === currentThreadColorKey()) refreshReviewCenterIfOpen();
}

function terminalHistoryFromChatHistory(history = []) {
  return capTerminalHistory(
    history
      .map((entry, index) => {
        const text = String(entry.text || "").trim();
        if (!text) return null;
        if (entry.type === "error") return { id: `history-error-${index}`, ts: Date.now(), kind: "error", message: text };
        if (entry.type !== "status") return null;
        if (!/^\$\s/.test(text)) return null;
        return { id: `history-status-${index}`, ts: Date.now(), kind: "command", message: text };
      })
      .filter(Boolean),
  );
}

function terminalEntryFromMessage(msg) {
  const now = Date.now();
  if (msg.type === "runState") return { ts: now, kind: "status", message: `状態: ${msg.label || runStateShortLabel(msg.state) || "更新"}` };
  if (msg.type === "status") {
    const text = String(msg.text || "");
    const kind = /^\$\s/.test(text) ? "command" : /file changes|ファイル/i.test(text) ? "file" : "status";
    return { ts: now, kind, message: text };
  }
  if (msg.type === "error") return { ts: now, kind: "error", message: msg.text || "エラー" };
  if (msg.type === "approval") return { ts: now, kind: "approval", message: `承認リクエスト: ${approvalLabelForRequest(msg.request)}` };
  if (msg.type === "turn") return { ts: now, kind: "lifecycle", message: `処理${msg.status === "completed" ? "完了" : msg.status === "started" ? "開始" : "更新"}${msg.turnId ? `: ${msg.turnId}` : ""}` };
  if (msg.type === "user") return { ts: now, kind: "user", message: "入力を送信しました" };
  if (msg.type === "event" && msg.event?.method) return { ts: now, kind: "status", message: `状態更新: ${msg.event.method}` };
  return null;
}

const askQuestionToolName = "AskUserQuestion";

// A question reaches the phone down the approval channel like any other tool
// call, but 許可/拒否 is not an answer to it: allowed as-is under `claude -p` it
// comes straight back with "The user did not answer the questions." and the
// turn carries on from its own guess. So a question is drawn as a question.
function questionsForApproval(request = {}) {
  const params = request.params || {};
  if (params.toolName !== askQuestionToolName) return [];
  const questions = params.input?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter((question) => question && typeof question.question === "string" && question.question);
}

function answerValueForQuestion(question) {
  const draft = questionAnswerDraft.get(question.question);
  if (!draft) return "";
  const chosen = Array.from(draft.selected);
  const written = draft.other.trim();
  if (written) chosen.push(written);
  return chosen.join(", ");
}

function collectQuestionAnswers(questions) {
  const answers = {};
  for (const question of questions) {
    const value = answerValueForQuestion(question);
    if (value) answers[question.question] = value;
  }
  return answers;
}

// Half an answer is worse than none - Claude would take the one reply as the
// whole of it - so the send stays shut until every question has something.
function updateApprovalAnswerState(questions) {
  if (!approveButton || !questions.length) return;
  const answered = questions.filter((question) => answerValueForQuestion(question)).length;
  approveButton.disabled = answered < questions.length;
  approveButton.textContent = questions.length > 1 ? `回答を送信(${answered}/${questions.length})` : "回答を送信";
}

function renderApprovalQuestions(request) {
  const questions = questionsForApproval(request);
  questionAnswerDraft = new Map();
  if (!approvalQuestions) return questions;
  approvalQuestions.replaceChildren();
  approvalQuestions.classList.toggle("hidden", !questions.length);
  if (!questions.length) return questions;

  questions.forEach((question, index) => {
    questionAnswerDraft.set(question.question, { selected: new Set(), other: "" });
    const card = document.createElement("div");
    card.className = "approval-question";

    const header = document.createElement("div");
    header.className = "approval-question-header";
    const heading = String(question.header || "確認");
    header.textContent = questions.length > 1 ? `${index + 1}/${questions.length}・${heading}` : heading;
    if (question.multiSelect) header.textContent += "（複数選択可）";
    card.appendChild(header);

    const text = document.createElement("p");
    text.className = "approval-question-text";
    text.textContent = question.question;
    card.appendChild(text);

    const options = document.createElement("div");
    options.className = "approval-options";
    const buttons = [];
    for (const option of Array.isArray(question.options) ? question.options : []) {
      const label = String(option?.label || "").trim();
      if (!label) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "approval-option";
      button.dataset.label = label;
      button.setAttribute("aria-pressed", "false");
      const mark = document.createElement("span");
      mark.className = "approval-option-mark";
      mark.dataset.multi = String(Boolean(question.multiSelect));
      mark.setAttribute("aria-hidden", "true");
      const body = document.createElement("span");
      body.className = "approval-option-body";
      const name = document.createElement("span");
      name.className = "approval-option-label";
      name.textContent = label;
      body.appendChild(name);
      if (option.description) {
        const description = document.createElement("span");
        description.className = "approval-option-description";
        description.textContent = String(option.description);
        body.appendChild(description);
      }
      button.append(mark, body);
      button.addEventListener("click", () => {
        const draft = questionAnswerDraft.get(question.question);
        if (!draft) return;
        if (draft.selected.has(label)) draft.selected.delete(label);
        else {
          // One answer unless the tool asked for several, so a second tap moves
          // the choice rather than piling a second one on top of it.
          if (!question.multiSelect) draft.selected.clear();
          draft.selected.add(label);
        }
        for (const sibling of buttons) sibling.setAttribute("aria-pressed", String(draft.selected.has(sibling.dataset.label)));
        updateApprovalAnswerState(questions);
      });
      buttons.push(button);
      options.appendChild(button);
    }
    card.appendChild(options);

    // Claude's own question UI always offers a free-text "Other", and a phone
    // held to the listed options alone cannot say the thing that is true.
    const other = document.createElement("input");
    other.type = "text";
    other.className = "approval-question-other";
    other.placeholder = options.childElementCount ? "その他（自由に入力）" : "回答を入力";
    other.setAttribute("aria-label", `${heading}の自由回答`);
    other.addEventListener("input", () => {
      const draft = questionAnswerDraft.get(question.question);
      if (!draft) return;
      draft.other = other.value;
      updateApprovalAnswerState(questions);
    });
    card.appendChild(other);
    approvalQuestions.appendChild(card);
  });

  updateApprovalAnswerState(questions);
  return questions;
}

function approvalLabelForRequest(request = {}) {
  if (request.params?.toolName === askQuestionToolName) return "質問";
  const method = String(request.method || "");
  if (/commandExecution/i.test(method)) return "コマンド";
  if (/fileChange/i.test(method)) return "ファイル変更";
  if (/applyPatch|write|edit/i.test(JSON.stringify(request.params || {}))) return "変更";
  return "確認";
}

function renderApprovalRequest(request) {
  const label = approvalLabelForRequest(request);
  const questions = renderApprovalQuestions(request);
  const asking = questions.length > 0;
  approval.dataset.kind = asking ? "question" : "approval";
  if (approvalTitle) approvalTitle.textContent = asking ? "質問が届いています" : "承認リクエスト";
  if (approvalKind) approvalKind.textContent = label;
  if (approvalSummary) approvalSummary.textContent = asking ? "Claudeが送ってきた内容" : `${label}の承認が必要です`;
  approvalText.textContent = JSON.stringify(request?.params || request || {}, null, 2);
  // The raw payload is the whole card for a tool call and pure noise under a
  // question that has already been laid out in full above it.
  if (approvalDetails) approvalDetails.open = !asking;
  if (approvalReason) {
    approvalReason.value = "";
    approvalReason.classList.toggle("hidden", asking);
  }
  if (declineButton) declineButton.textContent = asking ? "回答しない" : "拒否";
  if (approveButton && !asking) {
    approveButton.disabled = false;
    approveButton.textContent = "承認";
  }
  approval.classList.remove("hidden");
  renderApprovalStrip(request);
  appendTerminalEntry({
    ts: Date.now(),
    kind: "approval",
    message: asking ? `質問${questions.length}件が届きました` : `${label}の承認待ち`,
  });
}

function renderApprovalStrip(request = pendingApproval) {
  if (!approvalStrip) return;
  approvalStrip.replaceChildren();
  approvalStrip.classList.toggle("hidden", !request);
  if (!request) return;
  const asking = questionsForApproval(request).length > 0;
  const text = document.createElement("span");
  text.textContent = `${asking ? "質問" : "承認待ち"}: ${approvalSummaryText(request)}`;
  if (asking) {
    // 許可 cannot answer a question, so the strip's job here is to put the card
    // in front of the operator rather than to decide anything on its own.
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "回答する";
    open.addEventListener("click", () => revealPendingApproval());
    const later = document.createElement("button");
    later.type = "button";
    later.className = "secondary";
    later.textContent = "回答しない";
    later.addEventListener("click", () => declineButton?.click());
    approvalStrip.append(text, open, later);
    return;
  }
  const details = document.createElement("button");
  details.type = "button";
  details.className = "secondary";
  details.textContent = "詳細";
  details.addEventListener("click", () => approval?.scrollIntoView({ block: "center", behavior: "smooth" }));
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = "許可";
  accept.addEventListener("click", () => approveButton?.click());
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "secondary";
  reject.textContent = "拒否";
  reject.addEventListener("click", () => declineButton?.click());
  approvalStrip.append(text, details, accept, reject);
}

function handleTerminalMessage(msg) {
  if (msg.type === "ready") {
    const entries = Array.isArray(msg.terminalHistory) && msg.terminalHistory.length ? msg.terminalHistory : terminalHistoryFromChatHistory(msg.history || []);
    replaceTerminalHistory(entries);
    return;
  }
  appendTerminalEntry(msg.terminalEntry || terminalEntryFromMessage(msg));
}

function setPendingSubmission(submission) {
  if (pendingSubmissionTimer) window.clearTimeout(pendingSubmissionTimer);
  pendingSubmission = submission;
  composer.dataset.submitting = "true";
  setReady(connectionReady);
  pendingSubmissionTimer = window.setTimeout(() => {
    if (!pendingSubmission || pendingSubmission.id !== submission.id) return;
    releasePendingSubmission("送信確認がタイムアウトしました。");
  }, 12_000);
}

function clearPendingSubmissionTimer() {
  if (!pendingSubmissionTimer) return;
  window.clearTimeout(pendingSubmissionTimer);
  pendingSubmissionTimer = null;
}

function acceptPendingSubmission(clientMessageIdValue) {
  if (!clientMessageIdValue || !pendingSubmission || pendingSubmission.id !== clientMessageIdValue) return false;
  const shouldClearDraft =
    promptInput.value === pendingSubmission.inputValue && fileDraftSignature() === pendingSubmission.fileSignature;
  pendingSubmission = null;
  composer.dataset.submitting = "false";
  clearPendingSubmissionTimer();
  if (shouldClearDraft) {
    promptInput.value = "";
    pendingFiles = [];
    renderAttachments();
    autoGrowPrompt();
    saveDraftForActiveThread();
  } else {
    addStatus("送信は受理されました。入力欄は変更されているため残しました。");
    saveDraftForActiveThread();
  }
  setReady(connectionReady);
  return true;
}

function releasePendingSubmission(message = "") {
  if (!pendingSubmission) return;
  const submission = pendingSubmission;
  pendingSubmission = null;
  composer.dataset.submitting = "false";
  clearPendingSubmissionTimer();
  if (!promptInput.value && submission.inputValue) promptInput.value = submission.inputValue;
  if (!pendingFiles.length && submission.files?.length) {
    pendingFiles = submission.files.map((file) => ({ ...file }));
    renderAttachments();
  }
  saveDraftForActiveThread();
  setReady(connectionReady);
  if (message) addStatus(`${message} 入力は残しています。`);
}

function renderHistory(history) {
  // A redraw that lands mid-turn used to leave `assistantEntry` pointing at the
  // bubble it had just thrown away, so every delta after it wrote into a node
  // that is no longer in the log: the answer appeared, vanished, and never came
  // back. The text is carried across instead, into a bubble that is on screen.
  const liveText = assistantEntry?.markdownSource || "";
  // replaceChildren() drops scrollTop to 0, and the rebuild re-runs addEntry for
  // every message, so each one would read "near the bottom" off a log that is
  // still empty. Take the reader's position before the wipe, put it back after.
  const stickToBottom = isChatNearBottom();
  const previousScrollTop = log.scrollTop;
  chatBulkRender = true;
  try {
    renderHistoryEntries(history, liveText);
  } finally {
    chatBulkRender = false;
  }
  if (stickToBottom) {
    scrollChatToBottom();
    return;
  }
  log.scrollTop = previousScrollTop;
  updateChatLatestButton();
}

function renderHistoryEntries(history, liveText) {
  log.replaceChildren();
  statusGroup = null;
  assistantEntry = null;
  let currentAssistant = null;
  const outputGroupLastIndex = new Map();
  for (const [index, entry] of (history || []).entries()) {
    if (entry.type !== "assistant" || !entry.outputGroup) continue;
    outputGroupLastIndex.set(entry.outputGroup, index);
  }
  for (const [index, entry] of (history || []).entries()) {
    const outputGroup = entry.outputGroup || "";
    const showBulkCopy = entry.type === "assistant" && outputGroup && outputGroupLastIndex.get(outputGroup) === index;
    const rendered = addEntry(entry.type, entry.text, entry.attachments || [], {
      outputGroup,
      showBulkCopy,
    });
    if (liveTurnActive && outputGroup === liveOutputGroup && entry.type === "assistant") currentAssistant = rendered;
  }
  syncLogEmptyState();
  if (!liveText || !liveTurnActive) {
    assistantEntry = currentAssistant;
    return;
  }
  // Unless the history being drawn already ends with what was streamed, in
  // which case re-adding it would show the same answer twice.
  const alreadyDrawn = (history || []).some((entry) => entry.type === "assistant" && String(entry.text || "").includes(liveText));
  if (alreadyDrawn) {
    assistantEntry = currentAssistant;
    return;
  }
  assistantEntry = addEntry("assistant", liveText, [], {
    outputGroup: liveOutputGroup || "",
    showBulkCopy: true,
  });
}

function historySignature(history = []) {
  return JSON.stringify(
    history.map((entry) => ({
      type: entry.type,
      text: entry.text || "",
      outputGroup: entry.outputGroup || "",
      attachments: (entry.attachments || []).map((attachment) => attachment.name || attachment.url || ""),
    })),
  );
}

function renderHistoryIfChanged(history = []) {
  const signature = historySignature(history);
  if (signature === lastHistorySignature) return false;
  lastHistorySignature = signature;
  renderHistory(history);
  return true;
}

function normalizeThreadRecord(thread, provider) {
  const nextProvider = normalizeProviderName(thread.provider) || normalizeProviderName(provider) || currentThreadProvider();
  const updatedAt = uiUtils.threadTimestamp
    ? uiUtils.threadTimestamp({
        updatedAt: thread.updatedAt,
        updated_at_ms: thread.updated_at_ms,
        updated_at: thread.updated_at,
      })
    : thread.updatedAt || thread.updated_at || thread.updated_at_ms;
  const createdAt = uiUtils.threadTimestamp
    ? uiUtils.threadTimestamp({
        createdAt: thread.createdAt,
        created_at_ms: thread.created_at_ms,
        created_at: thread.created_at,
      })
    : thread.createdAt || thread.created_at || thread.created_at_ms;
  return {
    ...thread,
    provider: nextProvider,
    updatedAt,
    createdAt,
    displayTitle: thread.displayTitle || "",
  };
}

function sameThreadRecord(a = {}, b = {}) {
  return (
    String(a.id || "") === String(b.id || "") &&
    normalizeProviderName(a.provider) === normalizeProviderName(b.provider)
  );
}

function threadRecordKey(thread = {}, provider = currentThreadProvider()) {
  const id = String(thread.id || "").trim();
  if (!id) return "";
  const nextProvider = normalizeProviderName(thread.provider) || normalizeProviderName(provider) || currentThreadProvider();
  return `${nextProvider}:${id}`;
}

function mergeThreadCacheRecords(serverThreads = [], localThreads = [], provider = currentThreadProvider()) {
  const resultProvider = normalizeProviderName(provider) || currentThreadProvider();
  const localByKey = new Map();
  for (const thread of localThreads || []) {
    if (!thread?.id) continue;
    const normalized = normalizeThreadRecord(thread, thread.provider || resultProvider);
    const key = threadRecordKey(normalized, resultProvider);
    if (key) localByKey.set(key, normalized);
  }

  const merged = [];
  const seen = new Set();
  for (const thread of serverThreads || []) {
    if (!thread?.id) continue;
    const normalized = normalizeThreadRecord(thread, thread.provider || resultProvider);
    const key = threadRecordKey(normalized, resultProvider);
    if (!key || seen.has(key)) continue;
    const local = localByKey.get(key) || {};
    merged.push({
      ...local,
      ...normalized,
      name: normalized.name || local.name,
      preview: normalized.preview || local.preview,
      displayTitle: normalized.displayTitle || local.displayTitle || "",
      cwd: normalized.cwd || local.cwd,
      workdir: normalized.workdir || local.workdir,
      workspaceLocation: normalized.workspaceLocation || local.workspaceLocation,
      repoName: normalized.repoName || local.repoName,
      gitBranch: normalized.gitBranch || local.gitBranch,
      lastViewedAt: normalized.lastViewedAt || local.lastViewedAt || 0,
      updatedAt: normalized.updatedAt || local.updatedAt || 0,
      createdAt: normalized.createdAt || local.createdAt || 0,
    });
    seen.add(key);
  }

  for (const thread of localByKey.values()) {
    const key = threadRecordKey(thread, resultProvider);
    const localProvider = normalizeProviderName(thread.provider) || resultProvider;
    if (!key || seen.has(key) || localProvider !== resultProvider) continue;
    merged.push(thread);
    seen.add(key);
  }
  return merged;
}

function upsertThreadRecord(thread, provider = currentThreadProvider()) {
  if (!thread?.id) return null;
  const normalized = normalizeThreadRecord(thread, provider);
  const existingIndex = threadCache.findIndex((item) => sameThreadRecord(item, normalized));
  if (existingIndex >= 0) {
    threadCache = threadCache.map((item, index) => (index === existingIndex ? { ...item, ...normalized } : item));
  } else {
    threadCache = [normalized, ...threadCache];
  }
  const state = getBridgeState(activeBridgeId);
  state.threadCache = threadCache;
  return normalized;
}

function visibleThreadGroups(options = {}) {
  const includeSelected = options.includeSelected !== false;
  const query = threadSearch.value.trim().toLowerCase();
  const records = fleetThreadRecords();
  // Naming the Mac on every heading when there is only one is noise, so the
  // list says it exactly when it has two answers to tell apart.
  const showMachine = (uiUtils.machineScopeCount ? uiUtils.machineScopeCount(records) : 1) > 1;
  const groups = new Map();
  for (const thread of sortThreadsForInbox(records)) {
    const project = projectForThread(thread);
    const title = titleForThread(thread);
    const machineLabel = String(thread.machineLabel || "");
    const selected = thread.id === selectedThread && isActiveBridgeThread(thread);
    if (!includeSelected && selected) continue;
    const matches =
      !query ||
      project.toLowerCase().includes(query) ||
      title.toLowerCase().includes(query) ||
      machineLabel.toLowerCase().includes(query);
    if (!matches) continue;
    if (!selected && !threadMatchesInboxFilter(thread)) continue;
    const key = uiUtils.threadProjectGroupKey ? uiUtils.threadProjectGroupKey(project, thread.machineKey) : project;
    if (!groups.has(key)) {
      groups.set(key, { key, label: project, machineLabel, machineKey: thread.machineKey || "", bridgeId: thread.bridgeId || activeBridgeId, showMachine, threads: [] });
    }
    groups.get(key).threads.push(thread);
  }
  if (includeSelected && selectedThread) {
    for (const [key, group] of groups) {
      if (!group.threads.some((thread) => thread.id === selectedThread && isActiveBridgeThread(thread))) continue;
      const selectedFirst = new Map([[key, group]]);
      for (const [otherKey, otherGroup] of groups) {
        if (otherKey !== key) selectedFirst.set(otherKey, otherGroup);
      }
      return selectedFirst;
    }
  }
  return groups;
}

function currentThreadListRecord(overrides = {}) {
  if (!selectedThread) return null;
  const existing = selectedThreadRecord();
  if (existing) {
    return normalizeThreadRecord(
      {
        ...existing,
        ...overrides,
        id: selectedThread,
        provider: overrides.provider || existing.provider || currentThreadProvider(),
      },
      overrides.provider || existing.provider || currentThreadProvider(),
    );
  }
  // A chat the bridge cannot list yet gets its stand-in record built here, and
  // the folder on it is the one the rest of the app reads back. The folder this
  // chat was opened in is a fact; the workspace on screen is only whatever was
  // last shown, which on a fresh load is the bridge's own folder - so it is
  // marked as the guess it is rather than passing for the chat's own.
  const remembered = rememberedThreadWorkdir(selectedThread);
  const record = {
    id: selectedThread,
    provider: currentThreadProvider(),
    displayTitle: "現在のチャット",
    cwd: remembered || currentWorkspace.workspaceLocation || currentWorkspace.repoName || "",
    updatedAt: 0,
    runState: currentRunState,
    ...overrides,
  };
  if (!remembered && !overrides.cwd) record.cwdGuessed = true;
  return normalizeThreadRecord(record, overrides.provider || currentThreadProvider());
}

function preserveSelectedThreadInList(overrides = {}) {
  const current = currentThreadListRecord(overrides);
  if (!current) return null;
  return upsertThreadRecord(current, current.provider || currentThreadProvider());
}

function markSelectedThreadViewed(overrides = {}) {
  return preserveSelectedThreadInList({ ...overrides, lastViewedAt: Date.now() });
}

function markThreadViewed(thread, provider = currentThreadProvider()) {
  if (!thread?.id) return null;
  return upsertThreadRecord({ ...thread, lastViewedAt: Date.now() }, provider);
}

function createThreadListItem(thread, options = {}) {
  const displayTitle = options.displayTitle || titleForThread(thread);
  const repoColor = repoColorForThread(thread);
  const repoLabel = repoLabelForContext(thread, "");
  const colorSubject = repoLabel ? `${repoLabel} のリポ色` : "リポ色";
  const item = document.createElement("div");
  item.className = thread.id === selectedThread && isActiveBridgeThread(thread) ? "thread-item active" : "thread-item";
  item.title = displayTitle;
  item.style.setProperty("--item-thread-accent", repoColor);
  const colorButton = document.createElement("button");
  colorButton.type = "button";
  colorButton.className = "thread-color-button";
  colorButton.title = `${colorSubject}を変更`;
  colorButton.setAttribute("aria-label", `${colorSubject}を変更`);
  colorButton.style.backgroundColor = repoColor;
  colorButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openThreadColorPanel(thread);
  });
  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "thread-select";
  const title = document.createElement("span");
  title.className = "thread-title";
  title.textContent = displayTitle;
  const time = document.createElement("span");
  time.className = "thread-time";
  time.textContent = formatRelativeTime(thread.updatedAt || thread.createdAt);
  const status = deriveThreadStatus(thread);
  selectButton.append(title, time);
  const machineLabel = String(thread.machineLabel || "");
  const threadWorkdir = workspaceKeyForThread(thread);
  if (threadWorkdir) item.title = machineLabel ? `${displayTitle}\n${machineLabel}: ${threadWorkdir}` : `${displayTitle}\n${threadWorkdir}`;
  // Under a project heading almost every row repeats the folder that heading
  // already names, and a second line of it per row is what makes the list hard
  // to read. It is kept for the rows that genuinely sit somewhere else, which
  // is the only case where it says anything.
  const showsPlace = Boolean(threadWorkdir && threadWorkdir !== options.groupWorkdir);
  // Which Mac shares that line, because "where is this work" is one question:
  // the same `~/WORK_LOCAL/…` folder name exists on both of them.
  const showsMachine = Boolean(options.showMachine && machineLabel);
  if (showsPlace || showsMachine) {
    const workdir = document.createElement("span");
    workdir.className = "thread-workdir";
    if (showsMachine) {
      const machine = document.createElement("span");
      machine.className = "thread-machine";
      machine.textContent = machineLabel;
      applyMachineAccent(machine, machineLabel, thread.machineKey);
      workdir.appendChild(machine);
    }
    if (showsPlace) {
      const place = document.createElement("span");
      place.className = "thread-workdir-name";
      // With no heading overhead to name the project, the folder is what the
      // row needs to say. An elided path spends its width on the shared prefix
      // and truncates the one segment that identifies the work.
      place.textContent = options.showFolderName ? projectForThread(thread) : compactWorkspaceLocation(threadWorkdir);
      workdir.appendChild(place);
    }
    workdir.title = machineLabel ? `${machineLabel}: ${threadWorkdir}` : threadWorkdir;
    selectButton.append(workdir);
  }
  if (status.label) {
    const badge = document.createElement("span");
    badge.className = `thread-status-badge thread-status-badge-${status.tone || status.key}`;
    badge.textContent = status.label;
    selectButton.append(badge);
  }
  selectButton.addEventListener("click", () =>
    selectThread(thread.id, {
      thread,
      bridgeId: thread.bridgeId || "",
      workdir: workspaceKeyForThread(thread),
      project: projectForThread(thread),
    }),
  );
  item.append(colorButton, selectButton);
  const resumeCommand = resumeCommandForThread(thread);
  if (resumeCommand) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "thread-resume-copy";
    copyButton.title = resumeCommand;
    copyButton.setAttribute("aria-label", `${displayTitle} をどちらの Mac からでも再開するコマンドをコピー`);
    const glyph = document.createElement("span");
    glyph.className = "resume-copy-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = ">_";
    copyButton.appendChild(glyph);
    copyButton.addEventListener("click", async (event) => {
      // The row itself opens the chat; copying is a separate intent.
      event.stopPropagation();
      try {
        await copyTextToClipboard(resumeCommand);
        showToast("再開コマンドをコピーしました。Mac の「ターミナル」アプリに貼り付けてください。Codex の入力欄には貼り付けません。");
      } catch (error) {
        // Without a clipboard there is still something useful to do: show the
        // command so it can be read off the screen.
        showToast(`コピーできませんでした: ${error.message}`, "warn");
        window.prompt("ターミナルに貼り付けてください", resumeCommand);
      }
    });
    item.append(copyButton);
  }
  return item;
}

function limitedVisibleThreads(threads, limit = 6) {
  if (uiUtils.limitThreadList) return uiUtils.limitThreadList(threads, limit);
  const list = Array.isArray(threads) ? threads : [];
  const max = Math.max(0, Number(limit || 0));
  return list.slice(0, max);
}

function visibleThreadsInListOrder() {
  const threads = [];
  const baseKey = currentThreadWorkspaceKey();
  const groups = visibleThreadGroups();
  if (!selectedThreadVisibleInGroups(groups)) {
    const current = currentThreadListRecord();
    if (current && isSameCurrentWorkspaceThread(current, baseKey)) threads.push(current);
  }
  for (const group of groups.values()) {
    // Swiping moves between chats in the same place on the same Mac; a chat the
    // arrows reach has to be one this connection can actually open.
    const scopedThreads = group.threads.filter((thread) => isActiveBridgeThread(thread) && isSameCurrentWorkspaceThread(thread, baseKey));
    // Follows the sidebar: a row you can see is a row the arrows should reach.
    threads.push(...limitedVisibleThreads(scopedThreads, projectVisibleLimit(group.key, scopedThreads.length)));
  }
  return threads;
}

function selectedThreadVisibleInGroups(groups) {
  if (!selectedThread) return false;
  const baseKey = currentThreadWorkspaceKey();
  for (const group of groups.values()) {
    const scopedThreads = group.threads.filter((thread) => isActiveBridgeThread(thread) && isSameCurrentWorkspaceThread(thread, baseKey));
    if (limitedVisibleThreads(scopedThreads, 6).some((thread) => thread.id === selectedThread)) return true;
  }
  return false;
}

const collapsedProjectRows = 6;
const collapsedRecentRows = 30;

function projectVisibleLimit(project, total) {
  return expandedProjects.has(project) ? total : collapsedProjectRows;
}

function setProjectExpanded(project, expanded) {
  if (expanded) expandedProjects.add(project);
  else expandedProjects.delete(project);
  localStorage.setItem(expandedProjectsStorageKey, JSON.stringify(Array.from(expandedProjects)));
  renderThreadList();
}

// A Mac with work in six folders spent the whole list on headings for the five
// the owner is not in. Folding one leaves its heading and nothing else, so the
// projects being worked on today sit next to each other instead of pages apart.
function setProjectCollapsed(project, collapsed) {
  if (collapsed) collapsedProjects.add(project);
  else collapsedProjects.delete(project);
  localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify(Array.from(collapsedProjects)));
  renderThreadList();
}

// Folded, the heading is all that is left of the project, so it has to answer
// what the rows underneath would have: how many there are, and whether any of
// them is waiting on someone.
function projectFoldedSummary(threads) {
  const summary = document.createElement("span");
  summary.className = "project-folded-summary";
  const states = threads.map((thread) => deriveThreadStatus(thread).group);
  const attention = states.filter((group) => group === "attention").length;
  const running = states.filter((group) => group === "running").length;
  const badge = (text, tone) => {
    const element = document.createElement("span");
    element.className = `thread-status-badge thread-status-badge-${tone}`;
    element.textContent = text;
    return element;
  };
  if (attention) summary.appendChild(badge(`要対応 ${attention}`, "approval"));
  if (running) summary.appendChild(badge(`実行中 ${running}`, "running"));
  // Under the 要対応 or 実行中 filter every row in the group is one of those, so
  // the plain total would repeat the badge beside it word for word.
  if (attention + running < threads.length) {
    const count = document.createElement("span");
    count.className = "project-folded-count";
    count.textContent = `${threads.length}件`;
    summary.appendChild(count);
  }
  return summary;
}

// "もっと表示する" was a bare <div> with no handler from the day it was added, so
// the rows past the cap were unreachable and the label was decoration. Both
// directions now, because expanding with no way back is its own trap.
function appendThreadListToggle(group, project, shown, total) {
  if (total <= collapsedProjectRows) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "project-more";
  const expanded = expandedProjects.has(project);
  toggle.textContent = expanded ? "表示を減らす" : `もっと表示する (残り${total - shown}件)`;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setProjectExpanded(project, !expanded);
  });
  group.appendChild(toggle);
}

// Hiding a project removes its heading, so without this there is no way back to
// it from the sidebar that stopped listing it.
function renderHiddenProjects() {
  if (!hiddenProjects.length) return;
  const section = document.createElement("section");
  section.className = "project-group hidden-projects";
  const heading = document.createElement("div");
  heading.className = "project-heading";
  const folder = document.createElement("span");
  folder.className = "project-folder";
  const name = document.createElement("span");
  name.className = "project-name";
  name.textContent = `非表示のプロジェクト (${hiddenProjects.length})`;
  heading.append(folder, name);
  section.appendChild(heading);
  for (const workdir of hiddenProjects) {
    const project = projectForThread({ cwd: workdir });
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hidden-project";
    row.title = `${workdir} を一覧に戻す`;
    const label = document.createElement("span");
    label.className = "hidden-project-name";
    label.textContent = project;
    const action = document.createElement("span");
    action.className = "hidden-project-action";
    action.textContent = "戻す";
    row.append(label, action);
    row.addEventListener("click", () => setProjectHidden(workdir, false, project));
    section.appendChild(row);
  }
  threadList.appendChild(section);
}

async function setProjectHidden(workdir, hidden, project = "", bridgeId = activeBridgeId) {
  if (!workdir) return;
  try {
    const result = await apiPost("/api/workspaces/hidden", { path: workdir, hidden }, { bridgeId });
    if (bridgeId === activeBridgeId) hiddenProjects = Array.isArray(result.hiddenProjects) ? result.hiddenProjects : hiddenProjects;
    const state = getBridgeState(bridgeId);
    state.hiddenProjects = Array.isArray(result.hiddenProjects) ? result.hiddenProjects : state.hiddenProjects;
    state.threadsLoadedAt = 0;
    renderThreadList();
    // Hiding drops the project's threads from what the bridge sends, so putting
    // it back needs the list fetched again — redrawing the cache we already have
    // would leave the project empty until the next poll happened to come round.
    // Every bridge is re-read, not just the one that was told: the sidebar now
    // merges them, so a stale copy on any other connection would put the
    // project straight back under its own heading.
    await loadThreads({ background: true }).catch(() => {});
    await loadFleetThreads({ force: true }).catch(() => {});
    showToast(hidden ? `${project || workdir} を隠しました。` : `${project || workdir} を戻しました。`);
  } catch (error) {
    showToast(`変更できませんでした: ${error.message}`, "warn");
  }
}

// Sits above the rows because it is about all of them: whatever is underneath
// is not this bridge's answer yet, and the rows have no way to say so.
function renderThreadListNotice() {
  const state = getBridgeState(activeBridgeId);
  const notice = uiUtils.threadListNotice
    ? uiUtils.threadListNotice({
        loaded: Boolean(state.threadsLoadedAt),
        blocked: state.threadsBlocked || "",
        error: state.threadsError || "",
      })
    : null;
  if (!notice) return;
  const box = document.createElement("div");
  box.className = "thread-list-notice";
  const text = document.createElement("span");
  text.className = "thread-list-notice-text";
  text.textContent = notice.text;
  box.append(text);
  if (notice.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "thread-list-retry";
    retry.textContent = "再読み込み";
    retry.addEventListener("click", () => {
      loadThreads({ background: true }).catch(() => {});
      loadFleetThreads({ force: true }).catch(() => {});
    });
    box.append(retry);
  }
  threadList.appendChild(box);
}

function renderThreadList() {
  threadList.replaceChildren();
  renderThreadInboxTabs();
  renderThreadListNotice();
  const provider = currentThreadProvider();
  const groups = visibleThreadGroups();
  const showMachine = Array.from(groups.values()).some((group) => group.showMachine);
  const activeMachineLabel = shortMachineName(activeBridge() || {}, getBridgeState(activeBridgeId));

  const current = currentThreadListRecord();
  const currentThread = selectedThreadVisibleInGroups(groups) ? null : current && { ...current, bridgeId: activeBridgeId, machineLabel: activeMachineLabel };
  if (currentThread) {
    const currentGroup = document.createElement("section");
    currentGroup.className = "project-group current-thread-group";
    const heading = document.createElement("div");
    heading.className = "project-heading current-thread-heading";
    const folder = document.createElement("span");
    folder.className = "project-folder";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = "現在のチャット";
    heading.append(folder, name);
    const currentTitle = titleForThread(currentThread);
    currentGroup.append(
      heading,
      createThreadListItem(currentThread, {
        displayTitle: currentTitle === "名前未設定のチャット" ? "現在のチャット" : currentTitle,
        showFolderName: true,
        showMachine,
      }),
    );
    threadList.appendChild(currentGroup);
  }

  if (threadSortMode === "recent" && groups.size) {
    // One flat list across every project. Each row already carries its own cwd,
    // so nothing is lost by dropping the headings, and work spread over several
    // folders reads in the order it actually happened.
    const flat = sortThreadsForInbox(Array.from(groups.values()).flatMap((group) => group.threads));
    const group = document.createElement("section");
    group.className = "project-group";
    const heading = document.createElement("div");
    heading.className = "project-heading";
    const folder = document.createElement("span");
    folder.className = "project-folder";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = "日時順";
    heading.append(folder, name);
    group.appendChild(heading);
    // Same cap and the same way past it: without one, work older than the
    // newest 30 is unreachable in this view.
    const shown = limitedVisibleThreads(flat, expandedProjects.has(recentViewKey) ? flat.length : collapsedRecentRows);
    for (const thread of shown) group.appendChild(createThreadListItem(thread, { showFolderName: true, showMachine }));
    if (flat.length > collapsedRecentRows) {
      const expanded = expandedProjects.has(recentViewKey);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "project-more";
      toggle.textContent = expanded ? "表示を減らす" : `もっと表示する (残り${flat.length - shown.length}件)`;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", () => setProjectExpanded(recentViewKey, !expanded));
      group.appendChild(toggle);
    }
    threadList.appendChild(group);
    updateThreadNavigation();
    renderThreadSwitcher();
    renderContextMismatch();
    return;
  }

  for (const [groupKey, groupRecord] of groups) {
    const threads = groupRecord.threads;
    const project = groupRecord.label;
    const folded = collapsedProjects.has(groupKey);
    const group = document.createElement("section");
    group.className = folded ? "project-group collapsed" : "project-group";

    const heading = document.createElement("div");
    heading.className = "project-heading has-collapse";
    const folder = document.createElement("span");
    folder.className = "project-folder";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project;
    const titleRow = document.createElement("span");
    titleRow.className = "project-title-row";
    titleRow.appendChild(name);
    // The Air and the mini both keep a folder called `00_受け渡し`, and the Air's
    // copy of this repo has almost the same name as the mini's. Which Mac the
    // work is on is the part that tells the two headings apart.
    if (groupRecord.showMachine && groupRecord.machineLabel) {
      const machine = document.createElement("span");
      machine.className = "project-machine";
      machine.textContent = groupRecord.machineLabel;
      applyMachineAccent(machine, groupRecord.machineLabel, groupRecord.machineKey);
      titleRow.appendChild(machine);
    }
    // The heading's own row actions stay their own buttons beside it, so the
    // fold cannot swallow them and no button ends up nested inside another.
    const foldButton = document.createElement("button");
    foldButton.type = "button";
    foldButton.className = "project-collapse";
    foldButton.setAttribute("aria-expanded", String(!folded));
    foldButton.title = folded ? `${project} を開く` : `${project} を畳む`;
    foldButton.setAttribute("aria-label", foldButton.title);
    foldButton.append(folder, titleRow);
    if (folded) foldButton.appendChild(projectFoldedSummary(threads));
    const chevron = document.createElement("span");
    chevron.className = "project-chevron";
    chevron.setAttribute("aria-hidden", "true");
    foldButton.appendChild(chevron);
    foldButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setProjectCollapsed(groupKey, !folded);
    });
    heading.append(foldButton);
    const projectWorkdir = projectWorkdirForThreads(threads);
    if (projectWorkdir) {
      const createButton = document.createElement("button");
      createButton.type = "button";
      createButton.className = "project-new-thread";
      createButton.title = `${project} で新しいチャット`;
      createButton.setAttribute("aria-label", `${project} で新しいチャット`);
      const icon = document.createElement("span");
      icon.className = "compose-icon";
      icon.setAttribute("aria-hidden", "true");
      createButton.appendChild(icon);
      createButton.addEventListener("click", (event) => {
        event.stopPropagation();
        startNewThread({ workdir: projectWorkdir, project, bridgeId: groupRecord.bridgeId });
      });
      heading.appendChild(createButton);
      // Tooling writes sessions too — memory hooks, summarisers — and which
      // folders those are differs per machine, so this is a choice rather than
      // a rule the bridge can infer.
      const hideButton = document.createElement("button");
      hideButton.type = "button";
      hideButton.className = "project-hide";
      hideButton.title = `${project} を一覧から隠す`;
      hideButton.setAttribute("aria-label", `${project} を一覧から隠す`);
      hideButton.textContent = "×";
      hideButton.addEventListener("click", (event) => {
        event.stopPropagation();
        // Hiding is per machine: the bridge that lists the folder is the one
        // that has to be told to stop listing it.
        setProjectHidden(projectWorkdir, true, project, groupRecord.bridgeId);
      });
      heading.appendChild(hideButton);
    }
    group.appendChild(heading);

    // The open chat is the one row folding must never take away: losing sight of
    // where you are is not tidying up.
    const visibleThreads = folded
      ? threads.filter((thread) => thread.id === selectedThread && isActiveBridgeThread(thread))
      : limitedVisibleThreads(threads, projectVisibleLimit(groupKey, threads.length));
    for (const thread of visibleThreads) {
      group.appendChild(createThreadListItem(thread, { groupWorkdir: projectWorkdir }));
    }

    if (folded) {
      // The heading already says how many rows are folded away.
    } else if (threads.length > collapsedProjectRows) {
      appendThreadListToggle(group, groupKey, visibleThreads.length, threads.length);
    } else if (!visibleThreads.length) {
      const empty = document.createElement("div");
      empty.className = "project-empty";
      empty.textContent = "チャットはありません";
      group.appendChild(empty);
    }
    threadList.appendChild(group);
  }

  // "There are none" is a claim about a list that came back. Said over a list
  // that never did, it is the same wrong answer the single stand-in row gave,
  // just spelled out - so it waits for the fetch the notice above is reporting.
  if (!groups.size && getBridgeState(activeBridgeId).threadsLoadedAt) {
    const empty = document.createElement("div");
    empty.className = "project-empty";
    empty.textContent =
      threadInboxFilter === "attention"
        ? "要対応のチャットはありません"
        : threadInboxFilter === "running"
          ? "実行中のチャットはありません"
          : `${providerLabel(provider)}のチャットはありません`;
    threadList.appendChild(empty);
  }

  // A short list under a narrow filter reads exactly like a lost list. Say how
  // many are being held back, and make the way out of the filter the same tap.
  const hiddenByFilter = threadsHiddenByInboxFilter();
  if (hiddenByFilter) {
    const escape = document.createElement("button");
    escape.type = "button";
    escape.className = "thread-filter-escape";
    escape.textContent = `絞り込みで${hiddenByFilter}件を非表示中 — すべて表示`;
    escape.addEventListener("click", () => setThreadInboxFilter("recent"));
    threadList.appendChild(escape);
  }
  renderHiddenProjects();
  updateThreadNavigation();
  renderThreadSwitcher();
  renderContextMismatch();
}

function adjacentThread(direction) {
  const threads = visibleThreadsInListOrder();
  if (!threads.length) return null;
  const currentIndex = threads.findIndex((thread) => thread.id === selectedThread);
  if (currentIndex < 0) return direction > 0 ? threads[0] : null;
  return threads[currentIndex + direction] || null;
}

function updateThreadNavigation() {
  const previous = adjacentThread(-1);
  const next = adjacentThread(1);
  const disabledByRun = liveTurnActive || Boolean(pendingApproval) || threadSwitchBusy;
  if (prevThreadButton) {
    prevThreadButton.disabled = disabledByRun || !previous;
    prevThreadButton.title = disabledByRun
      ? pendingApproval
        ? "承認待ちのためチャット移動を止めています"
        : threadSwitchBusy
          ? "チャット切替中です"
          : "実行中はチャット移動を止めています"
      : previous
        ? `← 前: ${titleForThread(previous)}`
        : "同じ作業場所内に前のチャットはありません";
    prevThreadButton.setAttribute("aria-label", prevThreadButton.title);
  }
  if (nextThreadButton) {
    nextThreadButton.disabled = disabledByRun || !next;
    nextThreadButton.title = disabledByRun
      ? pendingApproval
        ? "承認待ちのためチャット移動を止めています"
        : threadSwitchBusy
          ? "チャット切替中です"
          : "実行中はチャット移動を止めています"
      : next
        ? `次 →: ${titleForThread(next)}`
        : "同じ作業場所内に次のチャットはありません";
    nextThreadButton.setAttribute("aria-label", nextThreadButton.title);
  }
  updateHeaderStatus();
}

function showSwipeFeedback(text) {
  if (!swipeFeedback) {
    addStatus(text);
    return;
  }
  swipeFeedback.textContent = text;
  swipeFeedback.classList.remove("hidden");
  if (swipeFeedbackTimer) window.clearTimeout(swipeFeedbackTimer);
  swipeFeedbackTimer = window.setTimeout(() => {
    swipeFeedback.classList.add("hidden");
  }, 1800);
}

function showToast(text, tone = "") {
  if (!toastStack) {
    showSwipeFeedback(text);
    return;
  }
  const toast = document.createElement("div");
  toast.className = tone ? `toast ${tone}` : "toast";
  toast.textContent = text;
  toastStack.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 180);
  }, 1900);
}

function runStatePriority(state = "") {
  if (state === "approval") return 5;
  if (state === "error" || state === "disconnected") return 4;
  if (state === "running" || state === "streaming" || state === "syncing" || state === "interrupting") return 3;
  if (state === "connecting") return 2;
  return 1;
}

function bridgeRunSummary(bridgeId) {
  const state = getBridgeState(bridgeId);
  const bridgeRuns = Array.isArray(state.status?.bridges) ? state.status.bridges : [];
  if (!bridgeRuns.length) {
    return {
      run: { state: state.runState || (state.connected ? "ready" : "disconnected"), label: state.lastError || runStateShortLabel(state.runState || "ready") },
      pendingApproval: state.pendingApproval,
      terminalTail: [],
      threadId: state.selectedThread || "",
      provider: state.activeProvider || state.info?.provider || "codex",
    };
  }
  return bridgeRuns.reduce((best, candidate) => {
    const candidateRun = candidate.run || {};
    const bestRun = best.run || {};
    return runStatePriority(candidateRun.state) > runStatePriority(bestRun.state) ? candidate : best;
  }, bridgeRuns[0]);
}

function bridgeStateLabel(entry, state = getBridgeState(entry.id)) {
  const summary = bridgeRunSummary(entry.id);
  const run = summary.run || {};
  const connected = state.connected || Boolean(state.status);
  if (!connected && state.lastError) return "error";
  if (!connected) return "disconnected";
  return run.state || "ready";
}

function bridgeDisplayLabel(entry = {}, fallback = "接続先") {
  const label = String(entry?.label || "").trim();
  if (uiUtils.isPlaceholderBridgeLabel(label)) return fallback;
  return label;
}

function basenameFromPath(value = "") {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function timestampLabel(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function threadRecordTimestamp(thread = {}) {
  if (uiUtils.threadTimestamp) return uiUtils.threadTimestamp(thread);
  return thread?.updatedAt || thread?.updated_at || thread?.updated_at_ms || thread?.createdAt || thread?.created_at || thread?.created_at_ms || 0;
}

function hasWorkspaceMeta(meta = {}) {
  return Boolean(meta?.repoName || usableWorkspaceLocation(meta?.workspaceLocation || "") || meta?.gitBranch);
}

function selectedThreadExecutionMeta() {
  if (!workspaceFollowsSelectedThread || !selectedThread || shouldDeferSelectedThreadWorkdir()) return null;
  const record = selectedThreadRecord();
  const workdir = usableWorkspaceLocation(
    record?.lastExecutionCwd || record?.cwd || record?.workspaceLocation || record?.workdir || "",
  );
  if (!workdir) return null;
  return {
    source: "agent",
    repoName: record?.repoName || basenameFromPath(workdir),
    workspaceLocation: workdir,
    gitBranch: record?.gitBranch || "",
    updatedAt: threadRecordTimestamp(record || {}),
  };
}

function currentWorkspaceExecutionMeta() {
  const workdir = currentWorkspaceWorkdir();
  if (!workdir) return null;
  return {
    source: "agent",
    repoName: currentWorkspace.repoName || basenameFromPath(workdir),
    workspaceLocation: workdir,
    gitBranch: currentWorkspace.gitBranch || "",
    updatedAt: getBridgeState(activeBridgeId).lastEventAt || 0,
  };
}

function activeBridgeExecutionMeta() {
  const entry = activeBridge() || {};
  const state = getBridgeState(activeBridgeId);
  const runMeta = selectedBridgeRunWorkspaceMeta(state.status);
  if (hasWorkspaceMeta(runMeta)) {
    return {
      source: "bridge-run",
      repoName: runMeta.repoName || basenameFromPath(runMeta.workspaceLocation),
      workspaceLocation: runMeta.workspaceLocation,
      gitBranch: runMeta.gitBranch || "",
      updatedAt: state.lastEventAt || 0,
    };
  }
  const current = currentWorkspaceDisplayMeta();
  if (hasWorkspaceMeta(current)) {
    return {
      source: "bridge-run",
      repoName: current.repoName || basenameFromPath(current.workspaceLocation),
      workspaceLocation: current.workspaceLocation,
      gitBranch: current.gitBranch || "",
      updatedAt: state.lastEventAt || 0,
    };
  }
  const info = state.info || {};
  const status = state.status || {};
  const workdir = usableWorkspaceLocation(info.cwd || info.workdir || status.workdir || entry.workdir || "");
  return {
    source: "bridge",
    repoName: (info.repoRoot || workdir || "").split(/[\\/]/).filter(Boolean).pop() || "",
    workspaceLocation: workdir,
    gitBranch: info.branch || info.gitBranch || status.gitBranch || "",
    updatedAt: state.lastEventAt || 0,
  };
}

function contextSnapshot() {
  const bridge = activeBridgeExecutionMeta();
  const agent = currentWorkspaceExecutionMeta() || selectedThreadExecutionMeta();
  const display = agent || {
    source: "bridge",
    repoName: currentWorkspace.repoName || bridge.repoName,
    workspaceLocation: currentWorkspaceWorkdir() || bridge.workspaceLocation,
    gitBranch: currentWorkspace.gitBranch || bridge.gitBranch,
    updatedAt: bridge.updatedAt,
  };
  const mismatch = Boolean(agent?.workspaceLocation && bridge.workspaceLocation && agent.workspaceLocation !== bridge.workspaceLocation);
  return { agent, bridge, display, mismatch };
}

function currentWorkspaceDisplayMeta() {
  const location = currentWorkspaceWorkdir() || (shouldDeferSelectedThreadWorkdir() ? "" : selectedThreadWorkdir(""));
  return {
    repoName: currentWorkspace.repoName || basenameFromPath(location),
    workspaceLocation: location,
    gitBranch: currentWorkspace.gitBranch || "",
  };
}

function bridgeUsesCurrentWorkspace(entry = {}) {
  return (entry?.id || activeBridgeId) === activeBridgeId;
}

function bridgeDisplayWorkspaceMeta(entry = {}, state = getBridgeState(entry.id)) {
  const info = state.info || {};
  const status = state.status || {};
  if (bridgeUsesCurrentWorkspace(entry)) {
    const selectedRun = selectedBridgeRunWorkspaceMeta(status);
    if (hasWorkspaceMeta(selectedRun)) return selectedRun;
    const current = currentWorkspaceDisplayMeta();
    if (hasWorkspaceMeta(current)) return current;
  }
  const infoMeta = workspaceMetaFromBridgeInfo(info);
  if (hasWorkspaceMeta(infoMeta)) return infoMeta;
  const statusMeta = workspaceMetaFromRun(status);
  if (hasWorkspaceMeta(statusMeta)) return statusMeta;
  return {
    repoName: "",
    workspaceLocation: usableWorkspaceLocation(entry.workdir || ""),
    gitBranch: "",
  };
}

function dirtyTextForDisplayWorkspace(entry = {}, state = getBridgeState(entry.id), displayMeta = {}) {
  const info = state.info || {};
  const status = state.status || {};
  const displayWorkdir = usableWorkspaceLocation(displayMeta.workspaceLocation || "");
  const bridgeWorkdir = usableWorkspaceLocation(info.cwd || info.workdir || status.workdir || entry.workdir || "");
  if (displayWorkdir && bridgeWorkdir && displayWorkdir !== bridgeWorkdir) return "";
  return info.dirty === true || status.dirty === true ? "変更あり" : info.dirty === false ? "変更なし" : "";
}

function bridgeWorkspaceLabel(entry = {}, state = getBridgeState(entry.id), fallback = "接続先") {
  const explicit = bridgeDisplayLabel(entry, "");
  const meta = bridgeDisplayWorkspaceMeta(entry, state);
  if (bridgeUsesCurrentWorkspace(entry)) return meta.repoName || basenameFromPath(meta.workspaceLocation) || explicit || fallback;
  if (explicit) return explicit;
  return meta.repoName || basenameFromPath(meta.workspaceLocation) || fallback;
}

function bridgeMetaText(entry, state = getBridgeState(entry.id)) {
  const info = state.info || {};
  const status = state.status || {};
  const displayMeta = bridgeDisplayWorkspaceMeta(entry, state);
  const port = entry.port || info.uiPort || status.uiPort || "";
  const branch = displayMeta.gitBranch || "";
  const dirty = dirtyTextForDisplayWorkspace(entry, state, displayMeta);
  const cwd = displayMeta.workspaceLocation || info.cwd || info.workdir || entry.workdir || status.workdir || "";
  const name = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "";
  return [port ? `:${port}` : "", branch, dirty, name].filter(Boolean).join(" / ") || "未確認";
}

// Which machine this bridge is running on. A port number does not answer that,
// and with a bridge on each Mac it is the first thing worth knowing. The model
// in the hostname is what these get called day to day, so an Air reads as
// "Air"; PHONE_MACHINE_LABEL on the bridge overrides that outright.
function shortMachineName(entry = {}, state = {}) {
  if (uiUtils.machineLabelForBridge) return uiUtils.machineLabelForBridge(state.info || {});
  const explicit = String(state.info?.machineLabel || "").trim();
  if (explicit) return explicit;
  const host = state.info?.hostName || "";
  if (uiUtils.machineLabelFromHost) return uiUtils.machineLabelFromHost(host);
  return String(host).trim().replace(/\.(local|lan|home|internal)\.?$/i, "");
}

// The comparable form of the same answer. A bridge that has not reported its
// host yet falls back to its own id, so it is never mistaken for another Mac.
function bridgeMachineKey(entry = {}, state = getBridgeState(entry.id)) {
  const label = shortMachineName(entry, state);
  if (uiUtils.machineScopeKey) return uiUtils.machineScopeKey(label, entry.id || "");
  return String(label || entry.id || "").trim().toLowerCase();
}

function bridgeConnectionMetaText(entry, state = getBridgeState(entry.id)) {
  const info = state.info || {};
  const status = state.status || {};
  const displayMeta = bridgeDisplayWorkspaceMeta(entry, state);
  const port = entry.port || info.uiPort || status.uiPort || "";
  const branch = displayMeta.gitBranch || "";
  const dirty = dirtyTextForDisplayWorkspace(entry, state, displayMeta);
  const machine = shortMachineName(entry, state);
  return [machine, port ? `:${port}` : "", branch, dirty].filter(Boolean).join(" / ") || bridgeMetaText(entry, state);
}

function bridgeHeaderMetaText(entry, state = getBridgeState(entry.id)) {
  const info = state.info || {};
  const status = state.status || {};
  const displayMeta = bridgeDisplayWorkspaceMeta(entry, state);
  const port = entry.port || info.uiPort || status.uiPort || "";
  const branch = displayMeta.gitBranch || "";
  const dirty = dirtyTextForDisplayWorkspace(entry, state, displayMeta) === "変更あり" ? "変更あり" : "";
  const machine = shortMachineName(entry, state);
  return [machine, branch || (port ? `:${port}` : ""), dirty].filter(Boolean).join(" / ") || bridgeMetaText(entry, state);
}

function workspaceMetaFromBridgeInfo(info = {}) {
  const cwd = usableWorkspaceLocation(info.cwd || info.workdir || "");
  return {
    repoName: (info.repoRoot || cwd || "").split(/[\\/]/).filter(Boolean).pop() || "",
    workspaceLocation: cwd,
    gitBranch: info.branch || info.gitBranch || "",
  };
}

function workspaceMetaFromRun(run = {}) {
  const workspaceLocation = [run.cwd, run.workdir, run.workspaceLocation].map((value) => usableWorkspaceLocation(value || "")).find(Boolean) || "";
  return {
    repoName: run.repoName || basenameFromPath(workspaceLocation),
    workspaceLocation,
    gitBranch: run.gitBranch || run.branch || "",
  };
}

function selectedBridgeRunWorkspaceMeta(status = {}) {
  if (!selectedThread || shouldDeferSelectedThreadWorkdir()) return null;
  const currentStatus = status || {};
  const runs = Array.isArray(currentStatus.bridges) ? currentStatus.bridges : [];
  const selectedRun = runs.find((item) => item.threadId === selectedThread);
  if (!selectedRun) return null;
  // The entry itself is the bridge reading this session's folder; the `run`
  // nested inside it is the bridge process describing itself, and on a bridge
  // that has not been updated those two disagree - the repo the bridge was
  // started in wins and renames a chat that is running somewhere else. The
  // session's own reading is the one to keep.
  const meta = workspaceMetaFromRun({ ...(selectedRun.run || {}), ...selectedRun });
  return meta.repoName || meta.workspaceLocation || meta.gitBranch ? meta : null;
}

// What a poll is allowed to say about the workspace. A poll reports on the
// bridge, not on the folder the owner picked: the bridge only lists the sessions
// it is holding open, so a chat that is merely waiting - or one whose folder was
// chosen a moment ago - has no run to be found among them. Handing it the
// bridge's own cwd in that gap renamed the header to the repo the bridge was
// started in, while the chat carried on in the folder that was chosen.
function polledWorkspaceMeta(info = {}, status = {}) {
  const bridgeMeta = workspaceMetaFromBridgeInfo(info);
  if (!workspaceFollowsSelectedThread) return bridgeMeta;
  const runMeta = selectedBridgeRunWorkspaceMeta(status);
  if (hasWorkspaceMeta(runMeta)) return runMeta;
  // The chat's own cwd outranks the pinned one: following the chat is what this
  // mode means, and a folder pinned for a chat that has since moved is stale.
  const chosen = selectedThreadWorkdir("") || currentWorkspaceWorkdir();
  if (!chosen || chosen === bridgeMeta.workspaceLocation) return bridgeMeta;
  return {
    repoName: currentWorkspace.repoName || basenameFromPath(chosen),
    workspaceLocation: chosen,
    // The bridge's branch belongs to the bridge's folder. A handoff folder that
    // is not a repo has no branch, and claiming `develop` there is a lie the
    // header would keep telling.
    gitBranch: currentWorkspace.gitBranch || "",
  };
}

// The tone belongs to the badge, so it is spelled inside the badge's own name.
// Written as a bare state word it was a global class: `.approval` is the chat's
// full-width approval card, and it handed this badge that card's width, padding,
// bottom margin and shadow - two counts side by side came out different sizes,
// sitting at different heights. It also made every badge match the swipe guard's
// `.approval` selector.
function fleetBadge(text, tone = "") {
  const badge = document.createElement("span");
  badge.className = tone ? `fleet-badge fleet-badge-${tone}` : "fleet-badge";
  badge.textContent = text;
  return badge;
}

function collectPendingApprovals() {
  const approvals = [];
  for (const entry of bridgeRegistry.bridges || []) {
    const state = getBridgeState(entry.id);
    const runs = Array.isArray(state.status?.bridges) ? state.status.bridges : [];
    for (const run of runs) {
      if (!run.pendingApproval) continue;
      approvals.push({
        bridgeId: entry.id,
        bridge: entry,
        provider: run.provider || state.info?.provider || "codex",
        threadId: run.threadId || "",
        request: run.pendingApproval,
        run: run.run || {},
      });
    }
    if (state.pendingApproval && !approvals.some((item) => item.bridgeId === entry.id && item.request?.id === state.pendingApproval?.id)) {
      approvals.push({
        bridgeId: entry.id,
        bridge: entry,
        provider: currentThreadProvider(),
        threadId: selectedThread,
        request: state.pendingApproval,
        run: { state: "approval", label: "承認待ち" },
      });
    }
  }
  return approvals;
}

function approvalSummaryText(request = {}) {
  // Named by what was asked, not by the transport: "claude/requestApproval" told
  // nobody which of the fleet's bridges is the one holding up a question.
  const [question] = questionsForApproval(request);
  if (question) return String(question.header || question.question).slice(0, 120);
  const method = String(request.method || "approval");
  const params = request.params || {};
  const command = params.command || params.cmd || params.description || "";
  return command ? `${method}: ${String(command).slice(0, 120)}` : method;
}

// Which Macs are registered, adding one, automations and plugins are all
// occasional work, while the chat list under them is why the drawer gets
// opened at all - and on a phone that block took roughly 40% of the drawer
// before a single chat row appeared. So the project header doubles as its
// disclosure: shut by default where the room is tight, open where it is not,
// and remembered from the first time it is touched.
const sidebarConnectionsStorageKey = "codexPhoneSidebarConnections:v1";

function storedSidebarConnectionsOpen() {
  try {
    const stored = localStorage.getItem(sidebarConnectionsStorageKey);
    if (stored === "open") return true;
    if (stored === "collapsed") return false;
  } catch {
    // No stored preference to read; the width-based default stands.
  }
  return null;
}

let sidebarConnectionsOpen = storedSidebarConnectionsOpen() ?? !isMobileViewport();

function renderSidebarProjectBridge() {
  if (!sidebarProjectBridge) return;
  if (sidebarConnectionsOpen) {
    // The card directly below the header already says all of this.
    sidebarProjectBridge.replaceChildren();
    sidebarProjectBridge.hidden = true;
    sidebarProjectBridge.removeAttribute("title");
    return;
  }
  // Which Mac, not which connection: the project name beside it already carries
  // the workspace, and a bridge named after its repo would only say that twice.
  const active = activeBridge();
  const label = shortMachineName(active, getBridgeState(activeBridgeId)) || bridgeDisplayLabel(active, "接続先");
  const name = document.createElement("span");
  name.className = "sidebar-project-bridge-name";
  name.textContent = label;
  const parts = [name];
  // Shutting the block must not shut off the fleet's "someone is waiting on
  // you" signal, so the same counts ride along with the machine name.
  const entries = bridgeRegistry.bridges || [];
  const approvals = collectPendingApprovals().length;
  const running = entries.filter((entry) => ["running", "streaming", "syncing", "interrupting"].includes(bridgeStateLabel(entry))).length;
  if (running) parts.push(fleetBadge(String(running), "running"));
  if (approvals) parts.push(fleetBadge(String(approvals), "approval"));
  sidebarProjectBridge.replaceChildren(...parts);
  sidebarProjectBridge.hidden = false;
  sidebarProjectBridge.title = `接続先 ${label}`;
}

function applySidebarConnections() {
  threadSidebar?.classList.toggle("connections-collapsed", !sidebarConnectionsOpen);
  sidebarConnectionsToggle?.setAttribute("aria-expanded", sidebarConnectionsOpen ? "true" : "false");
  sidebarConnectionsToggle?.setAttribute("title", sidebarConnectionsOpen ? "接続先とツールを隠す" : "接続先とツールを表示");
  renderSidebarProjectBridge();
}

function setSidebarConnectionsOpen(open) {
  sidebarConnectionsOpen = Boolean(open);
  try {
    localStorage.setItem(sidebarConnectionsStorageKey, sidebarConnectionsOpen ? "open" : "collapsed");
  } catch {
    // Remembering the choice is best effort; the drawer still obeys it now.
  }
  applySidebarConnections();
}

function buildLabelForState(state) {
  return uiUtils.bridgeBuildLabel?.(state?.connected ? state.info?.build : null) || "アプリの版を確認できません";
}

function renderBuildNotice(entries) {
  if (!bridgeBuildNotice) return;
  const peers = entries.map((entry) => {
    const state = getBridgeState(entry.id);
    return { label: shortMachineName(entry, state) || bridgeDisplayLabel(entry), connected: state.connected, build: state.info?.build };
  });
  const message = uiUtils.bridgeBuildNotice ? uiUtils.bridgeBuildNotice(peers) : "アプリの版を確認できません。画面を開き直してください。";
  bridgeBuildNotice.textContent = message;
  bridgeBuildNotice.hidden = !message;
}

function activeLabInfo() {
  const info = getBridgeState(activeBridgeId).info;
  return info?.capabilities?.lab ? info : null;
}

function renderLabControls() {
  if (!labControls) return;
  const info = activeLabInfo();
  labControls.hidden = !info;
  accessButton.disabled = Boolean(info);
  accessButton.textContent = info ? "実験フォルダ内のみ" : accessMode.label;
  addButton.disabled = Boolean(info);
  updateModelButton();
  const state = getBridgeState(activeBridgeId);
  const lab = state.status?.lab || info?.lab || {};
  sendButton.disabled = !connectionReady || Boolean(pendingSubmission) || Boolean(info && !lab.aiReady);
  sendButton.title = info && !lab.aiReady ? "AI作業は準備中です。入力は残せます。"
    : pendingSubmission ? "送信確認中です" : connectionReady ? "送信" : "接続後に送信できます";
  if (!info) return;
  const busy = labOperationPending.has(activeBridgeId) || Boolean(lab.pendingOperation);
  labStateLabel.textContent = lab.label || "実験室の状態を確認中";
  labObservedAt.textContent = `${lab.observedAt ? `Windows確認: ${new Date(lab.observedAt).toLocaleString("ja-JP")}` : "Windowsの状態は未取得"}。${lab.aiReady ? "専用の作業フォルダだけを操作できます。" : lab.ready ? "専用フォルダを閲覧できます。AI作業は承認・実機検証後に有効にします。" : "結果は保存済みの表示です。"}`;
  labStart.disabled = busy || !lab.hostOnline || lab.vmState !== "off";
  labShutdown.disabled = busy || !lab.ready || (state.status?.bridges || []).some(bridge => ["running", "streaming", "interrupting", "disconnected"].includes(bridge.run?.state));
}

async function requestLabOperation(operation) {
  const bridgeId = activeBridgeId;
  if (!activeLabInfo() || labOperationPending.has(bridgeId)) return;
  labOperationPending.add(bridgeId);
  renderLabControls();
  try {
    await apiPost(`/api/lab/${operation}`, {}, { bridgeId });
    showToast(operation === "start" ? "実験室へ起動を依頼しました。準備には数分かかります。" : "実験室へ停止を依頼しました。停止確認までお待ちください。");
    await refreshBridgeState(bridgeId, { force: true });
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    labOperationPending.delete(bridgeId);
    renderLabControls();
  }
}

function renderFleet() {
  renderLabControls();
  renderOperationContext();
  const entries = bridgeRegistry.bridges || [];
  const active = activeBridge();
  const activeState = getBridgeState(activeBridgeId);
  const activeColor = bridgeColorFor(active || {});
  document.documentElement.style.setProperty("--bridge-color", activeColor);
  if (bridgePill) {
    bridgePill.dataset.state = bridgeStateLabel(active || { id: activeBridgeId }, activeState);
    bridgePill.style.setProperty("--bridge-color", activeColor);
  }
  if (bridgePillLabel) bridgePillLabel.textContent = bridgeWorkspaceLabel(active, activeState, "接続先");
  if (bridgePillMetaText) bridgePillMetaText.textContent = bridgeHeaderMetaText(active || { id: activeBridgeId }, activeState);
  renderBridgePillAgent();
  if (fleetCurrentLabel) fleetCurrentLabel.textContent = bridgeDisplayLabel(active, "現在の接続先");
  if (fleetCurrentMeta) fleetCurrentMeta.textContent = `作業場所: ${bridgeConnectionMetaText(active || { id: activeBridgeId }, activeState)}`;
  if (fleetCurrentBuild) fleetCurrentBuild.textContent = buildLabelForState(activeState);
  if (fleetCurrentBadges) {
    fleetCurrentBadges.replaceChildren();
    const approvals = collectPendingApprovals().length;
    const running = entries.filter((entry) => ["running", "streaming", "syncing", "interrupting"].includes(bridgeStateLabel(entry))).length;
    if (running) fleetCurrentBadges.appendChild(fleetBadge(String(running), "running"));
    if (approvals) fleetCurrentBadges.appendChild(fleetBadge(String(approvals), "approval"));
  }

  if (bridgeFleetList) {
    bridgeFleetList.replaceChildren();
    // The card above this list is the current bridge. Listing it again put the
    // same connection on screen twice, one row under the other, under the same
    // name - which reads as the bridge having multiplied rather than as a
    // switcher showing where you already are. This list is the ones you can
    // move to.
    const others = entries.filter((entry) => entry.id !== activeBridgeId);
    const showBridgeList = others.length > 0;
    bridgeFleetList.hidden = !showBridgeList;
    bridgeFleetList.setAttribute("aria-hidden", showBridgeList ? "false" : "true");
    for (const entry of others) {
      const state = getBridgeState(entry.id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bridge-fleet-row";
      row.style.setProperty("--bridge-color", bridgeColorFor(entry));
      row.title = `${bridgeDisplayLabel(entry)} ${bridgeMetaText(entry, state)}`;
      const dot = document.createElement("span");
      dot.className = "bridge-row-dot";
      dot.style.backgroundColor = bridgeColorFor(entry);
      const main = document.createElement("span");
      main.className = "bridge-row-main";
      const title = document.createElement("strong");
      title.textContent = bridgeWorkspaceLabel(entry, state, entry.id);
      const small = document.createElement("small");
      small.textContent = `作業場所: ${bridgeMetaText(entry, state)}`;
      const build = document.createElement("small");
      build.className = "bridge-build-label";
      build.textContent = buildLabelForState(state);
      main.append(title, small, build);
      const badges = document.createElement("span");
      badges.className = "bridge-row-badges";
      const stateName = bridgeStateLabel(entry, state);
      if (["running", "streaming", "syncing", "interrupting"].includes(stateName)) badges.appendChild(fleetBadge("実行中", "running"));
      if (stateName === "approval") badges.appendChild(fleetBadge("承認", "approval"));
      if (stateName === "error" || stateName === "disconnected") badges.appendChild(fleetBadge("切断", "error"));
      row.append(dot, main, badges);
      row.addEventListener("click", () => setActiveBridge(entry.id));
      bridgeFleetList.appendChild(row);
    }
  }

  renderSidebarProjectBridge();
  renderBuildNotice(entries);
  renderBridgeFleetSheet();
  renderGlobalApprovalBanner();
}

function renderBridgeFleetSheet() {
  const entries = bridgeRegistry.bridges || [];
  if (bridgeFleetSummary) {
    const approvals = collectPendingApprovals().length;
    bridgeFleetSummary.textContent = `接続先 ${entries.length}件 / 承認待ち ${approvals}件 / 表示中 ${bridgeDisplayLabel(activeBridge(), "現在の接続先")}`;
  }
  if (bridgeFleetSheetList) {
    bridgeFleetSheetList.replaceChildren();
    for (const entry of entries) {
      const state = getBridgeState(entry.id);
      const card = document.createElement("article");
      card.className = entry.id === activeBridgeId ? "bridge-sheet-card active" : "bridge-sheet-card";
      card.style.setProperty("--bridge-color", bridgeColorFor(entry));
      const header = document.createElement("div");
      header.className = "bridge-sheet-card-header";
      const dot = document.createElement("span");
      dot.className = "bridge-row-dot";
      dot.style.backgroundColor = bridgeColorFor(entry);
      const main = document.createElement("span");
      main.className = "bridge-row-main";
      const title = document.createElement("strong");
      title.textContent = bridgeWorkspaceLabel(entry, state, entry.id);
      const small = document.createElement("small");
      small.textContent = `${entry.baseUrl} / 接続キー ${entry.rememberToken === false ? "この画面だけ" : "保存済み"} ${maskToken(effectiveBridgeToken(entry))}`;
      main.append(title, small);
      header.append(dot, main, fleetBadge(runStateShortLabel(bridgeStateLabel(entry, state)), bridgeStateLabel(entry, state) === "approval" ? "approval" : ""));
      const metaLine = document.createElement("small");
      // Which connection is serving the page was written down nowhere, and it is
      // the one that decides whose copy of the UI you are looking at - a change
      // made on any other machine cannot show up here until you open that one.
      const servesThisPage = entry.id === homeBridgeId ? " / この画面の配信元" : "";
      metaLine.textContent = `作業場所: ${bridgeMetaText(entry, state)} / ${entry.kind || "lan"}${entry.note ? ` / ${entry.note}` : ""}${servesThisPage}`;
      const buildLine = document.createElement("small");
      buildLine.className = "bridge-build-label";
      buildLine.textContent = buildLabelForState(state);
      const actions = document.createElement("div");
      actions.className = "bridge-card-actions";
      const switchButton = document.createElement("button");
      switchButton.type = "button";
      switchButton.textContent = entry.id === activeBridgeId ? "表示中" : "切替";
      switchButton.disabled = entry.id === activeBridgeId;
      // Off because it is already the answer, not because it is unavailable.
      switchButton.setAttribute("aria-current", String(entry.id === activeBridgeId));
      switchButton.addEventListener("click", () => setActiveBridge(entry.id));
      const reconnectButton = document.createElement("button");
      reconnectButton.type = "button";
      reconnectButton.className = "secondary";
      reconnectButton.textContent = "再確認";
      reconnectButton.addEventListener("click", () => refreshBridgeState(entry.id, { force: true }));
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "secondary";
      openButton.textContent = "別タブ";
      openButton.addEventListener("click", () => window.open(urlWithBridgeToken("/", entry), "_blank", "noopener"));
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "secondary";
      copyButton.textContent = "コピー";
      copyButton.addEventListener("click", async () => {
        await copyTextToClipboard(`${bridgeDisplayLabel(entry, entry.id)} ${entry.baseUrl} 接続キー=${maskToken(effectiveBridgeToken(entry))}`);
        showToast("伏せ字にした接続先情報をコピーしました。");
      });
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary";
      removeButton.textContent = "削除";
      removeButton.disabled = entry.id === homeBridgeId;
      // Which row is serving the page is not otherwise visible anywhere, and a
      // greyed button with no reason on it just moves the question along.
      removeButton.title = removeButton.disabled
        ? "この接続先からこの画面を開いているため削除できません"
        : `${bridgeDisplayLabel(entry, entry.id)} をこの端末から削除`;
      removeButton.addEventListener("click", () => removeBridge(entry.id));
      actions.append(switchButton, reconnectButton, openButton, copyButton, removeButton);
      card.append(header, metaLine, buildLine, actions);
      bridgeFleetSheetList.appendChild(card);
    }
  }
  renderGlobalApprovalInbox();
  renderGlobalRunningMonitor();
  renderSessionActivity();
}

function sessionActivityObservations() {
  const observations = [];
  for (const entry of bridgeRegistry.bridges || []) {
    const state = getBridgeState(entry.id);
    const runs = new Map();
    for (const run of state.status?.bridges || []) {
      if (run.threadId) runs.set(`${run.provider}:${run.threadId}`, run);
    }
    // A response to an earlier poll must not undo a newer socket event.
    for (const [key, run] of state.sessionRuns) {
      if (run.observedAt >= state.statusRequestedAt) runs.set(key, run);
    }
    const seen = new Set();
    for (const [key, run] of runs) {
      const thread = state.sessionTitles.get(key) || (entry.id === activeBridgeId ? threadCache : state.threadCache).find((item) => item.id === run.threadId && item.provider === run.provider);
      const observation = {
        ...run, bridgeId: entry.id, machineKey: bridgeMachineKey(entry, state), machineLabel: shortMachineName(entry, state),
        title: thread ? titleForThread(thread) : "", workdir: run.workdir || thread?.cwd || "",
      };
      if (!state.connected && state.lastError) {
        // Keep the last known completed answer, but do not invent progress
        // (or a task failure) when only the connection has failed.
        if (uiUtils.sessionActivityStatus(run.run, run.pendingApproval) !== "done") {
          observation.run = { state: "offline" };
          observation.pendingApproval = null;
        }
      }
      seen.add(uiUtils.sessionActivityKey(observation));
      observations.push(observation);
    }
    for (const item of sessionActivityRecords) {
      if (item.bridgeId === entry.id && !seen.has(item.key) && item.status === "running" && (state.status || state.lastError)) {
        observations.push({ ...item, run: { state: "offline" } });
      }
    }
  }
  return observations;
}

function currentSessionActivityKey() {
  return uiUtils.sessionActivityKey({ bridgeId: activeBridgeId, machineKey: bridgeMachineKey(activeBridge() || {}, getBridgeState()), provider: currentThreadProvider(), threadId: selectedThread });
}

function saveSessionActivity() {
  const serialized = JSON.stringify(sessionActivityRecords);
  if (serialized !== sessionActivitySaved) {
    safeWriteStorage(localStorage, sessionActivityStorageKey, serialized);
    sessionActivitySaved = serialized;
  }
}

function acknowledgeCurrentSessionActivity() {
  sessionActivityRecords = uiUtils.acknowledgeSessionActivity(sessionActivityRecords, currentSessionActivityKey());
  saveSessionActivity();
  renderSessionActivity();
}

async function openSessionActivity(item) {
  if (threadSwitchBusy) return;
  sessionActivityDialog.close();
  setMainView("chat");
  if (item.key === currentSessionActivityKey() && connectionReady && item.status !== "offline") {
    scrollChatToBottom();
    if (pendingApproval && ["approval", "question"].includes(item.status)) revealPendingApproval();
    acknowledgeCurrentSessionActivity();
    return;
  }
  try {
    await selectThread(item.threadId, { bridgeId: item.bridgeId, workdir: item.workdir, thread: { id: item.threadId, provider: item.provider, cwd: item.workdir, displayTitle: item.title } });
    // A different conversation is acknowledged only after its ready/history
    // response, never just because the user attempted to open an offline Mac.
  } catch (error) {
    showToast("会話を開けませんでした。接続先を確認してください。");
  }
}

function renderSessionActivityButtons(container, items, expanded = false) {
  const existing = new Map(Array.from(container.children).map((entry) => [entry.dataset.sessionKey, entry]));
  const currentKey = currentSessionActivityKey();
  // Keep the horizontal shortcuts stable; the full list puts attention first.
  const ordered = expanded ? [...items].sort((a, b) => sessionActivityOrder.indexOf(a.status) - sessionActivityOrder.indexOf(b.status)) : items;
  for (const [index, item] of ordered.entries()) {
    let entry = existing.get(item.key);
    if (!entry) {
      entry = document.createElement("div");
      entry.className = expanded ? "session-activity-item expanded" : "session-activity-item";
      entry.dataset.sessionKey = item.key;
      const button = document.createElement("button");
      button.type = "button";
      button.className = expanded ? "session-activity-row" : "session-activity-chip";
      button.dataset.sessionKey = item.key;
      const capsule = document.createElement("span");
      capsule.className = "session-activity-capsule";
      // Static markup only; session titles never enter innerHTML.
      capsule.innerHTML = '<svg class="session-activity-outline" aria-hidden="true"><rect pathLength="100" /></svg><span class="session-activity-name"></span><span class="session-activity-symbol" aria-hidden="true"></span>';
      button.append(capsule);
      if (expanded) {
        const detail = document.createElement("span");
        detail.className = "session-activity-detail";
        button.append(detail);
      }
      button.addEventListener("click", () => {
        const current = sessionActivityRecords.find((record) => record.key === button.dataset.sessionKey);
        if (current) openSessionActivity(current);
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "session-activity-dismiss";
      dismiss.textContent = "×";
      dismiss.addEventListener("click", () => {
        sessionActivityRecords = uiUtils.dismissSessionActivity(sessionActivityRecords, entry.dataset.sessionKey);
        saveSessionActivity();
        renderSessionActivity();
        if (sessionActivityStrip.hidden) document.querySelector("#prompt")?.focus({ preventScroll: true });
        showToast("表示を片づけました。会話は一覧から開けます。");
      });
      entry.append(button, dismiss);
      container.append(entry);
    }
    existing.delete(item.key);
    const button = entry.firstElementChild;
    const ordinal = item.ordinal <= 20 ? String.fromCodePoint(0x245f + item.ordinal) : String(item.ordinal);
    const name = `${item.provider === "claude" ? "Claude" : "Codex"} ${item.machineLabel}${ordinal}`;
    const label = `${name}：${sessionActivityLabels[item.status]}。${item.title}`;
    button.dataset.state = item.status;
    button.setAttribute("aria-current", item.key === currentKey ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.querySelector(".session-activity-name").textContent = name;
    button.querySelector(".session-activity-symbol").textContent = ({ done: "✓", question: "?", approval: "?", error: "!", offline: "!", interrupted: "−" })[item.status] || "";
    const dismiss = entry.querySelector(".session-activity-dismiss");
    dismiss.hidden = !uiUtils.canDismissSessionActivity(item);
    entry.classList.toggle("dismissible", !dismiss.hidden);
    dismiss.setAttribute("aria-label", `${name}の${sessionActivityLabels[item.status]}表示を片づける（会話は残ります）`);
    dismiss.title = "この表示を片づける（会話は残ります）";
    if (expanded) button.querySelector(".session-activity-detail").textContent = `${sessionActivityLabels[item.status]} · ${item.title}`;
    const position = container.children[index];
    if (position !== entry) container.insertBefore(entry, position || null);
  }
  for (const entry of existing.values()) {
    if (entry.contains(document.activeElement)) {
      const next = Array.from(container.children).find((item) => !existing.has(item.dataset.sessionKey));
      (next?.querySelector("button") || document.querySelector(expanded ? "#closeSessionActivity" : "#prompt"))?.focus({ preventScroll: true });
    }
    entry.remove();
  }
}

function renderSessionActivitySummary(items) {
  const totals = [];
  const descriptions = [];
  for (const status of sessionActivityOrder) {
    const count = items.filter((item) => item.status === status).length;
    if (!count) continue;
    const total = document.createElement("span");
    total.className = "session-activity-total";
    total.dataset.state = status;
    const label = ({ done: "未確認完了", offline: "接続確認" })[status] || sessionActivityLabels[status];
    total.textContent = `${label} ${count}`;
    totals.push(total);
    descriptions.push(`${sessionActivityLabels[status]} ${count}件`);
  }
  const label = `${descriptions.join("、")}。全${items.length}件の一覧を開く`;
  // Polling unchanged counts must not repeatedly announce the live summary.
  if (sessionActivityCount.getAttribute("aria-label") === label) return;
  sessionActivityCount.replaceChildren(...totals);
  sessionActivityCount.setAttribute("aria-label", label);
}

function renderSessionActivity() {
  if (!sessionActivityStrip) return;
  sessionActivityRecords = uiUtils.reconcileSessionActivity(sessionActivityRecords, sessionActivityObservations(), { bridgeIds: (bridgeRegistry.bridges || []).map((entry) => entry.id) });
  saveSessionActivity();
  const items = uiUtils.visibleSessionActivity(sessionActivityRecords);
  sessionActivityStrip.hidden = items.length === 0;
  renderSessionActivitySummary(items);
  renderSessionActivityButtons(sessionActivityItems, items);
  if (sessionActivityDialog.open) {
    renderSessionActivityButtons(sessionActivityList, items, true);
    if (!items.length) sessionActivityDialog.close();
  }
}

sessionActivityCount?.addEventListener("click", async () => {
  renderSessionActivityButtons(sessionActivityList, uiUtils.visibleSessionActivity(sessionActivityRecords), true);
  sessionActivityDialog.showModal();
  // Titles for the other provider are loaded only when the full list is
  // requested; they must never replace the sidebar's provider-specific cache.
  const requests = new Map();
  for (const item of uiUtils.visibleSessionActivity(sessionActivityRecords)) requests.set(`${item.bridgeId}:${item.provider}`, item);
  await Promise.all(Array.from(requests.values()).map(async (item) => {
    const entry = bridgeById(item.bridgeId);
    if (!entry) return;
    try {
      const result = await fetchJsonForBridge(entry, `/api/threads?provider=${encodeURIComponent(item.provider)}`);
      for (const thread of result.data || []) getBridgeState(entry.id).sessionTitles.set(`${thread.provider || item.provider}:${thread.id}`, thread);
    } catch { /* Keep the last known titles and connection status. */ }
  }));
  renderSessionActivity();
});
document.querySelector("#closeSessionActivity")?.addEventListener("click", () => sessionActivityDialog.close());
sessionActivityDialog?.addEventListener("click", (event) => { if (event.target === sessionActivityDialog) sessionActivityDialog.close(); });

function renderGlobalApprovalInbox() {
  if (!globalApprovalInbox) return;
  const approvals = collectPendingApprovals();
  globalApprovalInbox.replaceChildren();
  if (!approvals.length) {
    const empty = document.createElement("div");
    empty.className = "bridge-sheet-card";
    empty.textContent = "承認待ちはありません。";
    globalApprovalInbox.appendChild(empty);
    return;
  }
  for (const item of approvals) {
    const card = document.createElement("article");
    card.className = "global-approval-card";
    const title = document.createElement("strong");
    title.textContent = `${bridgeDisplayLabel(item.bridge, item.bridge.id)} / ${shortId(item.threadId) || "チャット"}`;
    const summary = document.createElement("small");
    summary.textContent = approvalSummaryText(item.request);
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(item.request?.params || item.request || {}, null, 2);
    const actions = document.createElement("div");
    actions.className = "global-approval-actions";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "拒否";
    reject.addEventListener("click", () => sendGlobalApproval(item, "decline"));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "承認";
    approve.addEventListener("click", () => sendGlobalApproval(item, "accept"));
    actions.append(reject, approve);
    card.append(title, summary, pre, actions);
    globalApprovalInbox.appendChild(card);
  }
}

function renderGlobalRunningMonitor() {
  if (!globalRunningMonitor) return;
  globalRunningMonitor.replaceChildren();
  for (const entry of bridgeRegistry.bridges || []) {
    const state = getBridgeState(entry.id);
    const summary = bridgeRunSummary(entry.id);
    const row = document.createElement("article");
    row.className = "global-monitor-row";
    const header = document.createElement("div");
    header.className = "global-monitor-row-header";
    const dot = document.createElement("span");
    dot.className = "bridge-row-dot";
    dot.style.backgroundColor = bridgeColorFor(entry);
    const main = document.createElement("span");
    main.className = "bridge-row-main";
    const title = document.createElement("strong");
    title.textContent = bridgeWorkspaceLabel(entry, state, entry.id);
    const small = document.createElement("small");
    small.textContent = `${runStateShortLabel(summary.run?.state || bridgeStateLabel(entry, state))} / ${formatRelativeTime(state.lastEventAt) || "now"}`;
    main.append(title, small);
    header.append(dot, main, fleetBadge(summary.run?.state || bridgeStateLabel(entry, state)));
    const last = document.createElement("small");
    const tail = summary.terminalTail || [];
    last.textContent = tail.length ? tail[tail.length - 1].message : state.lastError || bridgeMetaText(entry, state);
    row.append(header, last);
    row.addEventListener("click", () => setActiveBridge(entry.id));
    globalRunningMonitor.appendChild(row);
  }
}

function renderGlobalApprovalBanner() {
  if (!globalApprovalBanner) return;
  const approvals = collectPendingApprovals();
  globalApprovalBanner.classList.toggle("hidden", !approvals.length);
  globalApprovalBanner.replaceChildren();
  if (!approvals.length) return;
  const text = document.createElement("span");
  text.textContent = `${approvals.length}件の承認待ちがあります。`;
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "承認一覧";
  open.setAttribute("data-opens-bridge-fleet", "");
  open.addEventListener("click", openBridgeFleet);
  globalApprovalBanner.append(text, open);
}

async function fetchJsonForBridge(entry, path, options = {}) {
  const bridgeToken = effectiveBridgeToken(entry);
  const fallbackToken = entry?.id && entry.id !== homeBridgeId && token && token !== bridgeToken ? token : "";
  const firstToken = bridgeToken || fallbackToken;
  if (!firstToken) throw new Error("接続キーがありません");
  const fetchWithToken = async (tokenValue) => {
    const response = await fetchWithTimeout(urlWithBridgeToken(path, entry), {
      ...options,
      headers: authHeadersForBridge(entry, {
        ...(options.headers || {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      }, tokenValue),
    });
    const result = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
    return { response, result };
  };

  let { response, result } = await fetchWithToken(firstToken);
  if (response.status === 401 && fallbackToken && firstToken !== fallbackToken) {
    ({ response, result } = await fetchWithToken(fallbackToken));
    if (response.ok) {
      const updated = setBridgeToken(entry, fallbackToken, entry.rememberToken !== false);
      bridgeRegistry = { ...bridgeRegistry, bridges: (bridgeRegistry.bridges || []).map((bridge) => (bridge.id === entry.id ? updated : bridge)) };
      persistBridgeRegistry();
    }
  }
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

// iOS resumes a Home Screen app without reloading its page, so a fix that has
// shipped stays out of reach until the app is killed by hand - and nothing on
// screen says which build is running. The home bridge names the main.js it
// serves on every poll; when that is not the one running, the page reloads
// itself, once per served build and never while a turn or a draft is in flight.
const shellReloadStorageKey = "codexPhoneShellReloadFor:v1";
let shellReloadTimer = null;

function shellReloadBusy() {
  return liveTurnActive || threadSwitchBusy || pendingFiles.length > 0 || addButton?.disabled
    || !promptModal?.classList.contains("hidden") || Boolean((promptInput?.value || "").trim()) || document.visibilityState === "hidden";
}

function ownShellHref() {
  return document.querySelector('script[src*="main.js"]')?.getAttribute("src") || "";
}

function ownShellVersion() {
  return uiUtils.shellVersionOf ? uiUtils.shellVersionOf(ownShellHref()) : "";
}

function checkShellFreshness(info, entry) {
  if (!entry || entry.id !== homeBridgeId || !info?.shell?.main || !uiUtils.shellUpdateDecision || shellReloadTimer !== null) return;
  const decision = uiUtils.shellUpdateDecision({
    servedMain: info.shell.main,
    ownMain: ownShellHref(),
    busy: shellReloadBusy(),
    lastReloadFor: safeReadStorage(sessionStorage, shellReloadStorageKey, ""),
  });
  if (decision !== "reload") return;
  showToast("画面を新しい版に更新します。");
  shellReloadTimer = window.setTimeout(() => {
    shellReloadTimer = null;
    // A draft or upload may have started during the notice. Do not mark the
    // build reloaded until it actually is; the next idle poll can try again.
    if (shellReloadBusy()) return;
    safeWriteStorage(sessionStorage, shellReloadStorageKey, uiUtils.shellVersionOf(info.shell.main));
    location.reload();
  }, 1200);
}

async function refreshBridgeState(bridgeId, { force = false } = {}) {
  const entry = bridgeById(bridgeId);
  if (!entry) return;
  const state = getBridgeState(bridgeId);
  if (!force && state.refreshing) return;
  state.refreshing = true;
  try {
    const info = await fetchJsonForBridge(entry, "/api/bridge/info");
    state.info = info;
    if (entry.id === activeBridgeId) {
      adoptModelChoices(info?.modelChoices);
      adoptReasoningChoices(info?.reasoningChoices);
    }
    checkShellFreshness(info, entry);
    state.connected = true;
    state.lastError = "";
    state.activeProvider = info.provider || state.activeProvider || "codex";
    const provider = state.activeProvider || "codex";
    const statusRequestedAt = Date.now();
    const status = await fetchJsonForBridge(entry, `/api/status?provider=${encodeURIComponent(provider)}`);
    state.status = status;
    state.statusRequestedAt = statusRequestedAt;
    if (bridgeId === activeBridgeId) {
      setWorkspaceMeta(polledWorkspaceMeta(info, status));
    }
    state.runState = bridgeRunSummary(bridgeId).run?.state || "ready";
    state.lastEventAt = Date.now();
    const refreshed = {
      ...entry,
      // The bridge's own name is the one set on the Mac that runs it, and it
      // is the only place a name is set. The registry copy is a cache of it:
      // when the Mac is renamed, every phone follows on its next poll instead
      // of carrying the old name for good.
      label: info.label || entry.label,
      group: entry.group || info.group || "",
      workdir: info.cwd || info.workdir || entry.workdir || "",
      port: info.uiPort || entry.port || null,
      color: entry.color || info.color || "",
      status: "connected",
    };
    bridgeRegistry = { ...bridgeRegistry, bridges: (bridgeRegistry.bridges || []).map((bridge) => (bridge.id === bridgeId ? touchBridgeEntry(entry, refreshed) : bridge)) };
    persistBridgeRegistry();
  } catch (error) {
    state.connected = false;
    state.runState = "error";
    state.lastError = error.message || String(error);
    state.lastEventAt = Date.now();
    // Unreachable is a state, not an edit - and it is often exactly why the
    // owner deleted the bridge somewhere else.
    bridgeRegistry = { ...bridgeRegistry, bridges: (bridgeRegistry.bridges || []).map((bridge) => (bridge.id === bridgeId ? { ...bridge, status: "error" } : bridge)) };
    persistBridgeRegistry();
  } finally {
    state.refreshing = false;
    renderFleet();
  }
}

async function refreshFleet({ force = false } = {}) {
  if (fleetRefreshInFlight) return fleetRefreshPromise;
  fleetRefreshInFlight = true;
  fleetRefreshPromise = (async () => {
    await Promise.all((bridgeRegistry.bridges || []).map((entry) => refreshBridgeState(entry.id, { force })));
  })();
  try {
    await fleetRefreshPromise;
  } finally {
    fleetRefreshInFlight = false;
    fleetRefreshPromise = null;
    renderFleet();
  }
}

function captureActiveBridgeState() {
  if (!activeBridgeId) return;
  preserveSelectedThreadInList({ runState: currentRunState });
  const state = getBridgeState(activeBridgeId);
  state.threadCache = threadCache;
  state.selectedThread = selectedThread;
  state.selectedThreads = Object.fromEntries(selectedThreadByProvider);
  state.hiddenProjects = hiddenProjects;
  state.pendingApproval = pendingApproval;
  state.artifactItems = artifactItems;
  state.currentWorkspace = { ...currentWorkspace };
  state.workspaceFollowsSelectedThread = workspaceFollowsSelectedThread;
  state.activeProvider = activeProvider;
  state.threadProvider = threadProvider;
  state.threadProviderExplicit = threadProviderExplicit;
  state.runState = currentRunState;
  state.connected = connectionReady;
}

function applyActiveBridgeState(bridgeId) {
  const state = getBridgeState(bridgeId);
  const view = bridgeViewState[bridgeId] || {};
  threadCache = Array.isArray(state.threadCache) ? state.threadCache : [];
  hiddenProjects = Array.isArray(state.hiddenProjects) ? state.hiddenProjects : [];
  // The icon seeds the provider once. A later return to this Mac must restore
  // the provider/thread pair, never combine a Claude id with the Codex icon.
  const launchProvider = !state.viewInitialized && bridgeId === launchProviderBridgeId ? initialProviderParam : "";
  const selections = { ...view.selectedThreads, ...state.selectedThreads };
  const savedProvider = normalizeProviderName(view.provider);
  if (savedProvider && !Object.prototype.hasOwnProperty.call(selections, savedProvider)) selections[savedProvider] = view.selectedThread || "";
  if (state.viewInitialized && state.threadProvider) selections[state.threadProvider] = state.selectedThread || "";
  activeProvider = normalizeProviderName(launchProvider || state.activeProvider || view.provider || state.info?.provider || "codex") || "codex";
  threadProvider = normalizeProviderName(launchProvider || state.threadProvider || view.provider || activeProvider) || activeProvider;
  threadProviderExplicit = Boolean(launchProvider || state.threadProviderExplicit || view.provider);
  selectedThread = initialUrlThreadPending ? params.get("thread") || "" : selections[threadProvider] || "";
  state.viewInitialized = true;
  pendingApproval = state.pendingApproval || null;
  artifactItems = Array.isArray(state.artifactItems) ? state.artifactItems : [];
  Object.assign(currentWorkspace, state.currentWorkspace || {});
  workspaceFollowsSelectedThread = Boolean(state.workspaceFollowsSelectedThread);
  token = effectiveBridgeToken(activeBridge()) || "";
  selectedThreadByProvider.clear();
  for (const provider of ["codex", "claude"]) {
    if (typeof selections[provider] === "string") selectedThreadByProvider.set(provider, selections[provider]);
  }
  selectedThreadByProvider.set(threadProvider, selectedThread);
  // The composer's model and its menu follow the Mac being switched to: its
  // remembered model, and the models that Mac's account actually has.
  adoptModelChoices(state.info?.modelChoices);
  adoptReasoningChoices(state.info?.reasoningChoices);
  applySelectedModel();
}

async function setActiveBridge(bridgeId, { silent = false, reconnect = true, followThreadWorkdir = false } = {}) {
  if (!bridgeById(bridgeId) || bridgeId === activeBridgeId) {
    renderFleet();
    return;
  }
  saveScrollPositions();
  saveDraftForActiveThread();
  captureActiveBridgeState();
  closeSocket({ suppressReconnect: true });
  activeBridgeId = bridgeId;
  initialUrlThreadPending = false;
  bridgeRegistry = {
    ...bridgeRegistry,
    bridges: (bridgeRegistry.bridges || []).map((entry) => (entry.id === bridgeId ? { ...entry, lastUsedAt: Date.now(), status: "active" } : entry)),
  };
  persistBridgeRegistry();
  applyActiveBridgeState(bridgeId);
  workspaceFollowsSelectedThread = Boolean(followThreadWorkdir);
  updateUrlThread();
  lastHistorySignature = "";
  assistantEntry = null;
  liveOutputGroup = "";
  setReady(false);
  setRunState(getBridgeState(bridgeId).runState || "connecting");
  renderHistory([]);
  renderThreadList();
  renderArtifactIndex(artifactItems);
  restoreDraftForCurrentThread();
  applyCurrentThreadAccent();
  if (!workspaceFollowsSelectedThread) {
    const state = getBridgeState(bridgeId);
    const entry = activeBridge() || {};
    const infoMeta = workspaceMetaFromBridgeInfo(state.info || {});
    setWorkspaceMeta(
      hasWorkspaceMeta(infoMeta)
        ? infoMeta
        : {
            repoName: basenameFromPath(entry.workdir || ""),
            workspaceLocation: usableWorkspaceLocation(entry.workdir || ""),
            gitBranch: "",
          },
    );
  } else {
    setWorkspaceMeta({});
  }
  renderTerminalTranscript();
  renderFleet();
  if (!silent) {
    const moved = activeBridge();
    showToast(`${bridgeWorkspaceLabel(moved || {}, getBridgeState(activeBridgeId), "接続先")} に切り替えました。`);
  }
  if (!reconnect) {
    refreshBridgeState(bridgeId, { force: true }).catch(() => {});
    return;
  }
  await refreshBridgeState(bridgeId).catch(() => {});
  loadArtifacts();
  await syncProviderFromBridge();
  loadThreads({ background: true }).finally(() => connect());
}

function removeBridge(bridgeId) {
  if (bridgeId === homeBridgeId) return;
  const entry = bridgeById(bridgeId);
  if (!entry) return;
  if (!window.confirm(`${bridgeDisplayLabel(entry, entry.id)} をこの端末から削除します。接続キーも忘れます。`)) return;
  delete bridgeSessionTokens[bridgeId];
  forgetBridgeToken(bridgeId);
  saveBridgeSessionTokens();
  saveBridgeLocalTokens();
  // The removal record travels with the registry, so the backup - and any
  // other device restoring from it - stops offering this bridge back.
  bridgeRegistry = uiUtils.removeBridgeFromRegistry
    ? uiUtils.removeBridgeFromRegistry(bridgeRegistry, bridgeId)
    : {
        ...bridgeRegistry,
        bridges: (bridgeRegistry.bridges || []).filter((bridge) => bridge.id !== bridgeId),
        deleted: [...(bridgeRegistry.deleted || []).filter((record) => record.id !== bridgeId), { id: bridgeId, deletedAt: Date.now() }],
      };
  bridgeStates.delete(bridgeId);
  persistBridgeRegistry();
  if (activeBridgeId === bridgeId) setActiveBridge(homeBridgeId, { silent: true });
  renderFleet();
}

function openBridgeFleet(options = {}) {
  const focusAdd = options?.focusAdd === true;
  bridgeFleetSheet?.classList.remove("hidden");
  fleetDashboardButton?.setAttribute("aria-expanded", "true");
  setSidebarVisible(false);
  renderFleet();
  if (focusAdd && bridgeAddInput) {
    window.requestAnimationFrame(() => {
      bridgeAddInput.scrollIntoView({ block: "center", behavior: "smooth" });
      bridgeAddInput.focus({ preventScroll: true });
    });
  }
}

function closeBridgeFleet() {
  bridgeFleetSheet?.classList.add("hidden");
  fleetDashboardButton?.setAttribute("aria-expanded", "false");
}

function clickClosesBridgeFleet(target) {
  if (uiUtils.clickClosesBridgeFleet) return uiUtils.clickClosesBridgeFleet(target, bridgeFleetSheet);
  return Boolean(target) && !bridgeFleetSheet?.contains(target) && !target.closest?.("[data-opens-bridge-fleet]");
}

async function addBridgeEntriesFromInput() {
  const lines = String(bridgeAddInput?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return;
  bridgeAddSubmit.disabled = true;
  const remember = bridgeRememberToken?.checked !== false;
  const results = [];
  try {
    for (const line of lines) {
      const parsed = uiUtils.parseBridgeUrl ? uiUtils.parseBridgeUrl(line, { fallbackOrigin: location.origin }) : null;
      if (!parsed?.baseUrl || !parsed.token) {
        results.push("失敗: URLまたは接続キーを読めません");
        continue;
      }
      let entry = normalizeBridgeEntry({ baseUrl: parsed.baseUrl, token: parsed.token, rememberToken: remember }, { fallbackOrigin: location.origin });
      entry = setBridgeToken(entry, parsed.token, remember);
      try {
        const info = await fetchJsonForBridge(entry, "/api/bridge/info");
        const previousId = entry.id;
        entry = {
          ...entry,
          id: info.id || entry.id,
          label: info.label || entry.label,
          group: info.group || entry.group,
          workdir: info.cwd || info.workdir || entry.workdir,
          port: info.uiPort || entry.port,
          color: entry.color || info.color || "",
        };
        if (!remember) {
          delete bridgeSessionTokens[previousId];
          bridgeSessionTokens[entry.id] = parsed.token;
        } else if (previousId !== entry.id) {
          forgetBridgeToken(previousId);
          bridgeLocalTokens[entry.id] = parsed.token;
          stampBridgeToken(entry.id);
        }
        bridgeRegistry = uiUtils.upsertBridgeRegistry ? uiUtils.upsertBridgeRegistry(bridgeRegistry, entry) : { ...bridgeRegistry, bridges: [...(bridgeRegistry.bridges || []), entry] };
        results.push(`追加: ${bridgeDisplayLabel(entry, entry.id)}`);
      } catch (error) {
        results.push(`失敗: ${entry.baseUrl} ${error.message}`);
      }
    }
    persistBridgeRegistry();
    saveBridgeSessionTokens();
    if (bridgeAddInput) bridgeAddInput.value = "";
    renderFleet();
    refreshFleet({ force: true });
  } finally {
    bridgeAddSubmit.disabled = false;
    if (bridgeAddStatus) bridgeAddStatus.textContent = results.join(" / ");
  }
}

async function sendGlobalApproval(item, decision) {
  if (decision === "accept" && /command|file|write|edit|apply/i.test(JSON.stringify(item.request || {}))) {
    if (!window.confirm(`${bridgeDisplayLabel(item.bridge, item.bridge.id)} の承認を送信します。対象を確認しましたか？`)) return;
  }
  try {
    await fetchJsonForBridge(item.bridge, "/api/approval", {
      method: "POST",
      body: JSON.stringify({
        provider: item.provider,
        threadId: item.threadId,
        request: item.request,
        decision,
      }),
    });
    if (item.bridgeId === activeBridgeId) {
      appendTerminalEntry({ ts: Date.now(), kind: "approval", message: decision === "accept" ? "承認しました" : "拒否しました" });
      pendingApproval = null;
      approval.classList.add("hidden");
      renderApprovalStrip(null);
      setRunState("running", decision === "accept" ? "承認済み・処理中" : "拒否済み・処理中");
    }
    showToast(decision === "accept" ? "承認を送信しました。" : "拒否を送信しました。", "approval");
    await refreshBridgeState(item.bridgeId, { force: true });
  } catch (error) {
    showToast(`承認操作に失敗しました: ${error.message}`, "approval");
  }
}

function selectAdjacentThread(direction, source = "button") {
  if (liveTurnActive || pendingApproval || threadSwitchBusy) {
    showSwipeFeedback(pendingApproval ? "承認待ちのためチャット切替を止めています。" : "実行中はチャット切替を止めています。");
    return;
  }
  const target = adjacentThread(direction);
  if (!target) {
    showSwipeFeedback(direction > 0 ? "同じ作業場所内に次のチャットはありません。" : "同じ作業場所内に前のチャットはありません。");
    return;
  }
  selectThread(target.id, { workdir: workspaceKeyForThread(target), project: projectForThread(target) });
  showToast(`${direction > 0 ? "次" : "前"}のチャットへ切り替えました。`);
  showSwipeFeedback(`${direction > 0 ? "次" : "前"}のチャットへ切り替えました。`);
  if (source === "swipe") addStatus(`${direction > 0 ? "左" : "右"}スワイプでチャットを切り替えました。`);
}

let swipeHintTimer = 0;
let swipeHintDeferred = false;

// One first-run hint at a time. This one and the install card land in the same
// strip and fire from independent async chains, so whichever arrives second
// waits instead of stacking on top of the other.
function showInitialSwipeHint() {
  if (localStorage.getItem(swipeHintStorageKey) || !window.matchMedia("(max-width: 820px)").matches) return;
  if (document.querySelector(".pwa-install-hint")) {
    swipeHintDeferred = true;
    return;
  }
  swipeHintDeferred = false;
  window.clearTimeout(swipeHintTimer);
  // Marked seen only once it is actually on screen, so a hint that yielded to
  // the install card still gets its turn rather than being spent unshown.
  swipeHintTimer = window.setTimeout(() => {
    swipeHintTimer = 0;
    localStorage.setItem(swipeHintStorageKey, "1");
    showSwipeFeedback("左右スワイプで同じ作業場所内の前後へ移動できます。");
  }, 800);
}

function deferSwipeHint() {
  if (localStorage.getItem(swipeHintStorageKey)) return;
  window.clearTimeout(swipeHintTimer);
  swipeHintTimer = 0;
  swipeHintDeferred = true;
}

function resumeDeferredSwipeHint() {
  if (!swipeHintDeferred) return;
  swipeHintDeferred = false;
  showInitialSwipeHint();
}

function renderThreadSwitcher() {
  if (!threadSwitcherList) return;
  threadSwitcherList.replaceChildren();
  const threads = visibleThreadsInListOrder();
  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "thread-switcher-empty";
    empty.textContent = "同じ作業場所内のチャットはありません。";
    threadSwitcherList.appendChild(empty);
    return;
  }
  for (const thread of threads) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = thread.id === selectedThread ? "thread-switcher-row active" : "thread-switcher-row";
    row.disabled = threadSwitchBusy || liveTurnActive || Boolean(pendingApproval);
    const dot = document.createElement("span");
    dot.className = "thread-switcher-dot";
    dot.style.backgroundColor = repoColorForThread(thread);
    const main = document.createElement("span");
    main.className = "thread-switcher-main";
    const title = document.createElement("strong");
    title.textContent = titleForThread(thread);
    const metaLine = document.createElement("small");
    metaLine.textContent = `${formatRelativeTime(thread.updatedAt || thread.createdAt) || "now"} / ${thread.id === selectedThread ? runStateShortLabel() : "待機中"}`;
    main.append(title, metaLine);
    row.append(dot, main);
    row.addEventListener("click", () => {
      if (thread.id !== selectedThread) selectThread(thread.id, { workdir: workspaceKeyForThread(thread), project: projectForThread(thread) });
      closeThreadSwitcher();
    });
    threadSwitcherList.appendChild(row);
  }
}

function openThreadSwitcher() {
  renderThreadSwitcher();
  threadSwitcher?.classList.remove("hidden");
  closeThreadSwitcherButton?.focus({ preventScroll: true });
}

function closeThreadSwitcher() {
  threadSwitcher?.classList.add("hidden");
}

function isSwipeIgnoredTarget(target) {
  if (mainViewMode === "terminal" || liveTurnActive || pendingApproval || threadSwitchBusy || document.body.classList.contains("terminal-focus-mode")) return true;
  if (!window.matchMedia("(max-width: 820px)").matches) return true;
  return Boolean(
    target.closest(
      "textarea,input,button,select,a,pre,code,[role='button'],[role='menu'],dialog,.model-menu,.prompt-modal,.approval,.terminal-view,.terminal-ops,.artifact-panel,.sidebar,.sidebar-scrim,.thread-switcher,.thread-color-popover,.image-gallery",
    ),
  );
}

// A drag that begins inside a strip that scrolls sideways is that strip's own:
// code blocks, wide tables and the chip rows all reach the screen edge, and a
// drawer that opened instead of scrolling them would be the gesture stealing
// content the finger was aiming at.
function insideHorizontalScroller(target) {
  for (let node = target; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 4) continue;
    const overflowX = window.getComputedStyle(node).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

// Asked again by each listener that sees the touch rather than answered once
// and shared, so the conversation swipe and the drawer swipe settle "whose touch
// is this?" identically without depending on which of them the event reaches
// first.
function sidebarEdgeSwipeStartFrom(event) {
  if (event.touches?.length !== 1) return null;
  const touch = event.touches[0];
  // Where the finger landed decides first. Every touch on the screen reaches
  // this, and only the few that start on the edge go on to pay for reading the
  // DOM - resolving styles on each tap and scroll is the kind of cost that shows
  // up as a phone feeling slow.
  const onEdge = uiUtils.startsSidebarEdgeSwipe({
    x: touch.clientX,
    width: window.innerWidth,
    sidebarOpen: document.body.classList.contains("show-sidebar"),
  });
  if (!onEdge) return null;
  if (document.querySelector(uiUtils.sidebarEdgeSwipeBlockerSelector)) return null;
  if (insideHorizontalScroller(event.target)) return null;
  return { x: touch.clientX, y: touch.clientY, time: Date.now() };
}

function handleSidebarEdgeSwipeStart(event) {
  sidebarEdgeSwipeStart = sidebarEdgeSwipeStartFrom(event);
}

function handleSidebarEdgeSwipeEnd(event) {
  const start = sidebarEdgeSwipeStart;
  sidebarEdgeSwipeStart = null;
  if (!start || !event.changedTouches?.length) return;
  const touch = event.changedTouches[0];
  const opens = uiUtils.completesSidebarEdgeSwipe({
    dx: touch.clientX - start.x,
    dy: touch.clientY - start.y,
    elapsed: Date.now() - start.time,
  });
  if (!opens || document.body.classList.contains("show-sidebar")) return;
  setSidebarVisible(true);
  closeRightPanel();
}

function handleSwipeStart(event) {
  if (!event.touches?.length || isSwipeIgnoredTarget(event.target)) {
    swipeStart = null;
    return;
  }
  // The drawer's edge strip wins the touch: both gestures are a rightward drag
  // over the conversation, so one of them has to yield or a single swipe would
  // open the drawer and change the chat behind it.
  if (sidebarEdgeSwipeStartFrom(event)) {
    swipeStart = null;
    return;
  }
  const touch = event.touches[0];
  swipeStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
}

function handleSwipeEnd(event) {
  if (!swipeStart || !event.changedTouches?.length) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  const elapsed = Date.now() - swipeStart.time;
  swipeStart = null;
  if (elapsed > 900) return;
  if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
  selectAdjacentThread(dx < 0 ? 1 : -1, "swipe");
}

function setMainView(view) {
  saveScrollPositions();
  mainViewMode = view === "terminal" ? "terminal" : "chat";
  localStorage.setItem(mainViewStorageKey, mainViewMode);
  // The shell, not the log: hiding only the log would leave 最新へ floating over
  // the terminal view.
  logShell.classList.toggle("hidden", mainViewMode !== "chat");
  mainTerminalView.classList.toggle("hidden", mainViewMode !== "terminal");
  terminalOps?.classList.toggle("hidden", mainViewMode !== "terminal");
  chatViewButton.classList.toggle("active", mainViewMode === "chat");
  terminalViewButton.classList.toggle("active", mainViewMode === "terminal");
  chatViewButton.setAttribute("aria-pressed", String(mainViewMode === "chat"));
  terminalViewButton.setAttribute("aria-pressed", String(mainViewMode === "terminal"));
  chatViewButton.setAttribute("aria-selected", String(mainViewMode === "chat"));
  terminalViewButton.setAttribute("aria-selected", String(mainViewMode === "terminal"));
  document.body.dataset.mainView = mainViewMode;
  if (mainViewMode === "terminal") {
    promptInput?.blur();
    promptInputFocused = false;
    unreadTerminalCount = 0;
    renderTerminalTranscript();
  } else {
    unreadChatCount = 0;
    toggleTerminalToolsSheet(false);
  }
  updateUnreadBadges();
  updateComposerState();
  updateQuickBarVisibility();
  restoreScrollPositions();
  measureTerminalLayout();
}

function renderThreadColorSettings(thread = null, options = {}) {
  const container = options.container || artifactList;
  const target = thread || threadCache.find((candidate) => candidate.id === selectedThread) || {
    provider: currentThreadProvider(),
    cwd: currentWorkspace.workspaceLocation || currentWorkspace.repoName || "",
    repoName: currentWorkspace.repoName,
  };
  const key = repoColorKeyForContext(target);
  const activeColor = repoColorForKey(key);
  const customColor = sanitizeHexColor(repoColorOverrides[key]);
  // Without a repo name the fallback used to be a name too, so the heading read
  // "現在のリポ のリポ色". One subject, built once, for the heading and the toasts.
  const repoLabel = repoLabelForContext(target, "");
  const colorSubject = repoLabel ? `${repoLabel} のリポ色` : "リポ色";
  const group = document.createElement("section");
  group.className = "thread-color-settings";

  const title = document.createElement("div");
  title.className = "theme-settings-title";
  title.textContent = colorSubject;
  group.appendChild(title);

  const current = document.createElement("div");
  current.className = "thread-color-current";
  const swatch = document.createElement("span");
  swatch.className = "thread-color-current-swatch";
  swatch.style.backgroundColor = activeColor;
  // "自動 #db2777" ran the mode and the value together as one grey string. The
  // swatch beside it already carries the colour, so the word leads and the hex
  // follows as the value it is - still there, still copyable.
  const label = document.createElement("span");
  label.className = "thread-color-current-label";
  const mode = document.createElement("strong");
  mode.textContent = customColor ? "カスタム" : "自動";
  const hex = document.createElement("code");
  hex.className = "thread-color-current-hex";
  hex.textContent = customColor || activeColor;
  label.append(mode, hex);
  current.append(swatch, label);
  group.appendChild(current);

  const palette = document.createElement("div");
  palette.className = "thread-color-palette";
  for (const color of threadColorPalette) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = sanitizeHexColor(color) === activeColor ? "active" : "";
    button.style.backgroundColor = color;
    button.title = color;
    button.setAttribute("aria-label", `リポ色 ${color}`);
    if (sanitizeHexColor(color) === activeColor) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      setRepoColorOverride(key, color);
      if (!thread || thread.id === selectedThread) applyCurrentThreadAccent();
      showToast(`${colorSubject}を ${color} に変更しました。`);
      if (options.inline) openThreadColorPopover(thread);
      else openThreadColorPanel(thread);
    });
    palette.appendChild(button);
  }
  group.appendChild(palette);

  const customRow = document.createElement("div");
  customRow.className = "thread-color-custom-row";
  const input = document.createElement("input");
  input.type = "color";
  input.value = activeColor;
  input.setAttribute("aria-label", "任意のリポ色");
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.textContent = "適用";
  applyButton.addEventListener("click", () => {
    setRepoColorOverride(key, input.value);
    showToast(`${colorSubject}を ${sanitizeHexColor(input.value)} に変更しました。`);
    if (options.inline) openThreadColorPopover(thread);
    else openThreadColorPanel(thread);
  });
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "secondary";
  resetButton.textContent = "自動色に戻す";
  resetButton.addEventListener("click", () => {
    resetRepoColorOverride(key);
    showToast(`${colorSubject}を自動に戻しました。`);
    if (options.inline) openThreadColorPopover(thread);
    else openThreadColorPanel(thread);
  });
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "secondary";
  copyButton.textContent = "色をコピー";
  copyButton.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(activeColor);
      showToast("色コードをコピーしました。");
    } catch (error) {
      addStatus(`色コードをコピーできませんでした: ${error.message}`);
    }
  });
  customRow.append(input, applyButton, resetButton, copyButton);
  group.appendChild(customRow);

  container.appendChild(group);
}

function openThreadColorPanel(thread = null) {
  clearPanel("リポ色", "workspace");
  artifactList.replaceChildren();
  renderThreadColorSettings(thread);
}

function openThreadColorPopover(thread = null) {
  if (!threadColorPopover) {
    openThreadColorPanel(thread);
    return;
  }
  threadColorPopover.replaceChildren();
  const header = document.createElement("div");
  header.className = "thread-color-popover-header";
  const title = document.createElement("strong");
  title.textContent = "リポ色";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "リポ色を閉じる");
  close.addEventListener("click", closeThreadColorPopover);
  header.append(title, close);
  threadColorPopover.appendChild(header);
  renderThreadColorSettings(thread, { container: threadColorPopover, inline: true });
  threadColorPopover.classList.remove("hidden");
  close.focus({ preventScroll: true });
}

function closeThreadColorPopover() {
  threadColorPopover?.classList.add("hidden");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = apiTimeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      cache: options.cache || "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("通信がタイムアウトしました。接続を確認して再試行します。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function apiGet(path, options = {}) {
  const bridge = bridgeById(options.bridgeId) || activeBridge();
  const response = await fetchWithTimeout(urlWithBridgeToken(path, bridge), {
    headers: authHeadersForBridge(bridge),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

async function apiPost(path, body = {}, options = {}) {
  const bridge = bridgeById(options.bridgeId) || activeBridge();
  const response = await fetchWithTimeout(urlWithBridgeToken(path, bridge), {
    method: "POST",
    headers: authHeadersForBridge(bridge, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  }, options.timeoutMs || apiTimeoutMs);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

// One restart behind two buttons: the one inside settings and the one in the
// drawer footer. The confirm is what makes the second one safe to put within
// reach - restarting drops the connection and stops whatever is running, and a
// button that close to the thumb gets pressed by accident.
async function restartActiveBridge(options = {}) {
  if (!window.confirm("スマホ接続を再起動します。数秒切断され、実行中の処理は止まります。続けますか？")) return false;
  options.onStart?.();
  addStatus("スマホ接続を再起動しています。");
  try {
    await apiPost("/api/restart", {});
  } catch (error) {
    // A bridge started without a supervisor answers with the command that fixes
    // it. That belongs in the log, where it can be read after the toast is gone.
    addStatus(`再起動できませんでした: ${error.message}`);
    options.onError?.(error);
    return false;
  }
  window.setTimeout(() => location.reload(), 1800);
  return true;
}

function setTerminalCommandBusy(busy) {
  terminalCommandRunning = Boolean(busy);
  if (terminalCommandInput) terminalCommandInput.disabled = terminalCommandRunning;
  if (terminalCommandRunButton) {
    terminalCommandRunButton.disabled = terminalCommandRunning;
    terminalCommandRunButton.textContent = terminalCommandRunning ? "実行中" : "実行";
  }
}

function shouldConfirmTerminalCommand(command) {
  return /\b(rm\s+-|sudo\s+|mkfs|diskutil\s+erase|chmod\s+-R|chown\s+-R|git\s+reset\s+--hard|git\s+clean\s+-fd)\b/i.test(command);
}

function terminalCommandDetail(result = {}) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  if (result.truncated) parts.push("[output truncated]");
  return parts.join(parts.length > 1 ? "\n" : "").trim();
}

async function runTerminalCommand(command) {
  const text = String(command || "").trim();
  if (!text || terminalCommandRunning) return;
  if (shouldConfirmTerminalCommand(text) && !window.confirm("破壊的な可能性があるコマンドです。このTerminalで実行しますか？")) return;
  setMainView("terminal");
  appendTerminalEntry({ ts: Date.now(), kind: "command", message: `$ ${text}`, source: "manual" });
  setTerminalCommandBusy(true);
  try {
    const result = await apiPost(
      "/api/terminal/run",
      {
        command: text,
        cwd: currentWorkspace.workspaceLocation || "",
      },
      { timeoutMs: 65_000 },
    );
    const detail = terminalCommandDetail(result);
    appendTerminalEntry({
      ts: Date.now(),
      kind: result.code === 0 ? "command" : "error",
      message: result.code === 0 ? `exit 0${result.durationMs ? ` / ${result.durationMs}ms` : ""}` : `exit ${result.code ?? "?"}`,
      detail: detail || "(no output)",
      source: "manual",
    });
    if (terminalCommandInput) terminalCommandInput.value = "";
  } catch (error) {
    appendTerminalEntry({ ts: Date.now(), kind: "error", message: "Terminal command failed", detail: error.message || String(error), source: "manual" });
  } finally {
    setTerminalCommandBusy(false);
    terminalCommandInput?.focus({ preventScroll: true });
  }
}

function switchThreadProvider(provider, { reload = true } = {}) {
  const nextProvider = normalizeProviderName(provider) || activeProvider;
  if (activeLabInfo() && nextProvider !== "codex") {
    showToast("Windows実験室はCodex用です。Claudeの会話はAirまたはminiから選んでください。");
    return;
  }
  const previousProvider = currentThreadProvider();
  saveDraftForActiveThread();
  if (nextProvider === previousProvider) {
    threadProvider = nextProvider;
    threadProviderExplicit = true;
    setActiveProvider(nextProvider);
    updateUrlThread();
    if (reload) loadThreads({ provider: nextProvider, background: true }).catch(() => {});
    return;
  }
  selectedThreadByProvider.set(previousProvider, selectedThread);
  threadProvider = nextProvider;
  threadProviderExplicit = true;
  setActiveProvider(nextProvider);
  selectedThread = selectedThreadByProvider.get(nextProvider) || "";
  initialUrlThreadPending = false;
  threadCache = [];
  lastHistorySignature = "";
  renderHistory([]);
  updateUrlThread();
  renderThreadList();
  restoreDraftForCurrentThread();
  applyCurrentThreadAccent();
  renderTerminalTranscript();
  closeSocket({ suppressReconnect: true });
  setReady(false);
  meta.textContent = `${providerLabel(nextProvider)} へ接続を切り替え中`;
  connect();

  if (reload) loadThreads({ provider: nextProvider, background: true }).catch(() => {});
  // The other Macs' rows are in the previous provider until they are asked
  // again, and the list would show only this Mac in the meantime.
  loadFleetThreads({ force: true }).catch(() => {});
}

async function loadThreads({ background = false, provider = "" } = {}) {
  // Returning here used to be the whole of it: no fetch, no error, no mark on
  // the screen. The sidebar kept drawing the open chat's stand-in row and read
  // as a Mac with one chat on it, every ten seconds, for as long as the token
  // stayed unresolved. The refresh still stops - it has nothing to ask with -
  // but it now says so where the list is.
  if (!effectiveBridgeToken(activeBridge())) {
    markThreadListBlocked("no-token");
    return;
  }
  const previousThreadCache = threadCache;
  const requestedBridgeId = activeBridgeId;
  const requestId = ++threadListRequestId;
  const isCurrentRequest = () => requestedBridgeId === activeBridgeId && requestId === threadListRequestId;
  const requestedProvider = normalizeProviderName(provider || threadProvider);
  const path = requestedProvider ? `/api/threads?provider=${encodeURIComponent(requestedProvider)}` : "/api/threads";
  try {
    const result = await apiGet(path);
    if (!isCurrentRequest() || (requestedProvider && requestedProvider !== currentThreadProvider())) return;
    if (result.activeProvider) adoptBridgeProvider(result.activeProvider);
    const resultProvider = normalizeProviderName(result.provider || requestedProvider || activeProvider) || currentThreadProvider();
    if (requestedProvider && requestedProvider !== currentThreadProvider()) return;
    if (!threadProviderExplicit) threadProvider = resultProvider;
    let nextThreads = (result.data || []).map((thread) => normalizeThreadRecord(thread, resultProvider));
    if (selectedThread && !nextThreads.some((thread) => sameThreadRecord(thread, { id: selectedThread, provider: resultProvider }))) {
      const current = currentThreadListRecord({
        provider: resultProvider,
        runState: currentRunState,
      });
      if (current) nextThreads = [current, ...nextThreads];
    }
    nextThreads = mergeThreadCacheRecords(nextThreads, previousThreadCache, resultProvider);
    const pendingUrlThread = initialUrlThreadPending
      ? nextThreads.find((thread) => sameThreadRecord(thread, { id: selectedThread, provider: resultProvider }))
      : null;
    const pendingUrlWorkdir = workspaceKeyForThread(pendingUrlThread);
    if (pendingUrlThread && pendingUrlWorkdir) {
      initialUrlThreadPending = false;
      workspaceFollowsSelectedThread = true;
      selectedThread = pendingUrlThread.id;
      selectedThreadByProvider.set(resultProvider, selectedThread);
    }
    threadCache = nextThreads;
    hiddenProjects = Array.isArray(result.hiddenProjects) ? result.hiddenProjects : [];
    const state = getBridgeState(activeBridgeId);
    state.hiddenProjects = hiddenProjects;
    state.threadCache = threadCache;
    // The list is only this bridge's answer once it has actually arrived, which
    // is what the sidebar checks before trusting the rows it is about to draw.
    state.threadsLoadedAt = Date.now();
    state.threadsError = "";
    state.threadsBlocked = "";
    state.activeProvider = activeProvider;
    state.threadProvider = threadProvider;
    state.threadProviderExplicit = threadProviderExplicit;
    updateSelectedThreadHeading();
    if (pendingUrlThread && pendingUrlWorkdir) {
      setWorkspaceMeta({
        repoName: pendingUrlThread.repoName || projectForThread(pendingUrlThread),
        workspaceLocation: pendingUrlWorkdir,
        gitBranch: pendingUrlThread.gitBranch || "",
      });
    }
    renderThreadList();
    applyCurrentThreadAccent();
    showInitialSwipeHint();
    lastThreadListError = "";
  } catch (error) {
    if (!isCurrentRequest() || (requestedProvider && requestedProvider !== currentThreadProvider())) return;
    const message = error.message || String(error);
    // A background poll writes one status line the first time and then goes
    // quiet, which is right for the transcript and wrong for the sidebar: the
    // list is the thing that looks wrong, so the reason belongs there too.
    markThreadListFailed(message);
    if (message !== lastThreadListError) {
      lastThreadListError = message;
      const text = `thread一覧を読めませんでした: ${message}`;
      if (background) addStatus(text);
      else addEntry("error", text);
    }
    if (!background) throw error;
  }
}

function markThreadListBlocked(reason) {
  const state = getBridgeState(activeBridgeId);
  if (state.threadsBlocked === reason) return;
  state.threadsBlocked = reason;
  renderThreadList();
}

function markThreadListFailed(message) {
  const state = getBridgeState(activeBridgeId);
  if (state.threadsError === message && !state.threadsBlocked) return;
  state.threadsError = message;
  state.threadsBlocked = "";
  renderThreadList();
}

// A session belongs to the Mac that ran it: the Air's transcripts are under the
// Air's home, and no amount of asking the mini will produce them. So each
// registered bridge is asked for its own list, and the sidebar shows the union
// instead of whichever machine happens to be connected.
async function loadFleetThreads({ force = false } = {}) {
  const entries = (bridgeRegistry.bridges || []).filter((entry) => entry.id !== activeBridgeId);
  if (!entries.length) return;
  let changed = false;
  await Promise.all(
    entries.map(async (entry) => {
      const state = getBridgeState(entry.id);
      if (state.threadsLoading) return;
      if (!force && state.threadsLoadedAt && Date.now() - state.threadsLoadedAt < 5_000) return;
      if (!effectiveBridgeToken(entry) && !token) return;
      state.threadsLoading = true;
      try {
        // The other Mac is asked for the provider this phone is in, since the
        // list shows one provider across every Mac. Only a bridge that has said
        // it serves that provider is asked for it; one that has not answered
        // yet, or an older one that lists a single provider, is asked for
        // whatever it runs, and a request without a provider is answered by
        // that. The Mac's own remembered provider is not touched by any of it.
        const wanted = currentThreadProvider();
        // On the first pass after launch the other Mac has not described itself
        // yet, and asking it blind returns whatever it runs - the wrong provider
        // half the time, and its rows missing until the next open of the list.
        if (!state.info) await refreshBridgeState(entry.id).catch(() => {});
        const served = (Array.isArray(state.info?.providers) ? state.info.providers : []).map(normalizeProviderName);
        const named = state.info || state.status;
        const provider = served.includes(wanted) ? wanted : named ? normalizeProviderName(state.activeProvider || state.info?.provider) || "" : "";
        const result = await fetchJsonForBridge(entry, provider ? `/api/threads?provider=${encodeURIComponent(provider)}` : "/api/threads");
        const resultProvider = normalizeProviderName(result.provider || result.activeProvider || provider) || "codex";
        state.threadCache = (result.data || []).map((thread) => normalizeThreadRecord(thread, resultProvider));
        state.threadCacheProvider = resultProvider;
        state.hiddenProjects = Array.isArray(result.hiddenProjects) ? result.hiddenProjects : [];
        state.threadsLoadedAt = Date.now();
        state.threadsError = "";
        changed = true;
      } catch (error) {
        // A sleeping Air is the normal case, not a failure worth interrupting
        // the list for. The fleet row already shows it as disconnected.
        state.threadsError = error.message || String(error);
      } finally {
        state.threadsLoading = false;
      }
    }),
  );
  if (changed) renderThreadList();
}

// Every thread the sidebar can show, each carrying the bridge that can open it
// and the Mac it lives on. The active bridge goes first so it wins a duplicate.
function fleetThreadRecords() {
  const entries = bridgeRegistry.bridges || [];
  const ordered = [...entries.filter((entry) => entry.id === activeBridgeId), ...entries.filter((entry) => entry.id !== activeBridgeId)];
  const records = [];
  const seen = new Set();
  // The list follows the provider the phone is in, on every Mac. Once each Mac
  // could be left in its own provider, the Air's Claude chats sat on top of the
  // mini's Codex list and the Codex chats read as missing. The other Mac's
  // chats in the other provider are one switch away, not mixed in.
  const provider = currentThreadProvider();
  for (const entry of ordered) {
    const state = getBridgeState(entry.id);
    const threads = entry.id === activeBridgeId ? threadCache : Array.isArray(state.threadCache) ? state.threadCache : [];
    const machineLabel = shortMachineName(entry, state);
    const machineKey = bridgeMachineKey(entry, state);
    const hidden = new Set(entry.id === activeBridgeId ? hiddenProjects : state.hiddenProjects || []);
    for (const thread of threads) {
      if (!thread?.id) continue;
      // Locally remembered chats must not undo an explicit hide. Keep their
      // history cached; the separate current-chat row remains reachable.
      if (hidden.has(workspaceKeyForThread(thread))) continue;
      if ((normalizeProviderName(thread.provider) || provider) !== provider) continue;
      // Two bridges on one Mac read the same transcripts, so the same session
      // can arrive twice. It is one session either way.
      const key = `${machineKey}:${normalizeProviderName(thread.provider) || ""}:${thread.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ ...thread, bridgeId: entry.id, machineLabel, machineKey });
    }
  }
  return records;
}

function isActiveBridgeThread(thread = {}) {
  return !thread.bridgeId || thread.bridgeId === activeBridgeId;
}

// Old view records could pair an id with the wrong AI. Correct that only after
// the same Mac returns real history for that exact id under the other provider.
// Missing/empty replies are not ownership evidence and never start a new chat.
const threadProviderRecoveries = new Map();
async function recoverSelectedThreadProvider(threadId, provider, bridgeId) {
  if (!threadId || connectionReady) return false;
  const socket = ws;
  const isCurrent = () => activeBridgeId === bridgeId && selectedThread === threadId && currentThreadProvider() === provider && ws === socket && !connectionReady;
  if (!isCurrent()) return false;
  const failure = threadOpenFailureDetails.get(currentThreadColorKey());
  if (failure?.code === "thread_writer_conflict" || failure?.code === "codex_payload_too_large") return false;
  const key = JSON.stringify([bridgeId, provider, threadId]);
  if (threadProviderRecoveries.has(key)) return threadProviderRecoveries.get(key);
  const recovery = (async () => {
    const other = provider === "codex" ? "claude" : "codex";
    let result;
    try {
      result = await apiGet(`/api/thread?${new URLSearchParams({ thread: threadId, provider: other })}`, { bridgeId });
    } catch { return false; }
    if (!isCurrent() || result.provider !== other || result.threadId !== threadId || result.missing
      || !result.history?.some(entry => entry.type === "user" || entry.type === "assistant")) return false;
    const previousDraftKey = currentThreadColorKey();
    await selectThread(threadId, { bridgeId, thread: { id: threadId, provider: other } });
    if (activeBridgeId !== bridgeId || selectedThread !== threadId || currentThreadProvider() !== other) return false;
    migrateThreadScopedState(previousDraftKey, currentThreadColorKey());
    restoreDraftForCurrentThread();
    if (selectedThreadByProvider.get(provider) === threadId) selectedThreadByProvider.delete(provider);
    const state = getBridgeState(bridgeId);
    state.sessionRuns.delete(`${provider}:${threadId}`);
    state.sessionTitles.delete(`${provider}:${threadId}`);
    threadCache = threadCache.filter(thread => thread.id !== threadId || thread.provider !== provider);
    state.threadCache = threadCache;
    sessionActivityRecords = sessionActivityRecords.filter(item => item.bridgeId !== bridgeId || item.provider !== provider || item.threadId !== threadId);
    saveSessionActivity();
    updateUrlThread();
    showToast(`元の会話を確認し、${providerLabel(other)} に接続し直しました。`);
    return true;
  })();
  threadProviderRecoveries.set(key, recovery);
  try { return await recovery; } finally { threadProviderRecoveries.delete(key); }
}

async function refreshSelectedThread() {
  if (!selectedThread || liveTurnActive || selectedThreadRefreshActive) return;
  const provider = currentThreadProvider();
  const bridgeId = activeBridgeId;
  const threadId = selectedThread;
  const isCurrent = () => bridgeId === activeBridgeId && threadId === selectedThread && provider === currentThreadProvider();
  const query = new URLSearchParams({ thread: threadId, provider });
  const workdir = currentRequestWorkdir();
  if (workdir) query.set("workdir", workdir);
  selectedThreadRefreshActive = true;
  try {
    const result = await apiGet(`/api/thread?${query.toString()}`);
    if (!isCurrent() || liveTurnActive || result.threadId !== threadId) return;
    if (result.missing) {
      if (await recoverSelectedThreadProvider(threadId, provider, bridgeId)) return;
      if (!isCurrent()) return;
      showMissingSelectedThread(result.threadId);
      return;
    }
    renderHistoryIfChanged(result.history || []);
    updateSelectedThreadHeading();
    if (!terminalHistories.has(currentThreadColorKey())) {
      replaceTerminalHistory(terminalHistoryFromChatHistory(result.history || []));
    }
    lastThreadRefreshError = "";
  } catch (error) {
    if (!isCurrent()) return;
    if (await recoverSelectedThreadProvider(threadId, provider, bridgeId)) return;
    if (!isCurrent()) return;
    const message = error.message || String(error);
    if (!connectionReady && /thread not loaded:|no rollout found for thread id/i.test(message)) {
      threadOpenFailures.add(currentThreadColorKey());
      setRunState("error", "会話を開けません");
    }
    if (message !== lastThreadRefreshError) {
      lastThreadRefreshError = message;
      addStatus(`チャット更新を読めませんでした: ${message}`);
    }
  } finally {
    selectedThreadRefreshActive = false;
  }
}

function showMissingSelectedThread(threadId) {
  if (threadId && selectedThread !== threadId) return;
  threadOpenFailures.add(currentThreadColorKey());
  const signature = `missing:${activeBridgeId}:${threadId}`;
  if (lastThreadRefreshError !== signature) {
    addStatus("この Mac で元の会話を確認できません。一覧で保存先の Mac と会話を選び直してください。表示中の会話と下書きは保持しています。");
  }
  lastThreadRefreshError = signature;
  closeSocket({ suppressReconnect: true });
  setReady(false);
  setRunState("error", "元の会話を確認できません");
}

async function loadArtifacts({ preserveView = false } = {}) {
  const bridgeId = activeBridgeId;
  if (!effectiveBridgeToken(activeBridge())) return;
  try {
    const result = await apiGet("/api/artifacts", { bridgeId });
    if (bridgeId !== activeBridgeId) return;
    artifactItems = result.data || [];
    getBridgeState(activeBridgeId).artifactItems = artifactItems;
    // A tab-triggered refresh may finish after the owner opens another panel
    // or a file. Update the cached index without replacing that newer view.
    if (preserveView && (activeReviewTab !== "artifacts" || currentPanelTabName() !== "artifacts" || activeArtifactPath)) return;
    renderArtifactIndex(artifactItems);
  } catch (error) {
    if (bridgeId !== activeBridgeId) return;
    addEntry("error", `ファイル一覧を読めませんでした: ${error.message}`);
  }
}

function updateUrlThread() {
  const next = new URL(location.href);
  if (selectedThread && !preserveEntryUrl) next.searchParams.set("thread", selectedThread);
  else next.searchParams.delete("thread");
  if (activeBridgeId && activeBridgeId !== homeBridgeId) next.searchParams.set("bridge", activeBridgeId);
  else next.searchParams.delete("bridge");
  if (threadProviderExplicit) next.searchParams.set("provider", currentThreadProvider());
  else next.searchParams.delete("provider");
  history.replaceState(null, "", next);
  const state = getBridgeState(activeBridgeId);
  state.selectedThread = selectedThread;
  selectedThreadByProvider.set(currentThreadProvider(), selectedThread);
  state.selectedThreads = Object.fromEntries(selectedThreadByProvider);
  state.threadProvider = currentThreadProvider();
  bridgeViewState[activeBridgeId] = { ...(bridgeViewState[activeBridgeId] || {}), selectedThread, provider: currentThreadProvider(), selectedThreads: state.selectedThreads };
  updateActiveBridgeStorage();
}

function syncReadyThread(threadId) {
  if (!threadProviderExplicit) threadProvider = activeProvider;
  if (threadId) {
    initialUrlThreadPending = false;
    selectedThreadByProvider.set(currentThreadProvider(), threadId);
  }
  if (!threadId) {
    updateSelectedThreadHeading();
    return;
  }
  if (selectedThread === threadId) {
    markSelectedThreadViewed({ runState: currentRunState });
    updateSelectedThreadHeading();
    renderThreadList();
    return;
  }
  markSelectedThreadViewed({ runState: currentRunState });
  const previousKey = currentThreadColorKey();
  selectedThread = threadId;
  markSelectedThreadViewed({ runState: currentRunState });
  updateUrlThread();
  updateSelectedThreadHeading();
  const nextKey = currentThreadColorKey();
  migrateThreadScopedState(previousKey, nextKey);
  activeDraftKey = nextKey;
  applyCurrentThreadAccent();
  renderThreadList();
  renderTerminalTranscript();
}

async function selectThread(threadId, options = {}) {
  saveScrollPositions();
  saveDraftForActiveThread();
  markSelectedThreadViewed({ runState: currentRunState });
  threadSwitchBusy = true;
  initialUrlThreadPending = false;
  updateThreadNavigation();
  updateHeaderStatus();
  const workdir = workspaceKeyForThread({ cwd: options.workdir || "" });
  workspaceFollowsSelectedThread = Boolean(workdir || threadId);
  // A session opens on the Mac that holds its transcript. When the row names
  // its own bridge that answer is already settled, so the workdir must not be
  // allowed to send the connection back to a same-named folder on this one.
  const switchedByBridge = await switchToNamedBridge(options.bridgeId);
  useThreadProvider(options.thread?.provider);
  if (workdir && !switchedByBridge && !options.bridgeId) {
    await switchToBridgeForWorkdir(workdir, { reconnect: false, followThreadWorkdir: true });
  }
  if (workdir) {
    setWorkspaceMeta({ repoName: options.project || projectForThread({ cwd: workdir }), workspaceLocation: workdir, gitBranch: "" });
  }
  rememberThreadWorkdir(threadId, workdir || options.thread?.cwd);
  selectedThread = threadId;
  selectedThreadByProvider.set(currentThreadProvider(), selectedThread);
  markThreadViewed(
    {
      ...(options.thread || {}),
      id: threadId,
      provider: currentThreadProvider(),
      cwd: options.workdir || options.thread?.cwd || currentWorkspace.workspaceLocation || "",
      runState: currentRunState,
    },
    currentThreadProvider(),
  );
  updateUrlThread();
  updateSelectedThreadHeading();
  restoreDraftForCurrentThread();
  applyCurrentThreadAccent();
  renderTerminalTranscript();
  renderThreadList();
  setSidebarVisible(false);
  closeThreadSwitcher();
  restoreScrollPositions();
  sessionActivityViewRequest = { bridgeId: activeBridgeId, provider: currentThreadProvider(), threadId: selectedThread };
  connect({ freshThread: options.fresh === true, workdir });
  if (selectedThread) refreshSelectedThread();
  window.setTimeout(() => {
    threadSwitchBusy = false;
    updateThreadNavigation();
    updateHeaderStatus();
  }, 420);
}

// A row carries the provider its chat belongs to, and opening it has to put the
// phone in that provider, whichever one this Mac was last left in. This sets
// the choice without touching the socket: the caller connects for the chat
// itself, and a second connect from here would race it.
function useThreadProvider(provider) {
  const next = normalizeProviderName(provider);
  if (!next || next === currentThreadProvider()) return false;
  selectedThreadByProvider.set(currentThreadProvider(), selectedThread);
  threadProvider = next;
  threadProviderExplicit = true;
  setActiveProvider(next);
  return true;
}

// The sidebar now lists every registered bridge's sessions at once, so a row
// can belong to a Mac this connection is not talking to. Opening it moves the
// connection there first; the thread id means nothing on the other machine.
async function switchToNamedBridge(bridgeId) {
  if (!bridgeId || bridgeId === activeBridgeId || !bridgeById(bridgeId)) return false;
  const state = getBridgeState(bridgeId);
  await setActiveBridge(bridgeId, { silent: true, reconnect: false });
  const provider = normalizeProviderName(state.activeProvider || state.info?.provider);
  if (provider) adoptBridgeProvider(provider, state.info?.providers);
  showToast(`${shortMachineName(bridgeById(bridgeId) || {}, state)} の接続に切り替えました。`);
  return true;
}

async function switchToBridgeForWorkdir(workdir, options = {}) {
  const target = workspaceKeyForThread({ cwd: workdir });
  if (!target) return false;
  const findMatch = () => (bridgeRegistry.bridges || []).find((entry) => {
    const state = getBridgeState(entry.id);
    return (
      workspaceKeyForThread({ cwd: entry.workdir }) === target ||
      workspaceKeyForThread({ cwd: state.info?.cwd || state.info?.workdir || state.status?.workdir }) === target
    );
  });
  let match = findMatch();
  if (!match && options.refresh !== false) {
    await refreshFleet().catch(() => {});
    match = findMatch();
  }
  if (!match || match.id === activeBridgeId) return false;
  await setActiveBridge(match.id, {
    silent: true,
    reconnect: options.reconnect !== false,
    followThreadWorkdir: options.followThreadWorkdir === true,
  });
  addStatus(`threadの作業場所に合わせて接続先を切り替えました: ${projectForThread({ cwd: target })}`);
  return true;
}

async function startNewThread(options = {}) {
  const workdir = String(options.workdir || "").trim();
  // selectThread saves the old draft before changing its folder or Mac. Carry
  // the chosen provider through the switch, even if that Mac defaults to another.
  return selectThread("", { fresh: true, workdir, project: options.project, bridgeId: options.bridgeId || "", thread: { provider: options.provider || currentThreadProvider() } });
}

function invalidateNewSessionFolder() {
  newSessionBrowseSeq += 1;
  newSessionFolder = null;
  createNewSession.disabled = true;
  newSessionUp.disabled = true;
}

function setNewSessionStarting(starting) {
  newSessionStarting = starting;
  for (const control of newSessionDialog.querySelectorAll("select, input, #newSessionHome, #newSessionBrowse")) control.disabled = starting;
  newSessionUp.disabled = starting || !newSessionFolder?.parent;
  createNewSession.disabled = starting || !newSessionFolder || newSessionFolder.readOnly === true;
  const lab = getBridgeState(newSessionMachine.value).info?.capabilities?.lab;
  newSessionProvider.disabled = starting || Boolean(lab);
  if (lab) newSessionProvider.value = "codex";
}

async function browseNewSessionFolder(targetPath = "") {
  if (newSessionStarting) return;
  invalidateNewSessionFolder();
  const seq = newSessionBrowseSeq;
  const bridgeId = newSessionMachine.value;
  const lab = getBridgeState(bridgeId).info?.capabilities?.lab;
  newSessionProvider.disabled = Boolean(lab);
  if (lab) newSessionProvider.value = "codex";
  const entry = bridgeById(bridgeId);
  const machine = entry ? shortMachineName(entry, getBridgeState(bridgeId)) || bridgeDisplayLabel(entry, bridgeId) : "";
  const stillCurrent = () => newSessionDialog.open && seq === newSessionBrowseSeq && newSessionMachine.value === bridgeId;
  newSessionPath.value = targetPath;
  newSessionFolders.replaceChildren();
  newSessionFolders.setAttribute("aria-busy", "true");
  newSessionLocation.textContent = machine;
  newSessionStatus.classList.remove("error");
  newSessionStatus.textContent = "フォルダを読み込み中…";
  try {
    if (!entry || !effectiveBridgeToken(entry)) throw new Error("このパソコンの接続を確認してください。");
    const result = await apiGet(`/api/workspaces/browse${targetPath ? `?path=${encodeURIComponent(targetPath)}` : ""}`, { bridgeId });
    if (!stillCurrent()) return;
    if (!result.path || !Array.isArray(result.entries)) throw new Error("フォルダを取得できませんでした。「ホーム」から選び直してください。");
    newSessionFolder = { ...result, bridgeId };
    newSessionPath.value = result.path;
    newSessionLocation.textContent = `${machine} · ${result.displayPath || result.path}`;
    newSessionUp.disabled = !result.parent;
    createNewSession.disabled = result.readOnly === true;
    for (const entry of result.entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workspace-browser-row";
      const icon = document.createElement("span");
      icon.className = "sidebar-project-folder";
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = entry.name;
      row.append(icon, name);
      row.addEventListener("click", () => browseNewSessionFolder(entry.path));
      newSessionFolders.appendChild(row);
    }
    if (!result.entries.length) {
      const empty = document.createElement("div");
      empty.className = "workspace-browser-empty";
      empty.textContent = result.readOnly ? "保存済みのフォルダ表示です。実験室を起動すると開始できます。" : "この中にフォルダはありません。このフォルダで開始できます。";
      newSessionFolders.appendChild(empty);
    }
    newSessionStatus.textContent = result.readOnly ? `実験室は未接続です。保存済みの表示${result.fetchedAt ? `（${new Date(result.fetchedAt).toLocaleString("ja-JP")}取得）` : ""}のため、起動後に選び直してください。` : "表示中のフォルダで新しいチャットを開きます。";
  } catch (error) {
    if (!stillCurrent()) return;
    newSessionStatus.classList.add("error");
    newSessionStatus.textContent = error.message;
  } finally {
    if (stillCurrent()) newSessionFolders.setAttribute("aria-busy", "false");
  }
}

function showNewSessionPicker() {
  if (newSessionDialog.open) return;
  newSessionMachine.replaceChildren();
  const entries = bridgeRegistry.bridges || [];
  const names = entries.map((entry) => shortMachineName(entry, getBridgeState(entry.id)) || bridgeDisplayLabel(entry, entry.id));
  for (const [index, entry] of entries.entries()) {
    const port = entry.port || getBridgeState(entry.id).info?.uiPort || new URL(entry.baseUrl).port;
    const label = names.filter((name) => name === names[index]).length > 1 ? `${names[index]} :${port}` : names[index];
    newSessionMachine.add(new Option(label, entry.id));
  }
  newSessionMachine.value = activeBridgeId;
  newSessionProvider.value = currentThreadProvider();
  invalidateNewSessionFolder();
  setNewSessionStarting(false);
  newSessionDialog.showModal();
  // Start at this Mac's home, independent of the session list and saved cwd.
  browseNewSessionFolder();
}

async function createSessionFromPicker() {
  const folder = newSessionFolder;
  if (newSessionStarting || !folder || folder.readOnly || folder.bridgeId !== newSessionMachine.value) return;
  const seq = newSessionBrowseSeq;
  const provider = newSessionProvider.value;
  const stillCurrent = () => newSessionDialog.open && seq === newSessionBrowseSeq;
  setNewSessionStarting(true);
  newSessionStatus.classList.remove("error");
  newSessionStatus.textContent = "開始するフォルダを確認中…";
  try {
    if (!bridgeById(folder.bridgeId)) throw new Error("このMacの接続が見つかりません。選び直してください。");
    // Validate again before leaving the current chat; this also remembers the
    // folder without changing the bridge's startup settings or creating files.
    const result = await apiPost("/api/workspaces", { path: folder.path }, { bridgeId: folder.bridgeId });
    if (!stillCurrent()) return;
    if (result.workspace?.path !== folder.path || !bridgeById(folder.bridgeId)) throw new Error("フォルダを確認できませんでした。選び直してください。");
    await startNewThread({ workdir: folder.path, bridgeId: folder.bridgeId, provider });
    newSessionDialog.close();
    closeRightPanel();
    setMainView("chat");
  } catch (error) {
    if (!stillCurrent()) return;
    setNewSessionStarting(false);
    invalidateNewSessionFolder();
    newSessionStatus.classList.add("error");
    newSessionStatus.textContent = error.message;
  } finally {
    if (stillCurrent()) setNewSessionStarting(false);
  }
}

function showRightPanel() {
  document.body.classList.remove("hide-artifacts");
  document.body.classList.add("show-panel");
  setSidebarVisible(false);
}

function closeRightPanel() {
  document.body.classList.add("hide-artifacts");
  document.body.classList.remove("show-panel");
}

function setActivePanelTab(tabName) {
  if (!tabName) return;
  for (const button of panelTabButtons) {
    button.classList.toggle("active", button.dataset.panelTab === tabName);
  }
}

function currentPanelTabName() {
  return Array.from(panelTabButtons).find((button) => button.classList.contains("active"))?.dataset.panelTab || "artifacts";
}

function keepComposerVisible() {
  if (!window.matchMedia("(max-width: 820px)").matches) return;
  setSidebarVisible(false);
  closeRightPanel();
}

function openPromptModal() {
  promptModalInput.value = promptInput.value;
  promptModal.classList.remove("hidden");
  document.body.classList.add("prompt-modal-open");
  requestAnimationFrame(() => promptModalInput.focus());
}

function closePromptModal({ apply = false } = {}) {
  if (apply) promptInput.value = promptModalInput.value;
  promptModal.classList.add("hidden");
  document.body.classList.remove("prompt-modal-open");
  promptInput.focus();
  keepComposerVisible();
}

function clearPanel(title, tabName = "artifacts") {
  showRightPanel();
  setActivePanelTab(tabName);
  setReviewTabsVisible(false);
  artifactTitle.textContent = title;
  artifactList.classList.remove("artifact-browser-list");
  artifactList.replaceChildren();
  activeArtifactPath = "";
  artifactPreview.classList.add("hidden");
  artifactPreview.textContent = "";
}

function addPanelRow(text, detail, onClick, options = {}) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "artifact-row";
  if (options.badge) {
    row.classList.add("has-badge");
    const badge = document.createElement("span");
    badge.className = "artifact-type-badge";
    badge.textContent = options.badge;
    const main = document.createElement("span");
    main.className = "artifact-row-main";
    const strong = document.createElement("strong");
    strong.textContent = text;
    main.appendChild(strong);
    if (detail) {
      const small = document.createElement("small");
      small.textContent = detail;
      main.appendChild(small);
    }
    row.append(badge, main);
  } else if (detail) {
    const strong = document.createElement("strong");
    strong.textContent = text;
    const small = document.createElement("small");
    small.textContent = detail;
    row.append(strong, small);
  } else {
    row.textContent = text;
  }
  if (onClick) row.addEventListener("click", onClick);
  artifactList.appendChild(row);
  return row;
}

function addPanelSectionTitle(text) {
  const heading = document.createElement("div");
  heading.className = "panel-section-heading";
  heading.textContent = text;
  artifactList.appendChild(heading);
  return heading;
}

function renderPanelSection(title, rows, emptyText) {
  addPanelSectionTitle(title);
  if (!rows.length) {
    addPanelRow(emptyText);
    return;
  }
  for (const row of rows) addPanelRow(row.name, row.detail);
}

function setActiveReviewTab(tabName) {
  activeReviewTab = ["summary", "diff", "tests", "terminal", "artifacts", "actions"].includes(tabName) ? tabName : "summary";
  for (const button of reviewTabButtons) {
    const active = button.dataset.reviewTab === activeReviewTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  setReviewTabsVisible(true);
}

// The strip belongs to the review center. It is markup that nothing ever hid, so
// it also sat above 設定, 自動処理 and every other panel, offering Diff and Tests
// for content that has neither.
function setReviewTabsVisible(visible) {
  document.querySelector(".review-tabs")?.classList.toggle("hidden", !visible);
}

function currentThreadTitle() {
  return selectedThreadHeadingText();
}

function nextSuggestedAction() {
  if (pendingApproval) return "承認内容を確認し、許可または拒否してください。";
  if (currentRunState === "error") return "Terminal で失敗箇所を確認し、失敗原因の調査を依頼してください。";
  if (["running", "streaming", "syncing", "interrupting"].includes(currentRunState)) return "実行状況を Timeline と Terminal で監視してください。";
  if (artifactItems.length) return "Artifacts または Diff を確認し、必要なら差分レビューを依頼してください。";
  return "次の指示を composer から送信できます。";
}

function timelineTypeForTerminalEntry(entry = {}) {
  const text = `${entry.message || ""}\n${entry.detail || ""}`;
  if (entry.kind === "approval" || /承認|approval/i.test(text)) return "waiting_approval";
  if (entry.kind === "command" || /^\$\s/.test(entry.message || "")) return /test|check|vitest|jest|pytest/i.test(text) ? "testing" : "running_command";
  if (entry.kind === "file" || /file changes|ファイル|modified|changed/i.test(text)) return "editing";
  if (entry.kind === "error" || /error|failed|失敗|エラー/i.test(text)) return "error";
  if (/履歴同期|sync/i.test(text)) return "syncing_history";
  if (/読|read|file/i.test(text)) return "reading_files";
  return "planning";
}

function buildTimelineItems() {
  const entries = currentTerminalHistory().slice(-24);
  const items = entries.map((entry, index) => {
    const type = timelineTypeForTerminalEntry(entry);
    const labelMap = {
      planning: "Planning",
      reading_files: "Reading files",
      editing: "Editing",
      running_command: "Running command",
      testing: "Testing",
      waiting_approval: "Waiting approval",
      syncing_history: "Syncing history",
      error: "Error",
    };
    return {
      id: entry.id || `timeline-${index}`,
      type,
      label: labelMap[type] || "Planning",
      detail: entry.message || "",
      timestamp: entry.ts || Date.now(),
      status: type === "error" ? "error" : index === entries.length - 1 && ["running", "streaming", "approval", "syncing"].includes(currentRunState) ? "active" : "done",
    };
  });
  if (["done", "interrupted"].includes(currentRunState)) {
    items.push({ id: "timeline-done", type: "done", label: "Done", detail: runStateLabel?.textContent || "完了", timestamp: Date.now(), status: "done" });
  }
  if (!items.length) {
    items.push({ id: "timeline-empty", type: "planning", label: "Planning", detail: "まだ実行ログはありません。", timestamp: Date.now(), status: "pending" });
  }
  return items.slice(-10);
}

function renderTimeline(container) {
  const list = document.createElement("ol");
  list.className = "work-timeline";
  for (const item of buildTimelineItems()) {
    const row = document.createElement("li");
    row.className = `timeline-item ${item.status}`;
    const main = document.createElement("span");
    main.className = "timeline-main";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    main.append(label, detail);
    const time = document.createElement("time");
    time.textContent = formatRelativeTime(item.timestamp) || "now";
    row.append(main, time);
    list.appendChild(row);
  }
  container.appendChild(list);
}

function renderReviewSummary() {
  artifactList.replaceChildren();
  artifactList.classList.remove("artifact-browser-list");
  addPanelRow("Thread", currentThreadTitle(), () => selectedThread && selectThread(selectedThread), { badge: "SUM" });
  addPanelRow("Project", currentWorkspace.repoName || projectForThread(threadCache.find((thread) => thread.id === selectedThread) || {}));
  addPanelRow("Workdir", currentWorkspace.workspaceLocation || "--");
  addPanelRow("Run state", runStateLabel?.textContent || runStateShortLabel());
  addPanelRow("Last event", formatRelativeTime(getBridgeState(activeBridgeId).lastEventAt) || "none");
  addPanelRow("Human action", pendingApproval ? "必要" : "不要");
  addPanelRow("Next", nextSuggestedAction());
  addPanelSectionTitle("Timeline");
  renderTimeline(artifactList);
}

async function renderReviewDiff() {
  artifactList.replaceChildren();
  artifactList.classList.remove("artifact-browser-list");
  addPanelRow("読み込み中...");
  try {
    const result = await apiGet("/api/review/diff");
    artifactList.replaceChildren();
    if (!result.isGitRepo) {
      addPanelRow("Git repository ではありません", result.message || "");
      return;
    }
    addPanelRow("ブランチ", result.branch || "--");
    addPanelRow("git status --short", result.statusShort || "変更なし");
    addPanelRow("git diff --stat", result.diffStat || "差分なし");
    renderPanelSection("変更ファイル", result.files || [], "変更ファイルはありません");
    if (result.truncated) addPanelRow("補足", "出力が長いため一部を省略しました");
    if (result.error) addPanelRow("補足エラー", result.error);
  } catch (error) {
    artifactList.replaceChildren();
    addPanelRow("差分を読めませんでした", error.message);
  }
}

async function renderReviewTests() {
  artifactList.replaceChildren();
  artifactList.classList.remove("artifact-browser-list");
  addPanelRow("読み込み中...");
  try {
    const result = await apiGet(`/api/review/tests?thread=${encodeURIComponent(selectedThread || "")}&provider=${encodeURIComponent(currentThreadProvider())}`);
    artifactList.replaceChildren();
    addPanelRow("最後のコマンド", result.lastCommand || "まだ実行履歴はありません");
    addPanelRow("状態", result.status || "履歴なし");
    if (result.failureSummary) addPanelRow("失敗の要約", result.failureSummary);
    addPanelRow("再実行", "安全のため直接 shell 実行せず、composer に依頼文を入れます", () => {
      insertPromptText("関連するテストを再実行し、失敗した場合は原因と修正案をまとめてください。");
      showToast("テスト再実行の依頼文を入力しました。");
    });
  } catch (error) {
    artifactList.replaceChildren();
    addPanelRow("テストを読めませんでした", error.message);
  }
}

function renderReviewTerminal() {
  artifactList.replaceChildren();
  artifactList.classList.remove("artifact-browser-list");
  const entries = currentTerminalHistory().slice(-40).reverse();
  if (!entries.length) {
    addPanelRow("Terminal log はまだありません");
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("details");
    row.className = "review-log-entry";
    const summary = document.createElement("summary");
    summary.textContent = `${terminalFilterLabel(entry.kind)} / ${terminalTimestampLabel(entry.ts)} / ${entry.message || ""}`.slice(0, 180);
    const pre = document.createElement("pre");
    pre.textContent = entry.detail || entry.message || "";
    row.append(summary, pre);
    artifactList.appendChild(row);
  }
}

function renderReviewActions() {
  artifactList.replaceChildren();
  artifactList.classList.remove("artifact-browser-list");
  // A question cannot be answered from here - there is nothing to pick from -
  // so the row opens the card instead of pretending a blank approval is one.
  const asking = questionsForApproval(pendingApproval || {}).length > 0;
  const actions = [
    { label: asking ? "質問を開く" : "承認", disabled: !pendingApproval, run: () => (asking ? revealPendingApproval() : approveButton?.click()) },
    { label: asking ? "回答せず進める" : "却下", disabled: !pendingApproval, run: () => declineButton?.click(), secondary: true },
    { label: "再試行", run: () => insertPromptText("直前の失敗を踏まえて、原因を確認してから小さく再試行してください。") },
    { label: "停止", disabled: !interruptibleRunStates.has(currentRunState), run: () => interruptButton?.click(), secondary: true },
    { label: "続けて", run: () => insertPromptText("続けてください。") },
    { label: "再取得", run: () => recoverFromPageResume("Review Center refresh") },
    { label: "チャットを開く", disabled: !selectedThread, run: () => selectThread(selectedThread) },
  ];
  const grid = document.createElement("div");
  grid.className = "review-action-grid";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    if (action.secondary) button.className = "secondary";
    button.addEventListener("click", action.run);
    grid.appendChild(button);
  }
  artifactList.appendChild(grid);
}

function showReviewCenter(tabName = activeReviewTab) {
  showRightPanel();
  setActivePanelTab(tabName === "artifacts" ? "artifacts" : "status");
  setActiveReviewTab(tabName);
  artifactTitle.textContent = "レビュー";
  activeArtifactPath = "";
  artifactPreview.className = "artifact-preview hidden";
  artifactPreview.textContent = "";
  if (activeReviewTab === "summary") renderReviewSummary();
  if (activeReviewTab === "diff") renderReviewDiff();
  if (activeReviewTab === "tests") renderReviewTests();
  if (activeReviewTab === "terminal") renderReviewTerminal();
  if (activeReviewTab === "artifacts") {
    renderArtifactIndex(artifactItems);
    loadArtifacts({ preserveView: true });
  }
  if (activeReviewTab === "actions") renderReviewActions();
}

function refreshReviewCenterIfOpen() {
  if (!document.body.classList.contains("show-panel") && document.body.classList.contains("hide-artifacts")) return;
  if (!Array.from(reviewTabButtons).some((button) => button.classList.contains("active"))) return;
  if (["summary", "terminal", "actions"].includes(activeReviewTab)) showReviewCenter(activeReviewTab);
}

function pluginDisplayName(plugin) {
  const summary = plugin?.summary || plugin || {};
  return summary.interface?.displayName || summary.name || summary.id || "追加機能";
}

function pluginStatusKey(plugin) {
  const summary = plugin?.summary || plugin || {};
  if (summary.enabled) return "enabled";
  if (summary.installed) return "installed";
  return String(summary.availability || summary.installPolicy || "available").toLowerCase();
}

function pluginStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "enabled") return "有効";
  if (value === "installed") return "インストール済み";
  if (value === "available") return "利用可";
  return value ? value : "利用可";
}

function skillSourceLabel(source) {
  const value = String(source || "").trim();
  if (value.startsWith("plugin:")) return "追加機能由来";
  if (value === "project") return "プロジェクト";
  if (value === "user") return "ユーザー";
  if (value === "codex") return "Codex";
  return value || "スキル";
}

function collectPluginRows(result) {
  const rows = [];
  const marketplaces = result.marketplaces || result.data || [];
  for (const marketplace of marketplaces) {
    const plugins = marketplace.plugins || marketplace.entries || [];
    for (const plugin of plugins) {
      const summary = plugin?.summary || plugin || {};
      const status = pluginStatusKey(plugin);
      rows.push({
        kind: "plugin",
        name: pluginDisplayName(plugin),
        detail: summary.description || summary.interface?.description || "",
        status,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function collectSkillRows(result) {
  return (result.skills || result.data || [])
    .map((skill) => {
      const source = skillSourceLabel(skill.source);
      return {
        kind: "skill",
        name: skill.name || skill.id || "スキル",
        detail: skill.description || skill.path || "",
        status: source,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeExtensionView(view) {
  return view === "skills" ? "skills" : "plugins";
}

function extensionViewLabel(view) {
  return view === "skills" ? "スキル" : "追加機能";
}

function extensionCountLabel(state) {
  if (!state) return "読み込み中";
  if (state.error) return "エラー";
  if (!state.rows) return "読み込み中";
  return `${state.rows.length}件`;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function extensionSummary(view, state) {
  if (!state) return `${extensionViewLabel(view)}を読み込み中です`;
  if (state.error) return `${extensionViewLabel(view)}を読み込めませんでした`;
  if (!state.rows) return `${extensionViewLabel(view)}を読み込み中です`;
  if (!state.rows.length) return `${extensionViewLabel(view)}は見つかりませんでした`;
  if (view === "plugins") {
    const counts = countBy(state.rows, (row) => pluginStatusLabel(row.status));
    const parts = [`${state.rows.length}件`];
    for (const label of ["有効", "インストール済み", "利用可"]) {
      const count = counts.get(label) || 0;
      if (count) parts.push(`${label} ${count}`);
    }
    return parts.join(" / ");
  }
  const counts = countBy(state.rows, (row) => row.status);
  const sources = Array.from(counts.entries())
    .slice(0, 3)
    .map(([name, count]) => `${name} ${count}`)
    .join(" / ");
  return sources ? `${state.rows.length}件 / ${sources}` : `${state.rows.length}件`;
}

function addExtensionSwitch() {
  const switcher = document.createElement("div");
  switcher.className = "extension-switch";
  switcher.setAttribute("role", "tablist");
  switcher.setAttribute("aria-label", "追加機能とスキルを切り替え");
  for (const view of ["plugins", "skills"]) {
    const state = extensionPanelState?.[view];
    const button = document.createElement("button");
    button.type = "button";
    button.className = view === selectedExtensionView ? "active" : "";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(view === selectedExtensionView));
    button.innerHTML = `<strong>${escapeHtml(extensionViewLabel(view))}</strong><span>${escapeHtml(extensionCountLabel(state))}</span>`;
    button.addEventListener("click", () => {
      selectedExtensionView = view;
      localStorage.setItem("codexPhoneExtensionView", view);
      renderExtensionPanel();
    });
    switcher.appendChild(button);
  }
  artifactList.appendChild(switcher);
}

function addExtensionSummary(view, state) {
  const summary = document.createElement("div");
  summary.className = "extension-summary";
  summary.textContent = extensionSummary(view, state);
  artifactList.appendChild(summary);
}

function addExtensionRow(item) {
  const row = document.createElement("div");
  row.className = "artifact-row has-badge extension-row";

  const badge = document.createElement("span");
  badge.className = `artifact-type-badge ${item.kind === "skill" ? "skill" : "plugin"}`;
  badge.textContent = item.kind === "skill" ? "SKL" : "PLG";

  const main = document.createElement("span");
  main.className = "artifact-row-main";
  const name = document.createElement("strong");
  name.textContent = item.name;
  main.appendChild(name);
  if (item.detail) {
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    main.appendChild(detail);
  }

  const meta = document.createElement("span");
  meta.className = "extension-row-meta";
  meta.textContent = item.kind === "plugin" ? pluginStatusLabel(item.status) : item.status;

  row.append(badge, main, meta);
  artifactList.appendChild(row);
  return row;
}

function renderExtensionPanel() {
  artifactList.replaceChildren();
  artifactList.classList.add("artifact-browser-list");
  const view = normalizeExtensionView(selectedExtensionView);
  selectedExtensionView = view;
  const state = extensionPanelState?.[view] || { rows: null, error: "" };
  addExtensionSwitch();
  addExtensionSummary(view, state);
  if (state.error) {
    addPanelRow("読み込みに失敗しました", state.error);
    return;
  }
  if (!state.rows) {
    addPanelRow("読み込み中...");
    return;
  }
  if (!state.rows.length) {
    addPanelRow(`${extensionViewLabel(view)}は見つかりませんでした`, "利用できる項目があるとここに表示されます");
    return;
  }
  for (const row of state.rows) addExtensionRow(row);
}

function renderArtifactIndex(items) {
  artifactItems = items;
  if (menuButton) {
    menuButton.removeAttribute("data-badge");
    menuButton.title = artifactItems.length ? `メニュー / ファイル ${artifactItems.length} 件` : "メニュー";
    menuButton.setAttribute("aria-label", menuButton.title);
  }
  activeArtifactPath = "";
  setActiveReviewTab("artifacts");
  setActivePanelTab("artifacts");
  artifactTitle.textContent = "ファイル";
  artifactList.classList.add("artifact-browser-list");
  renderArtifactRows();
  hideArtifactPreview();
}

// The row already shows the file name, so the second line carries the folder it
// sits in rather than the whole path. A file at the repo root used to print its
// own name twice; a nested one repeated the name at the end of the path.
function artifactRowFolder(item = {}) {
  const path = String(item.path || "");
  const name = String(item.name || "");
  if (!name || !path.endsWith(name)) return path;
  return path.slice(0, -name.length).replace(/\/+$/, "");
}

// Every row that was not an image or markdown said "FILE", which is what the
// list is made of. The extension is already in the name and tells them apart.
function artifactTypeBadge(item = {}) {
  const extension = String(item.path || item.name || "")
    .split(/[\\/]/)
    .pop()
    .split(".")
    .slice(1)
    .pop();
  if (extension && extension.length <= 4) return extension.toUpperCase();
  if (item.kind === "image") return "IMG";
  if (item.kind === "markdown") return "MD";
  return "FILE";
}

function renderArtifactRows() {
  artifactList.replaceChildren();
  for (const item of artifactItems) {
    const icon = artifactTypeBadge(item);
    const row = addPanelRow(item.name, artifactRowFolder(item), () => showArtifact(item.path), { badge: icon });
    row.classList.toggle("active", item.path === activeArtifactPath);
  }
  if (!artifactItems.length) addPanelRow("ファイルは見つかりませんでした");
}

function hideArtifactPreview() {
  activeArtifactPath = "";
  renderArtifactRows();
  artifactPreview.className = "artifact-preview hidden";
  artifactPreview.textContent = "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function showToolError(name, error) {
  clearPanel(name, currentPanelTabName());
  addPanelRow("読み込みに失敗しました", error.message);
  addEntry("error", `${name}: ${error.message}`);
  setSidebarVisible(false);
}

async function showPlugins() {
  clearPanel("追加機能 / スキル", "extensions");
  extensionPanelState = {
    plugins: { rows: null, error: "" },
    skills: { rows: null, error: "" },
  };
  renderExtensionPanel();
  const [pluginsResult, skillsResult] = await Promise.allSettled([apiGet("/api/plugins"), apiGet("/api/skills")]);

  if (pluginsResult.status === "fulfilled") {
    extensionPanelState.plugins.rows = collectPluginRows(pluginsResult.value);
  } else {
    extensionPanelState.plugins.error = pluginsResult.reason.message;
    addEntry("error", `追加機能: ${pluginsResult.reason.message}`);
  }

  if (skillsResult.status === "fulfilled") {
    extensionPanelState.skills.rows = collectSkillRows(skillsResult.value);
  } else {
    extensionPanelState.skills.error = skillsResult.reason.message;
    addEntry("error", `スキル: ${skillsResult.reason.message}`);
  }
  renderExtensionPanel();
}

async function showAutomations() {
  clearPanel("自動処理", "automation");
  addPanelRow("読み込み中...");
  try {
    const result = await apiGet("/api/automations");
    artifactList.replaceChildren();
    for (const automation of result.data || []) addPanelRow(automation.name, automation.status);
    if (!artifactList.children.length) addPanelRow("登録済み自動処理はありません");
  } catch (error) {
    showToolError("自動処理", error);
  }
}

async function showSettings() {
  const renderSeq = ++settingsRenderSeq;
  clearPanel("設定", "workspace");
  artifactList.replaceChildren();
  renderThemeSettings();
  renderThreadColorSettings();
  const loadingRow = addPanelRow("読み込み中...");
  try {
    const provider = currentThreadProvider();
    const [configResult, localResult] = await Promise.allSettled([
      apiGet(`/api/config?provider=${encodeURIComponent(provider)}`),
      apiGet("/api/local-settings"),
    ]);
    if (renderSeq !== settingsRenderSeq) return;
    loadingRow.remove();
    if (localResult.status === "fulfilled") renderLocalSettings(localResult.value);
    else addPanelRow("起動設定を読めませんでした", localResult.reason.message);

    if (configResult.status === "rejected") throw configResult.reason;
    const result = configResult.value;
    const config = result.config?.config || {};
    addPanelRow("認証", result.auth?.authMethod || "unknown");
    addPanelRow("既定モデル", config.model || selectedModel || "unknown");
    addPanelRow("許可範囲", accessMode.label);
    addPanelRow("作業場所", localResult.value?.active?.workdir || "");
    if (result.errors?.length) addPanelRow("補足エラー", result.errors.join(" / "));
  } catch (error) {
    if (renderSeq !== settingsRenderSeq) return;
    loadingRow.remove();
    addPanelRow("読み込みに失敗しました", error.message);
    addEntry("error", `設定: ${error.message}`);
  }
}

// Settings belong to one bridge, and a bridge belongs to one Mac, so the way to
// set up the Air from here is to move this screen to the Air's connection. The
// row makes that a tap and says which machine is being edited right now.
function machinePickerRow(currentMachineName = "") {
  const row = document.createElement("div");
  row.className = "settings-machine-row";
  const label = document.createElement("span");
  label.className = "settings-machine-label";
  label.textContent = "設定するMac";
  row.appendChild(label);

  const entries = bridgeRegistry.bridges || [];
  if (entries.length <= 1) {
    const only = document.createElement("span");
    only.className = "settings-machine-current";
    only.textContent = currentMachineName || "この接続先だけ";
    row.appendChild(only);
    return row;
  }

  const names = entries.map((entry) => shortMachineName(entry, getBridgeState(entry.id)) || bridgeDisplayLabel(entry, entry.id));
  for (const [index, entry] of entries.entries()) {
    const machine = names[index];
    // Two bridges on one Mac would otherwise show as two identical chips.
    const duplicated = names.filter((name) => name === machine).length > 1;
    const port = entry.port || getBridgeState(entry.id).info?.uiPort || "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = entry.id === activeBridgeId ? "settings-machine-chip active" : "settings-machine-chip";
    button.textContent = duplicated && port ? `${machine} :${port}` : machine;
    applyMachineAccent(button, machine, bridgeMachineKey(entry));
    button.title = `${machine} / ${bridgeDisplayLabel(entry, entry.id)} / ${entry.baseUrl}`;
    button.setAttribute("aria-pressed", String(entry.id === activeBridgeId));
    button.disabled = entry.id === activeBridgeId;
    button.addEventListener("click", async () => {
      await setActiveBridge(entry.id);
      showSettings();
    });
    row.appendChild(button);
  }
  return row;
}

function renderLocalSettings(payload) {
  const group = document.createElement("section");
  group.className = "local-settings";

  const active = payload.active || {};
  const settings = payload.settings || {};
  const options = payload.options || {};
  const modelsByProvider = options.modelsByProvider || { [active.provider || "codex"]: options.models || [] };
  const defaultModels = options.defaultModels || {};
  let workspaceItems = options.workspaces || [];

  // Everything under this heading belongs to one Mac: the one this connection
  // is talking to. `/Users/minijiro/WORK_LOCAL/…` and `/Users/yujiro/WORK_LOCAL/…`
  // are different machines wearing nearly the same path, so the machine is named
  // once at the top and again on the folder controls below.
  const activeEntry = activeBridge() || {};
  const activeState = getBridgeState(activeBridgeId);
  const machineName = shortMachineName(activeEntry, activeState);
  const machineHost = String(activeState.info?.hostName || "");
  let browsingMachine = machineName;

  const title = document.createElement("div");
  title.className = "theme-settings-title";
  title.textContent = machineName ? `起動設定 — ${machineName}` : "起動設定";
  group.appendChild(title);

  const modelLabel = document.createElement("div");
  modelLabel.className = "local-settings-current";
  modelLabel.innerHTML = `
    <span>${escapeHtml(machineName || "現在")}</span>
    <strong>${escapeHtml(`${active.provider || "codex"} / ${active.model || "unknown"}`)}</strong>
    <code>${escapeHtml(shortenPath(active.workdir || ""))}</code>
  `;
  if (machineHost) modelLabel.title = machineHost;
  group.appendChild(modelLabel);
  group.appendChild(machinePickerRow(machineName));

  const modelSelect = document.createElement("select");
  modelSelect.className = "settings-select";

  function modelChoicesForProvider(provider) {
    return modelsByProvider[provider] || options.models || [];
  }

  function preferredModelForProvider(provider) {
    if (settings.provider === provider && settings.model) return settings.model;
    if (active.provider === provider && active.model) return active.model;
    return defaultModels[provider] || modelChoicesForProvider(provider)[0] || selectedModel || "";
  }

  function renderModelSelectForProvider(provider, selectedValue = preferredModelForProvider(provider)) {
    const modelValues = new Set([selectedValue, defaultModels[provider], ...(modelChoicesForProvider(provider) || [])].filter(Boolean));
    modelSelect.replaceChildren();
    for (const modelValue of modelValues) {
      const option = document.createElement("option");
      option.value = modelValue;
      option.textContent = modelValue;
      modelSelect.appendChild(option);
    }
    modelSelect.value = selectedValue || modelSelect.options[0]?.value || "";
  }

  const providerSelect = document.createElement("select");
  providerSelect.className = "settings-select";
  const providerValues = new Set([settings.provider, active.provider, ...(options.providers || ["codex", "claude"])].filter(Boolean));
  for (const providerValue of providerValues) {
    const option = document.createElement("option");
    option.value = providerValue;
    option.textContent = providerValue;
    providerSelect.appendChild(option);
  }
  providerSelect.value = currentThreadProvider() || settings.provider || active.provider || "codex";
  renderModelSelectForProvider(providerSelect.value);

  const workspaceSelect = document.createElement("select");
  workspaceSelect.className = "settings-select";
  renderWorkspaceOptions(workspaceSelect, workspaceItems, settings.workdir || active.workdir || "", machineName);

  const manualInput = document.createElement("input");
  manualInput.className = "settings-input";
  manualInput.type = "text";
  manualInput.inputMode = "text";
  manualInput.autocomplete = "off";
  manualInput.placeholder = "/Users/minijiro/WORK_LOCAL/...";

  const addWorkspaceButton = document.createElement("button");
  addWorkspaceButton.type = "button";
  addWorkspaceButton.className = "settings-inline-button";
  addWorkspaceButton.textContent = "追加";

  const manualRow = document.createElement("div");
  manualRow.className = "settings-inline-row";
  manualRow.append(manualInput, addWorkspaceButton);

  // Typing an absolute path on a phone keyboard is the worst way to pick a
  // folder, so the same choice is reachable by walking the tree instead.
  const browser = document.createElement("div");
  browser.className = "workspace-browser";
  const browserPath = document.createElement("div");
  browserPath.className = "workspace-browser-path";
  const browserList = document.createElement("div");
  browserList.className = "workspace-browser-list";
  const browserBar = document.createElement("div");
  browserBar.className = "settings-inline-row";
  const browserUp = document.createElement("button");
  browserUp.type = "button";
  browserUp.className = "settings-inline-button";
  browserUp.textContent = "↑ 上の階層";
  const browserPick = document.createElement("button");
  browserPick.type = "button";
  browserPick.className = "settings-inline-button";
  browserPick.textContent = "ここを選ぶ";
  const browserPin = document.createElement("button");
  browserPin.type = "button";
  browserPin.className = "settings-inline-button";
  browserBar.append(browserUp, browserPick, browserPin);
  browser.append(browserPath, browserBar, browserList);

  let browserCurrent = null;

  function setBookmarkButton(pinned) {
    browserPin.textContent = pinned ? "★ 解除" : "☆ ブックマーク";
  }

  async function openBrowserAt(targetPath) {
    browserList.textContent = "読み込み中...";
    try {
      const result = await apiGet(`/api/workspaces/browse${targetPath ? `?path=${encodeURIComponent(targetPath)}` : ""}`);
      browserCurrent = result;
      // The listing says whose home it came from, so a path that reads the same
      // on both Macs still cannot be mistaken for the other one's.
      browsingMachine = uiUtils.machineLabelForBridge ? uiUtils.machineLabelForBridge(result) || machineName : machineName;
      browserPath.replaceChildren();
      if (browsingMachine) {
        const machineChip = document.createElement("span");
        machineChip.className = "workspace-browser-machine";
        machineChip.textContent = browsingMachine;
        applyMachineAccent(machineChip, browsingMachine);
        browserPath.appendChild(machineChip);
      }
      const pathText = document.createElement("span");
      pathText.className = "workspace-browser-path-text";
      pathText.textContent = result.displayPath || result.path;
      browserPath.appendChild(pathText);
      browserPath.title = `${browsingMachine ? `${browsingMachine}: ` : ""}${result.path || ""}`;
      if (result.home) manualInput.placeholder = `${result.home}/...`;
      browserUp.disabled = !result.parent;
      setBookmarkButton(result.pinned);
      browserList.textContent = "";
      if (!result.entries.length) {
        const empty = document.createElement("div");
        empty.className = "workspace-browser-empty";
        empty.textContent = "このフォルダの下にフォルダはありません。";
        browserList.appendChild(empty);
        return;
      }
      for (const entry of result.entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "workspace-browser-row";
        row.textContent = `${entry.isRepo ? "◆ " : ""}${entry.pinned ? "★ " : ""}${entry.name}`;
        row.addEventListener("click", () => openBrowserAt(entry.path));
        browserList.appendChild(row);
      }
    } catch (error) {
      browserList.textContent = "";
      setSettingsStatus(status, error.message, "error");
    }
  }

  browserUp.addEventListener("click", () => {
    if (browserCurrent?.parent) openBrowserAt(browserCurrent.parent);
  });

  browserPick.addEventListener("click", async () => {
    if (!browserCurrent) return;
    try {
      const result = await apiPost("/api/workspaces", { path: browserCurrent.path });
      workspaceItems = result.options || workspaceItems;
      renderWorkspaceOptions(workspaceSelect, workspaceItems, browserCurrent.path, browsingMachine);
      setSettingsStatus(status, `${browsingMachine ? `${browsingMachine} の` : ""}作業場所に選びました。保存すると次回起動でも使われます。`);
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
    }
  });

  browserPin.addEventListener("click", async () => {
    if (!browserCurrent) return;
    try {
      const result = await apiPost("/api/workspaces/bookmark", { path: browserCurrent.path, pinned: !browserCurrent.pinned });
      browserCurrent.pinned = result.pinned;
      setBookmarkButton(result.pinned);
      workspaceItems = result.options || workspaceItems;
      renderWorkspaceOptions(workspaceSelect, workspaceItems, workspaceSelect.value, browsingMachine);
      setSettingsStatus(status, result.pinned ? "ブックマークしました。" : "ブックマークを解除しました。");
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
    }
  });

  openBrowserAt(settings.workdir || active.workdir || "");

  const historyLabel = document.createElement("label");
  historyLabel.className = "settings-check";
  const historyInput = document.createElement("input");
  historyInput.type = "checkbox";
  historyInput.checked = settings.historySyncEnabled !== false;
  historyLabel.append(historyInput, document.createTextNode("履歴同期"));

  function updateProviderDependentControls() {
    const nextProvider = providerSelect.value || "codex";
    renderModelSelectForProvider(nextProvider);
    historyInput.disabled = nextProvider !== "codex";
    historyLabel.classList.toggle("disabled", historyInput.disabled);
  }

  const status = document.createElement("div");
  status.className = payload.restartRequired ? "settings-status warning" : "settings-status";
  status.textContent = payload.restartRequired ? "保存済み設定があります。再起動で反映します。" : "起動中の設定と一致しています。";
  // Which build this page is: the one thing that tells a phone that never
  // reloaded apart from one that did.
  const shellStamp = document.createElement("div");
  shellStamp.className = "settings-status";
  shellStamp.textContent = `画面の版: ${ownShellVersion() || "不明"}`;

  const form = document.createElement("form");
  form.className = "settings-form";
  form.append(
    settingField("使用AI", providerSelect),
    settingField("モデル", modelSelect),
    settingField(machineName ? `作業場所（${machineName}）` : "作業場所", workspaceSelect),
    settingGroup(machineName ? `${machineName} のフォルダをたどって選ぶ` : "フォルダをたどって選ぶ", browser),
    settingGroup(machineName ? `${machineName} のパスを直接入力` : "パスを直接入力", manualRow),
    historyLabel,
    status,
    shellStamp,
  );

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "保存";
  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "secondary";
  restartButton.textContent = "再起動";
  actions.append(saveButton, restartButton);
  form.appendChild(actions);

  providerSelect.addEventListener("change", () => {
    const nextProvider = providerSelect.value || "codex";
    updateProviderDependentControls();
    switchThreadProvider(nextProvider);
    setSettingsStatus(status, "使用AIを切り替えました。保存するとこのポートの既定になります。");
  });
  updateProviderDependentControls();

  addWorkspaceButton.addEventListener("click", async () => {
    const nextPath = manualInput.value.trim();
    if (!nextPath) {
      setSettingsStatus(status, "追加したいフォルダの絶対パスを入力してください。", "error");
      manualInput.focus();
      return;
    }
    addWorkspaceButton.disabled = true;
    setSettingsStatus(status, "フォルダを確認中...");
    try {
      const result = await apiPost("/api/workspaces", { path: nextPath });
      workspaceItems = result.options || workspaceItems;
      renderWorkspaceOptions(workspaceSelect, workspaceItems, result.workspace?.path || nextPath, browsingMachine);
      manualInput.value = "";
      setSettingsStatus(status, "候補に追加しました。保存すると次回起動の作業場所になります。");
      addStatus("作業場所候補を追加しました。");
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
    } finally {
      addWorkspaceButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    setSettingsStatus(status, "保存中...");
    try {
      const result = await apiPost("/api/local-settings", {
        provider: providerSelect.value,
        model: modelSelect.value,
        workdir: workspaceSelect.value,
        historySyncEnabled: historyInput.checked,
      });
      setSelectedModel(modelSelect.value, { provider: providerSelect.value });
      workspaceItems = result.options?.workspaces || workspaceItems;
      renderWorkspaceOptions(workspaceSelect, workspaceItems, result.settings?.workdir || workspaceSelect.value, browsingMachine);
      switchThreadProvider(providerSelect.value);
      setSettingsStatus(status, result.restartRequired ? "保存しました。作業場所やモデルは再起動で既定に反映します。" : "保存しました。", result.restartRequired ? "warning" : "");
      addStatus("起動設定を保存しました。");
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  restartButton.addEventListener("click", async () => {
    restartButton.disabled = true;
    const restarting = await restartActiveBridge({
      onStart: () => setSettingsStatus(status, "再起動中..."),
      onError: (error) => setSettingsStatus(status, error.message, "error"),
    });
    if (!restarting) restartButton.disabled = false;
  });

  group.appendChild(form);
  artifactList.appendChild(group);
}

// `machine` names the Mac these folders are on. A dropdown listing
// `codex-remote-control-lab` twice, once per machine, is a dropdown you pick the
// wrong one from; the optgroup heading is where that gets settled.
function renderWorkspaceOptions(select, items, selectedValue, machine = "") {
  const selectedPath = selectedValue || "";
  const prefix = machine ? `${machine} / ` : "";
  const groups = new Map();
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    const groupName = `${prefix}${item.group || "フォルダ"}`;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  }
  if (selectedPath && !seen.has(selectedPath)) {
    groups.set(`${prefix}選択中`, [{ path: selectedPath, label: shortenPath(selectedPath), group: "選択中" }]);
  }

  select.replaceChildren();
  for (const [groupName, groupItems] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;
    for (const item of groupItems) {
      const option = document.createElement("option");
      option.value = item.path;
      const displayName = item.name || item.label || shortenPath(item.path);
      option.textContent = item.git ? `${displayName} · Git` : displayName;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  select.value = selectedPath;
}

function setSettingsStatus(element, text, tone = "") {
  element.className = tone ? `settings-status ${tone}` : "settings-status";
  element.textContent = text;
}

function settingField(labelText, control) {
  const label = document.createElement("label");
  label.className = "settings-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

// A <label> forwards clicks anywhere inside it to its first labelable control,
// so a field holding several buttons fires the wrong one. Group those with a
// plain div instead.
function settingGroup(labelText, control) {
  const group = document.createElement("div");
  group.className = "settings-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  group.append(span, control);
  return group;
}

function shortenPath(value) {
  return String(value || "").replace(/^\/Users\/[^/]+/, "~");
}

function renderThemeSettings() {
  const group = document.createElement("section");
  group.className = "theme-settings";

  const title = document.createElement("div");
  title.className = "theme-settings-title";
  title.textContent = "カラーテーマ";
  group.appendChild(title);

  const options = document.createElement("div");
  options.className = "theme-options";
  for (const theme of themeOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = selectedTheme === theme.id ? "theme-option active" : "theme-option";
    button.dataset.themeChoice = theme.id;
    button.innerHTML = `
      <span class="theme-swatch" aria-hidden="true"><span></span><span></span><span></span></span>
      <strong>${escapeHtml(theme.name)}</strong>
      <small>${escapeHtml(theme.detail)}</small>
    `;
    button.addEventListener("click", () => {
      applyTheme(theme.id);
      addStatus(`テーマを ${theme.name} に切り替えました。`);
      showSettings();
    });
    options.appendChild(button);
  }
  group.appendChild(options);
  artifactList.appendChild(group);
}

async function showModels() {
  clearPanel("モデル", "models");
  addPanelRow("読み込み中...");
  try {
    const result = await apiGet(`/api/models?provider=${encodeURIComponent(currentThreadProvider())}`);
    artifactList.replaceChildren();
    const models = result.data || [];
    for (const candidate of models.slice(0, 24)) {
      addPanelRow(candidate.displayName || candidate.model || candidate.id, candidate.defaultReasoningEffort || "", () => {
        setSelectedModel(candidate.model || candidate.id);
        addStatus(`モデルを ${selectedModel} に設定しました。次の送信から反映します。`);
      });
    }
    if (!models.length) addPanelRow("モデル一覧を取得できませんでした");
  } catch (error) {
    showToolError("モデル", error);
  }
}

function startVoiceInput() {
  voiceButton.dataset.voiceState = "requested";
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceButton.dataset.voiceState = "unsupported";
    addStatus("このブラウザでは音声入力に未対応です。");
    promptInput.focus();
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = document.documentElement.lang || "ja-JP";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  voiceButton.classList.add("listening");
  addStatus("音声入力を開始しました。ブラウザのマイク許可を確認してください。");
  recognition.addEventListener("result", (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    if (!transcript) return;
    promptInput.value = `${promptInput.value}${promptInput.value ? "\n" : ""}${transcript}`;
    promptInput.focus();
    addStatus("音声入力をテキストへ追加しました。");
  });
  recognition.addEventListener("error", (event) => addStatus(`音声入力に失敗しました: ${event.error || "unknown"}`));
  recognition.addEventListener("end", () => voiceButton.classList.remove("listening"));
  recognition.start();
}

// The server reports these as machine states. Translating them here keeps the
// panel in one language without the server having to know what it is read in.
const healthStateLabels = new Map([
  ["alive", "正常"],
  ["degraded", "不安定"],
  ["error", "異常"],
  ["connected", "接続済み"],
  ["disconnected", "未接続"],
  ["local-process", "ローカル実行"],
]);

function healthStateLabel(value) {
  const key = String(value || "").trim();
  if (!key) return "不明";
  return healthStateLabels.get(key) || key;
}

async function showStatus() {
  clearPanel("接続状態", "status");
  try {
    const [statusResult, healthResult] = await Promise.all([
      apiGet(`/api/status?provider=${encodeURIComponent(currentThreadProvider())}`),
      apiGet(`/api/health?provider=${encodeURIComponent(currentThreadProvider())}`),
    ]);
    const result = statusResult;
    const health = healthResult || result.health || {};
    // No badge: "HLT" was an abbreviation of "health" on the one row in a panel
    // titled 接続状態, where every row is a health reading.
    addPanelRow("bridge", healthStateLabel(health.bridge));
    addPanelRow("アプリサーバー", healthStateLabel(health.appServer));
    addPanelRow("WebSocket", healthStateLabel(health.websocket));
    addPanelRow("接続中の端末", `${health.activeClients ?? 0}台`);
    addPanelRow("履歴同期", `${health.historySync?.enabled ? "有効" : "無効"} / 最終成功 ${health.historySync?.lastSuccessAt || "なし"} / 最終失敗 ${health.historySync?.lastFailureAt || "なし"}`);
    addPanelRow("接続キー", health.token?.present ? `${health.token.masked} / ${health.token.ageMs === null ? "経過時間は不明" : `${Math.round(health.token.ageMs / 60000)}分前`}` : "なし");
    addPanelRow("通知", `${health.notification?.eventsEnabled ? "通知あり" : "通知なし"} / ${(health.notification?.providers || []).join(", ") || "宛先なし"}`);
    addPanelRow("ホスト名", health.hostName || "--");
    addPanelRow("LANのURL", (health.lanUrls || [])[0] || "--");
    addPanelRow("最後のイベント", health.lastEventAt || "--");
    addPanelRow("再取得", "接続状態を取り直します", showStatus);
    addPanelRow("画面ポート", String(result.uiPort));
    addPanelRow("使用AI", result.provider || "codex");
    if (result.defaultProvider && result.defaultProvider !== result.provider) addPanelRow("既定の使用AI", result.defaultProvider);
    if (result.codexUrl) addPanelRow("Mac側の接続先", result.codexUrl);
    latestRateLimits = result.rateLimits || null;
    renderRateLimitCard(latestRateLimits);
    addRateLimitPanelRows(latestRateLimits);
    addPanelRow("作業場所", result.workdir);
    addPanelRow("リポジトリ", result.repoName || "--");
    addPanelRow("現在地", result.workspaceLocation || "--");
    addPanelRow("作業ブランチ", result.gitBranch || "--");
    setWorkspaceMeta(result);
    for (const bridge of result.bridges || []) {
      addPanelRow(bridge.threadId || "チャット準備中", `${bridge.clients}端末 / ${bridge.ready ? "準備完了" : "開始中"}`);
    }
  } catch (error) {
    showToolError("接続状態", error);
  }
}

async function showArtifact(path) {
  const bridgeId = activeBridgeId;
  showRightPanel();
  setActivePanelTab("artifacts");
  artifactTitle.textContent = "ファイル";
  artifactList.classList.add("artifact-browser-list");
  activeArtifactPath = path;
  renderArtifactRows();
  artifactPreview.className = "artifact-preview";
  artifactPreview.innerHTML = `
    <div class="artifact-preview-header">
      <div class="artifact-preview-title">${escapeHtml(path)}</div>
      <button type="button" class="artifact-preview-close" data-preview-close>閉じる</button>
    </div>
    <p>読み込み中...</p>
  `;
  try {
    const result = await apiGet(`/api/file?path=${encodeURIComponent(path)}`, { bridgeId });
    if (activeBridgeId !== bridgeId || activeArtifactPath !== path) return;
    setArtifactPreview(result);
    artifactPreview.classList.remove("hidden");
  } catch (error) {
    if (activeBridgeId !== bridgeId || activeArtifactPath !== path) return;
    artifactPreview.innerHTML = `
      <div class="artifact-preview-header">
        <div class="artifact-preview-title">${escapeHtml(path)}</div>
        <button type="button" class="artifact-preview-close" data-preview-close>閉じる</button>
      </div>
      <p>読み込みに失敗しました: ${escapeHtml(error.message)}</p>
    `;
    addEntry("error", `ファイル: ${error.message}`);
  }
}

function setArtifactPreview(result) {
  const isImage = result.kind === "image";
  const isMarkdown = result.kind === "markdown" || /\.md(?:own)?$/i.test(result.path);
  artifactPreview.classList.toggle("image-artifact-preview", isImage);
  artifactPreview.classList.toggle("markdown-preview", isMarkdown);
  artifactPreview.classList.toggle("plain-preview", !isMarkdown && !isImage);
  const header = `
    <div class="artifact-preview-header">
      <div class="artifact-preview-title">${escapeHtml(result.path)}</div>
      <button type="button" class="artifact-preview-close" data-preview-close>閉じる</button>
    </div>
  `;
  if (isImage) {
    artifactPreview.innerHTML = header;
    const gallery = renderImageGallery([{ name: result.path, url: result.imageUrl }]);
    artifactPreview.appendChild(gallery);
    return;
  }
  const freshness = result.lab ? `<p class="lab-file-freshness">${result.stale ? "保存済みの表示・現在の内容は未確認" : "実験室から取得"}${result.fetchedAt ? `（${escapeHtml(new Date(result.fetchedAt).toLocaleString("ja-JP"))}）` : ""}</p>` : "";
  artifactPreview.innerHTML = `${header}${freshness}${
    isMarkdown ? renderMarkdown(result.text, { allowHtml: !result.lab, headingOffset: 0 }) : `<pre><code>${escapeHtml(result.text)}</code></pre>`
  }`;
}

function renderAttachments() {
  attachments.replaceChildren();
  attachments.classList.toggle("has-attachments", pendingFiles.length > 0);
  attachments.dataset.count = String(pendingFiles.length);
  if (pendingFiles.length) {
    const summary = document.createElement("span");
    summary.className = "attachment-summary";
    summary.textContent = `添付 ${pendingFiles.length}件`;
    attachments.appendChild(summary);
  }
  for (const file of pendingFiles) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attachment-chip";
    const mimeType = file.mimeType || file.type || "";
    const isImage = file.kind === "image" || mimeType.startsWith("image/");
    const thumb = isImage ? document.createElement("img") : document.createElement("span");
    if (isImage) {
      thumb.src = file.dataUrl || urlWithToken(file.url);
      thumb.alt = "";
    } else {
      thumb.className = "attachment-file-icon";
      thumb.textContent = file.kind === "audio" || mimeType.startsWith("audio/") ? "音" : "FILE";
    }
    const label = document.createElement("span");
    label.textContent = file.size ? `${file.name} (${formatBytes(file.size)})` : file.name;
    const close = document.createElement("span");
    close.className = "attachment-remove";
    close.textContent = "×";
    close.setAttribute("aria-hidden", "true");
    chip.append(thumb, label, close);
    chip.title = `${file.name} を削除`;
    chip.setAttribute("aria-label", `${file.name} を削除`);
    chip.addEventListener("click", () => {
      pendingFiles = pendingFiles.filter((candidate) => candidate !== file);
      renderAttachments();
      saveDraftForActiveThread();
    });
    attachments.appendChild(chip);
  }
}

const defaultQuickActions = [
  { id: "continue", label: "続けて", text: "続けてください。" },
  { id: "summary", label: "要約", text: "ここまでの状況を短く要約してください。" },
  { id: "test", label: "テスト", text: "関連するテストを実行し、失敗時は原因と修正案を示してください。" },
  { id: "diff", label: "差分", text: "現在の差分を要点だけ見せてください。" },
  { id: "push", label: "プッシュ", text: "現在のブランチを push してください。push 前に必要な確認を行い、未コミット変更や未通過チェックがあれば先に報告してください。" },
  { id: "merge", label: "マージ", text: "現在の作業ブランチを適切な統合先へマージしてください。マージ前後に必要な確認を行い、競合や未通過チェックがあれば報告してください。" },
  { id: "commit", label: "コミット", text: "現在の差分を確認し、関連する変更だけを小さくまとめてコミットしてください。コミット前に必要なチェックも実行してください。" },
  { id: "add", label: "追加", text: "現在の差分を確認し、コミット対象に含めるべきファイルを git add してください。含めない方がよい変更があれば先に報告してください。" },
];

const taskTemplatePrompts = [
  {
    id: "bug",
    label: "バグ調査",
    text: "バグ調査をお願いします。\n\n現象:\n- \n\n再現手順:\n1. \n2. \n\n期待動作:\n- \n\n調査してほしい範囲:\n- ",
  },
  {
    id: "review",
    label: "差分レビュー",
    text: "現在の変更点をレビューし、問題点・リスク・改善案を優先度順に挙げてください。必要なら該当ファイルと確認コマンドも示してください。",
  },
  {
    id: "test",
    label: "テスト実行",
    text: "関連する test / check を実行してください。失敗した場合は、原因の切り分け、修正案、再実行結果までまとめてください。",
  },
  {
    id: "readme",
    label: "README更新",
    text: "今回の変更内容を README.md / README.ja.md / docs の必要箇所へ反映してください。public-safe な説明に留め、token やローカル秘密情報は書かないでください。",
  },
  {
    id: "screenshot",
    label: "スクショ確認",
    text: "UI screenshot / artifact を確認し、崩れ、重なり、読みにくい箇所、スマホで押しにくい箇所を指摘して修正してください。",
  },
  {
    id: "pr",
    label: "PR用まとめ作成",
    text: "PR 用に summary / changes / tests / risks / follow-ups を簡潔にまとめてください。security 上の注意があれば含めてください。",
  },
];

function renderQuickActions() {
  if (!quickActions) return;
  const usage = quickActionState.usage && typeof quickActionState.usage === "object" ? quickActionState.usage : {};
  const sorted = [...defaultQuickActions].sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0));
  quickActions.replaceChildren();
  for (const action of sorted) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "quick-action-chip";
    chip.textContent = action.label;
    chip.addEventListener("click", () => {
      insertPromptText(action.text);
      quickActionState = { ...quickActionState, usage: { ...usage, [action.id]: (usage[action.id] || 0) + 1 } };
      try {
        localStorage.setItem(quickActionsStorageKey, JSON.stringify(quickActionState));
      } catch {
        // Non-critical ordering preference.
      }
      renderQuickActions();
      showToast(`${action.label}を入力しました。`);
    });
    quickActions.appendChild(chip);
  }
}

function insertPromptText(text) {
  const value = String(text || "");
  const start = promptInput.selectionStart ?? promptInput.value.length;
  const end = promptInput.selectionEnd ?? promptInput.value.length;
  promptInput.value = `${promptInput.value.slice(0, start)}${value}${promptInput.value.slice(end)}`;
  const nextPosition = start + value.length;
  promptInput.focus();
  promptInput.setSelectionRange(nextPosition, nextPosition);
  autoGrowPrompt();
  saveDraftForActiveThread();
}

function appendPromptText(text) {
  const value = String(text || "").trim();
  if (!value) return;
  const prefix = promptInput.value.trim() ? "\n\n" : "";
  promptInput.value = `${promptInput.value}${prefix}${value}`;
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  autoGrowPrompt();
  saveDraftForActiveThread();
}

function renderTaskTemplates() {
  if (!taskTemplates) return;
  taskTemplates.replaceChildren();
  for (const template of taskTemplatePrompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = localStorage.getItem(taskTemplateStorageKey) === template.id ? "task-template active" : "task-template";
    button.textContent = template.label;
    button.addEventListener("click", () => {
      appendPromptText(template.text);
      safeWriteStorage(localStorage, taskTemplateStorageKey, template.id);
      renderTaskTemplates();
      showToast(`${template.label}を入力しました。`);
    });
    taskTemplates.appendChild(button);
  }
}

// Fourteen chips stood above the input in two rows. These six are the long ones
// - they paste a multi-line scaffold rather than a sentence - and they are not
// what you reach for on every turn, so they fold away behind their own button
// and the row above stays the one-tap row it was meant to be.
const taskTemplatesOpenStorageKey = "codexPhoneTaskTemplatesOpen:v1";

function setTaskTemplatesOpen(open, { persist = true } = {}) {
  if (!taskTemplates || !taskTemplatesToggle) return;
  taskTemplates.classList.toggle("hidden", !open);
  taskTemplatesToggle.classList.toggle("active", open);
  taskTemplatesToggle.setAttribute("aria-expanded", String(open));
  if (persist) safeWriteStorage(localStorage, taskTemplatesOpenStorageKey, open ? "1" : "0");
}

function initTaskTemplatesToggle() {
  if (!taskTemplatesToggle) return;
  setTaskTemplatesOpen(localStorage.getItem(taskTemplatesOpenStorageKey) === "1", { persist: false });
  taskTemplatesToggle.addEventListener("click", () => {
    setTaskTemplatesOpen(taskTemplates.classList.contains("hidden"));
  });
}

function autoGrowPrompt() {
  if (!promptInput) return;
  promptInput.style.height = "auto";
  const next = Math.min(Math.max(promptInput.scrollHeight, 72), isMobileViewport() ? 180 : 240);
  promptInput.style.height = `${next}px`;
  setupVisualViewportVars();
}

function setTerminalInputMode(mode, { silent = false } = {}) {
  terminalInputMode = mode === "keys" ? "keys" : "text";
  safeWriteStorage(localStorage, terminalInputModeStorageKey, terminalInputMode);
  terminalTextModeButton?.classList.toggle("active", terminalInputMode === "text");
  terminalKeysModeButton?.classList.toggle("active", terminalInputMode === "keys");
  terminalTextModeButton?.setAttribute("aria-pressed", String(terminalInputMode === "text"));
  terminalKeysModeButton?.setAttribute("aria-pressed", String(terminalInputMode === "keys"));
  updateTerminalInputModeButton();
  updateQuickBarVisibility();
  if (silent) return;
  appendTerminalEntry({ ts: Date.now(), kind: "lifecycle", message: `ログ入力モード: ${terminalInputMode === "keys" ? "キー操作" : "文章"}` });
}

function showTerminalHelper(text) {
  if (!terminalHelper) return;
  terminalHelper.textContent = text;
  terminalHelper.classList.remove("hidden");
  window.setTimeout(() => terminalHelper.classList.add("hidden"), 2600);
}

function handleTerminalKey(key) {
  if (key === "folder") {
    showTerminalHelper("フォルダ: 添付またはファイル参照のためにファイル選択を開きます。");
    fileInput.click();
    return;
  }
  if ((uiUtils.shouldConfirmDangerousKey && uiUtils.shouldConfirmDangerousKey(key)) || key === "Ctrl+C") {
    if (!interruptibleRunStates.has(currentRunState)) {
      showTerminalHelper("Ctrl+C: 中断できる実行中タスクはありません。");
      return;
    }
    if (!window.confirm("実行中の処理へ中断要求を送ります。続けますか？")) return;
    interruptButton.click();
    appendTerminalEntry({ ts: Date.now(), kind: "lifecycle", message: "中断キーを確認しました: Ctrl+C" });
    return;
  }
  if (key === "Ctrl+L") {
    terminalHistories.set(currentThreadColorKey(), []);
    renderTerminalTranscript();
    showToast("表示中の実行ログをクリアしました。");
    appendTerminalEntry({ ts: Date.now(), kind: "lifecycle", message: "この端末の実行ログ表示を消しました" });
    return;
  }
  if (key === "Backspace") {
    const start = promptInput.selectionStart ?? promptInput.value.length;
    const end = promptInput.selectionEnd ?? promptInput.value.length;
    if (start !== end) promptInput.value = `${promptInput.value.slice(0, start)}${promptInput.value.slice(end)}`;
    else if (start > 0) promptInput.value = `${promptInput.value.slice(0, start - 1)}${promptInput.value.slice(start)}`;
    const next = Math.max(0, start - 1);
    promptInput.focus();
    promptInput.setSelectionRange(next, next);
    saveDraftForActiveThread();
    return;
  }
  const text = uiUtils.keyIntentText ? uiUtils.keyIntentText(key) : key;
  if (key === "$") showTerminalHelper("$ は直接実行ではなく、Codex への安全な実行依頼テンプレートを挿入します。");
  if (key === "/") showTerminalHelper("/ から操作コマンドや作業指示を書き始められます。");
  if (terminalInputMode === "keys" && text.startsWith("[") && text.endsWith("]")) {
    insertPromptText(`操作画面で ${text} キー相当の操作をしてください。`);
  } else {
    insertPromptText(text);
  }
  appendTerminalEntry({ ts: Date.now(), kind: "user", message: `キー操作: ${key}` });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function closeSocket({ suppressReconnect = true } = {}) {
  if (!ws) return;
  const socket = ws;
  if (suppressReconnect) suppressedSocketReconnects.add(socket);
  try {
    socket.close();
  } catch {
    // Best effort: a stale Safari socket may already be gone.
  }
  ws = null;
}

function canReconnect() {
  return Boolean(token && document.visibilityState !== "hidden");
}

// A Home Screen app has storage of its own, so an icon added from a URL without
// the key starts with nothing to connect with - and the old wording sent the
// owner to the Mac to restart a bridge that was running perfectly. On the pages
// an icon is made from, say what actually went wrong and what fixes it.
function tokenMissingMessage() {
  if (preserveEntryUrl) {
    return "接続キーがありません。ホーム画面に追加する URL には接続キーが必要です。Safari で接続キー付きの URL を一度開いてから、このページを開き直して追加してください。下の欄に接続キーを入力しても構いません。";
  }
  return "token がありません。PC 側で `npm run phone` を再実行し、新しい URL を開いてください。";
}

function renderTokenRecoveryForm(container) {
  if (!container) return;
  const form = document.createElement("form");
  form.className = "token-recovery-form";
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "接続キーを入力";
  input.setAttribute("aria-label", "接続キー");
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "保存して接続";
  const hint = document.createElement("small");
  hint.textContent = "token はこの端末に保存し、URL には残しません。";
  form.append(input, button, hint);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextToken = input.value.trim();
    if (!nextToken) return;
    token = nextToken;
    storedToken = nextToken;
    try {
      localStorage.setItem(tokenStorageKey, nextToken);
      localStorage.removeItem("codexPhoneToken");
    } catch {
      // Storage may be unavailable; keep the token for the current page session.
    }
    rememberTokenForCurrentOrigin(nextToken);
    const active = activeBridge();
    if (active?.id) {
      const updated = setBridgeToken(active, nextToken, true);
      bridgeRegistry = { ...bridgeRegistry, bridges: (bridgeRegistry.bridges || []).map((entry) => (entry.id === active.id ? updated : entry)) };
      persistBridgeRegistry();
    } else {
      ensureHomeBridge();
    }
    meta.textContent = "接続キーを保存しました";
    // The first restore attempt fails without a token, and this is the moment
    // one exists - so a reinstalled app recovers its machines here rather than
    // waiting for the owner to change something else.
    restoreBridgeRegistryFromHome();
    connect({ preserveHistory: true });
  });
  container.appendChild(form);
}

function renderTokenMissingState() {
  setReady(false);
  setRunState("error", "接続キーなし");
  meta.textContent = "接続キーがありません";
  if (!lastDisplayedErrorSignature.includes("missing-token")) {
    const body = addEntry("error", tokenMissingMessage());
    renderTokenRecoveryForm(body);
    lastDisplayedErrorSignature = "missing-token";
    lastDisplayedErrorAt = Date.now();
  }
}

function renderInvalidTokenState() {
  setReady(false);
  setRunState("error", "接続キーエラー");
  meta.textContent = "接続キーが無効です";
  if (!lastDisplayedErrorSignature.includes("invalid-token")) {
    const body = addEntry("error", "保存済みの接続キーが現在のbridgeと一致しません。PC側の起動URLから接続キーを入れ直してください。");
    renderTokenRecoveryForm(body);
    lastDisplayedErrorSignature = "invalid-token";
    lastDisplayedErrorAt = Date.now();
  }
}

function scheduleReconnect(reason = "reconnect", delay = 900) {
  if (!canReconnect() || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!canReconnect()) return;
    addStatus(`接続を復旧します: ${reason}`);
    connect({ preserveHistory: true });
  }, delay);
}

function scheduleReconnectAfterAuthCheck(reason, bridge, bridgeToken) {
  if (!bridgeToken) {
    renderTokenMissingState();
    return;
  }
  fetchWithTimeout(
    urlWithBridgeToken("/api/session", bridge),
    { headers: authHeadersForBridge(bridge, {}, bridgeToken) },
    2500,
  )
    .then((response) => {
      if (response.status === 401) {
        renderInvalidTokenState();
        return;
      }
      scheduleReconnect(reason);
    })
    .catch(() => scheduleReconnect(reason));
}

function recoverFromPageResume(reason = "resume") {
  if (!token || document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastResumeRefreshAt < resumeRefreshDebounceMs) return;
  lastResumeRefreshAt = now;
  selectedThreadRefreshActive = false;
  refreshFleet().catch(() => {});
  // `pageshow` also fires for the first page load. Resolve the bridge provider
  // before that refresh so a Claude-only bridge never receives the default
  // Codex thread request during startup.
  const resumeThreadLoad = uiUtils.loadThreadsAfterProviderSync
    ? uiUtils.loadThreadsAfterProviderSync(syncProviderFromBridge, loadThreads, { background: true })
    : syncProviderFromBridge().then(() => loadThreads({ background: true }));
  resumeThreadLoad.catch(() => {});
  if (selectedThread) refreshSelectedThread();
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    scheduleReconnect(reason, 120);
    return;
  }
  if (ws.readyState === WebSocket.OPEN && (liveTurnActive || (lastWsMessageAt && now - lastWsMessageAt > staleSocketMs))) {
    addStatus(liveTurnActive ? "Safari復帰後の実行状態を再同期します。" : "Safari復帰後の接続が古いため再接続します。");
    closeSocket({ suppressReconnect: true });
    scheduleReconnect(reason, 120);
  }
}

async function uploadFile(file) {
  const response = await fetchWithTimeout(
    urlWithToken("/api/upload"),
    {
      method: "POST",
      headers: authHeadersForBridge(activeBridge(), {
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name || "upload"),
        "x-file-size": String(file.size || 0),
      }),
      body: file,
    },
    uploadTimeoutMs,
  );
  const result = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return {
    ...result.attachment,
    type: result.attachment?.mimeType || file.type || "application/octet-stream",
    size: result.attachment?.size || file.size || 0,
  };
}

function connect({ preserveHistory = false, freshThread = false, workdir = "" } = {}) {
  const bridge = activeBridge();
  const bridgeToken = effectiveBridgeToken(bridge);
  const bridgeId = activeBridgeId;
  token = bridgeToken;
  if (!bridgeToken) {
    renderTokenMissingState();
    return;
  }
  const provider = currentThreadProvider();
  const connectionState = getBridgeState(bridgeId);
  connectionState.pendingNewSessions ||= {};
  if (selectedThread) delete connectionState.pendingNewSessions[provider];
  else if (freshThread) {
    connectionState.pendingNewSessions[provider] = { id: clientMessageId(), workdir: connectionWorkdir(workdir) };
  }
  const pendingNewSession = connectionState.pendingNewSessions[provider];
  closeSocket({ suppressReconnect: true });
  setReady(false);
  liveTurnActive = false;
  liveOutputGroup = "";
  setRunState("connecting");
  if (!preserveHistory) {
    lastHistorySignature = "";
    renderHistory([]);
  }
  updateSelectedThreadHeading();
  let targetWorkdir = pendingNewSession?.workdir || connectionWorkdir(workdir);
  if (!workdir && selectedThread && targetWorkdir) {
    const selectedWorkdir = selectedThreadWorkdir();
    if (selectedWorkdir && selectedWorkdir !== targetWorkdir) {
      targetWorkdir = selectedWorkdir;
      workspaceFollowsSelectedThread = true;
    }
  }
  if (targetWorkdir && !workdir) {
    setWorkspaceMeta({ repoName: projectForThread({ cwd: targetWorkdir }), workspaceLocation: targetWorkdir, gitBranch: "" });
  }
  ws = new WebSocket(
    wsUrlForBridge(bridge, provider, selectedThread, {
      fresh: Boolean(pendingNewSession) && !selectedThread,
      newSessionId: pendingNewSession?.id,
      workdir: targetWorkdir,
      serviceTier: provider === "codex" ? selectedServiceTier || "standard" : undefined,
    }),
    wsProtocolsForBridge(bridge),
  );
  const socket = ws;
  const isCurrentSocket = () => bridgeId === activeBridgeId && ws === socket;
  connectButton.disabled = true;
  meta.textContent = "接続中";

  socket.addEventListener("open", () => {
    if (!isCurrentSocket()) return;
    const state = getBridgeState(bridgeId);
    state.connected = true;
    state.lastError = "";
    lastWsMessageAt = Date.now();
    setRunState("connecting", "接続中");
    addEntry("status", "Mac側に接続しました。");
  });

  socket.addEventListener("message", (event) => {
    if (!isCurrentSocket()) return;
    lastWsMessageAt = Date.now();
    const msg = JSON.parse(event.data);
    if (msg.lab) {
      const state = getBridgeState(bridgeId);
      state.status = { ...state.status, lab: msg.lab };
      renderLabControls();
    }
    if (msg.type === "labState" || msg.type === "pong") return;
    // The bridge tags session events as well as owning the socket. Keep a
    // tagged event from a different chat out of the current page.
    if (msg.type !== "ready" && msg.threadId && msg.threadId !== selectedThread) return;
    if (msg.type === "slashCommands") {
      setSlashCommands(msg.slashCommands);
      return;
    }
    if (msg.type === "ready") {
      if (msg.threadId) delete connectionState.pendingNewSessions[provider];
      setReady(true);
      setActiveProvider(msg.provider || "codex");
      // After the provider, because an empty list explains itself differently
      // depending on which agent is behind the chat. A bridge with no commands
      // to offer says so by sending none, and an older one by sending nothing
      // at all: either way the list belongs to the chat this phone just left.
      setSlashCommands(Array.isArray(msg.slashCommands) ? msg.slashCommands : []);
      setSelectedModel(msg.model, { persist: false, provider: msg.provider || currentThreadProvider() });
      // Only reach into `run` for a message that does not name the session's
      // folder at all. Filling single fields from it mixes two folders into one
      // reading: an empty branch for a folder that is not a repo would be filled
      // with the branch of the repo the bridge process happens to sit in.
      const readySpeaksForSession = Boolean(msg.workdir || msg.cwd);
      const readyWorkspace = workspaceMetaFromRun(
        readySpeaksForSession
          ? { repoName: msg.repoName, workspaceLocation: msg.workspaceLocation, gitBranch: msg.gitBranch, workdir: msg.workdir, cwd: msg.cwd }
          : {
              repoName: msg.repoName || msg.run?.repoName,
              workspaceLocation: msg.workspaceLocation || msg.run?.workspaceLocation,
              gitBranch: msg.gitBranch || msg.run?.gitBranch,
              workdir: msg.run?.workdir,
              cwd: msg.run?.cwd,
            },
      );
      setWorkspaceMeta(readyWorkspace);
      const state = getBridgeState(bridgeId);
      const readyViewedAt = Date.now();
      upsertThreadRecord(
        msg.thread
          ? { ...msg.thread, lastViewedAt: readyViewedAt }
          : {
              id: msg.threadId,
              name: msg.threadTitle || "",
              displayTitle: msg.threadTitle || "",
              preview: msg.threadTitle || "",
              provider: msg.provider || activeProvider,
              cwd: msg.workdir,
              updatedAt: 0,
              lastViewedAt: readyViewedAt,
            },
        msg.provider || activeProvider,
      );
      // The id a fresh chat is given arrives here, so this is the first moment
      // the folder it was opened in can be filed under one.
      rememberThreadWorkdir(msg.threadId, readyWorkspace.workspaceLocation || msg.workdir);
      state.selectedThread = msg.threadId || selectedThread;
      state.currentWorkspace = { ...currentWorkspace };
      state.activeProvider = msg.provider || activeProvider;
      state.threadProvider = currentThreadProvider();
      state.runState = msg.run?.state || state.runState || "ready";
      state.lastEventAt = Date.now();
      syncReadyThread(msg.threadId);
      applyServerRunState(msg.run || { state: "ready" });
      renderHistoryIfChanged(msg.history || []);
      if (sessionActivityViewRequest?.bridgeId === bridgeId && sessionActivityViewRequest.provider === currentThreadProvider() && sessionActivityViewRequest.threadId === selectedThread) {
        if (document.visibilityState === "visible" && mainViewMode === "chat") acknowledgeCurrentSessionActivity();
        sessionActivityViewRequest = null;
      }
      handleTerminalMessage(msg);
      // The workspace strip directly below already names the folder, and it does
      // it with the home directory collapsed. Repeating the absolute path here
      // only pushed the line under the pills to its right.
      meta.textContent = `${msg.model}  •  ${msg.clients}端末`;
      applyCurrentThreadAccent();
      updateThreadNavigation();
      addEntry("status", `チャットを開きました: ${msg.threadId}`);
      return;
    }
    handleTerminalMessage(msg);
    if (msg.type === "runState") {
      // A run state that names no folder of its own says nothing about where
      // this chat is: its repo name and branch are the bridge process's, so
      // taking them renames the chat to the bridge's repo on every state
      // change. Only the folder already established stands.
      const runNamesFolder = Boolean(msg.workdir || msg.cwd);
      const runLocation = runNamesFolder ? "" : selectedThreadWorkdir("") || currentWorkspaceWorkdir();
      setWorkspaceMeta(runNamesFolder ? workspaceMetaFromRun(msg) : runLocation ? { workspaceLocation: runLocation } : {});
      applyServerRunState(msg);
      updateThreadNavigation();
      return;
    }
    if (msg.type === "rateLimits") {
      latestRateLimits = msg.rateLimits || null;
      renderRateLimitCard(latestRateLimits);
      return;
    }
    if (msg.type === "user") {
      acceptPendingSubmission(msg.clientMessageId);
      liveTurnActive = true;
      assistantEntry = null;
      liveOutputGroup = `live-${Date.now()}`;
      setRunState("running");
      updateThreadNavigation();
      addEntry("user", msg.text, msg.attachments || []);
      return;
    }
    if (msg.type === "promptAccepted") {
      acceptPendingSubmission(msg.clientMessageId);
      return;
    }
    if (msg.type === "assistantDelta") {
      setRunState("streaming");
      if (mainViewMode !== "chat") {
        unreadChatCount += 1;
        updateUnreadBadges();
      }
      const stickToBottom = isChatNearBottom();
      if (!assistantEntry) {
        assistantEntry = addEntry("assistant", "", [], {
          outputGroup: liveOutputGroup || `live-${Date.now()}`,
          showBulkCopy: true,
        });
      }
      setEntryText(assistantEntry, "assistant", `${assistantEntry.markdownSource || ""}${msg.text}`);
      settleChatScroll(stickToBottom);
      return;
    }
    if (msg.type === "approval") {
      pendingApproval = msg.request;
      getBridgeState(bridgeId).pendingApproval = msg.request;
      setRunState("approval");
      updateThreadNavigation();
      renderApprovalRequest(msg.request);
      showToast("承認リクエストがあります。", "approval");
      return;
    }
    if (msg.type === "turn" && msg.status === "started") {
      if (msg.turnId && !assistantEntry) liveOutputGroup = msg.turnId;
      applyServerRunState(msg.run || { state: "running", label: "処理中", turnId: msg.turnId });
      updateThreadNavigation();
      return;
    }
    if (msg.type === "turn" && msg.status === "completed") {
      lastHistorySignature = "";
      assistantEntry = null;
      liveOutputGroup = "";
      getBridgeState(bridgeId).pendingApproval = null;
      applyServerRunState(msg.run || { state: "done", label: "完了しました", turnId: msg.turnId });
      preserveSelectedThreadInList({
        runState: msg.run?.state || "done",
      });
      updateThreadNavigation();
      loadThreads({ background: true });
      window.setTimeout(() => loadThreads({ background: true }).catch(() => {}), 1200);
      refreshSelectedThread();
      return;
    }
    if (msg.type === "historyChanged") {
      // The session grew somewhere else — the desktop app, or a terminal. Drop
      // the signature so the redraw is not skipped as "same as last time".
      lastHistorySignature = "";
      refreshSelectedThread();
      loadThreads({ background: true }).catch(() => {});
      return;
    }
    if (msg.type === "error") {
      if (!connectionReady && selectedThread) {
        threadOpenFailures.add(currentThreadColorKey());
        if (msg.code) threadOpenFailureDetails.set(currentThreadColorKey(), { code: msg.code, text: msg.text });
      }
      if (msg.retryable === false) {
        suppressedSocketReconnects.add(socket);
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        setReady(false);
        // Drop the held new-session request too. Suppressing this socket alone
        // stopped the immediate loop, but the request id stayed on the bridge
        // state, so the next resume dialled fresh with it and failed again.
        if (connectionState.pendingNewSessions) delete connectionState.pendingNewSessions[provider];
      }
      releasePendingSubmission("送信に失敗しました。");
      showBridgeError(msg.text || "エラー");
      if (!connectionReady && selectedThread) {
        if (msg.code === "thread_writer_conflict" || msg.code === "codex_payload_too_large") {
          // These are known Codex failures, never evidence of another AI's
          // ownership. Read saved history without resuming or sending input.
          refreshSelectedThread().catch(() => {});
        } else recoverSelectedThreadProvider(selectedThread, provider, bridgeId).catch(() => {});
      }
      updateThreadNavigation();
      return;
    }
    if (msg.type === "status") {
      if (/履歴同期を更新しました/.test(msg.text || "")) setRunState("done", "完了・履歴同期済み");
      else if (/履歴同期に失敗/.test(msg.text || "")) setRunState("error", "履歴同期に失敗");
      else if (/履歴同期/.test(msg.text || "")) setRunState("syncing", msg.text);
      addEntry("status", msg.text);
    }
  });

  socket.addEventListener("close", () => {
    if (!isCurrentSocket()) {
      suppressedSocketReconnects.delete(socket);
      return;
    }
    const state = getBridgeState(bridgeId);
    state.connected = false;
    state.runState = "disconnected";
    state.lastEventAt = Date.now();
    renderFleet();
    if (bridgeId !== activeBridgeId) return;
    setReady(false);
    interruptRequestPending = false;
    updateInterruptButton();
    connectButton.disabled = false;
    const shouldSuppressReconnect = suppressedSocketReconnects.has(socket);
    suppressedSocketReconnects.delete(socket);
    if (ws === socket) ws = null;
    releasePendingSubmission("接続が切れたため送信できませんでした。");
    meta.textContent = "切断";
    setRunState("disconnected");
    if (!shouldSuppressReconnect) scheduleReconnectAfterAuthCheck("WebSocket切断", bridge, bridgeToken);
  });

  socket.addEventListener("error", () => {
    if (!isCurrentSocket()) {
      suppressedSocketReconnects.delete(socket);
      return;
    }
    const state = getBridgeState(bridgeId);
    state.connected = false;
    state.runState = "error";
    state.lastError = "WebSocket error";
    state.lastEventAt = Date.now();
    renderFleet();
    if (bridgeId !== activeBridgeId) return;
    interruptRequestPending = false;
    updateInterruptButton();
    setRunState("disconnected", "接続エラー");
    releasePendingSubmission("接続エラーで送信できませんでした。");
    if (!suppressedSocketReconnects.has(socket)) scheduleReconnectAfterAuthCheck("WebSocketエラー", bridge, bridgeToken);
  });
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const inputValue = promptInput.value;
  const text = inputValue.trim();
  if (!text && !pendingFiles.length) return;
  const lab = activeLabInfo();
  if (lab && !(getBridgeState(activeBridgeId).status?.lab || lab.lab)?.aiReady) {
    addStatus("AI作業の承認・実機検証が未完了のため送信しません。入力は残しています。");
    return;
  }
  if (pendingSubmission) {
    addStatus("前回の送信確認中です。入力は残しています。");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addStatus("未接続のため送信できません。入力は残しています。");
    scheduleReconnect("送信前の再接続", 120);
    return;
  }
  const attachmentsToSend = pendingFiles.map((file) => ({ ...file }));
  const submission = {
    id: clientMessageId(),
    inputValue,
    fileSignature: fileDraftSignature(),
    files: attachmentsToSend,
  };
  setPendingSubmission(submission);
  setRunState("running", "送信確認中");
  try {
    appendTerminalEntry({
      ts: Date.now(),
      kind: "status",
      message: `入力を送信しました${attachmentsToSend.length ? `（添付 ${attachmentsToSend.length}件）` : ""}`,
    });
    ws.send(
      JSON.stringify({
        type: "prompt",
        clientMessageId: submission.id,
        text: text || "添付ファイルを確認してください。",
        attachments: attachmentsToSend,
        operationContext: operationContextForSubmission(),
        options: {
          model: activeLabInfo()?.model || selectedModel || undefined,
          serviceTier: activeLabInfo() ? "standard" : currentThreadProvider() === "codex" ? selectedServiceTier || null : undefined,
          effort: effortForSubmission(),
          approvalPolicy: activeLabInfo() ? "never" : accessMode.approvalPolicy,
          sandboxMode: activeLabInfo() ? "workspace-write" : accessMode.sandboxMode,
        },
      }),
    );
  } catch (error) {
    releasePendingSubmission("送信できませんでした。");
    addEntry("error", `送信に失敗しました: ${error.message}`);
  }
});

interruptButton.addEventListener("click", () => {
  if (!interruptibleRunStates.has(currentRunState) || interruptRequestPending) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addStatus("未接続のため中断要求を送信できません。");
    scheduleReconnect("中断前の再接続", 120);
    return;
  }
  interruptRequestPending = true;
  pendingApproval = null;
  approval.classList.add("hidden");
  renderApprovalStrip(null);
  setRunState("interrupting", "中断要求を送信中");
  try {
    ws.send(JSON.stringify({ type: "interrupt" }));
  } catch (error) {
    interruptRequestPending = false;
    updateInterruptButton();
    addEntry("error", `中断要求の送信に失敗しました: ${error.message}`);
  }
});

approveButton.addEventListener("click", () => {
  if (!pendingApproval) return;
  const questions = questionsForApproval(pendingApproval);
  const answers = questions.length ? collectQuestionAnswers(questions) : null;
  if (questions.length && Object.keys(answers).length < questions.length) {
    showToast("未回答の質問があります。", "warn");
    return;
  }
  ws.send(JSON.stringify({ type: "approval", decision: "accept", request: pendingApproval, answers: answers || undefined }));
  appendTerminalEntry({ ts: Date.now(), kind: "approval", message: questions.length ? `回答を送信しました (${questions.length}件)` : "承認しました" });
  showToast(questions.length ? "回答を送信しました。" : "承認を送信しました。");
  approval.classList.add("hidden");
  pendingApproval = null;
  questionAnswerDraft = new Map();
  renderApprovalStrip(null);
  setRunState("running", questions.length ? "回答済み・処理中" : "承認済み・処理中");
});

declineButton.addEventListener("click", () => {
  if (!pendingApproval) return;
  const asking = questionsForApproval(pendingApproval).length > 0;
  const reason = approvalReason?.value?.trim();
  ws.send(JSON.stringify({ type: "approval", decision: "decline", request: pendingApproval }));
  appendTerminalEntry({
    ts: Date.now(),
    kind: "approval",
    message: asking ? "回答せず進めます" : reason ? `拒否しました: ${reason}` : "拒否しました",
  });
  showToast(asking ? "回答なしで進めます。" : "拒否を送信しました。");
  approval.classList.add("hidden");
  pendingApproval = null;
  questionAnswerDraft = new Map();
  renderApprovalStrip(null);
  setRunState("running", asking ? "回答なしで処理中" : "拒否済み・処理中");
});

prevThreadButton.addEventListener("click", () => selectAdjacentThread(-1));
nextThreadButton.addEventListener("click", () => selectAdjacentThread(1));
searchButton.addEventListener("click", () => {
  const open = threadSearch.classList.toggle("hidden") === false;
  searchButton.setAttribute("aria-expanded", open ? "true" : "false");
  threadSearch.focus();
  renderThreadList();
  setSidebarVisible(true);
});
newSessionButton.addEventListener("click", showNewSessionPicker);
newSessionMachine.addEventListener("change", () => browseNewSessionFolder());
document.querySelector("#newSessionHome").addEventListener("click", () => browseNewSessionFolder());
newSessionUp.addEventListener("click", () => {
  if (newSessionFolder?.parent) browseNewSessionFolder(newSessionFolder.parent);
});
document.querySelector("#newSessionPathForm").addEventListener("submit", (event) => {
  event.preventDefault();
  browseNewSessionFolder(newSessionPath.value.trim());
});
newSessionPath.addEventListener("input", () => {
  invalidateNewSessionFolder();
  newSessionFolders.replaceChildren();
  newSessionFolders.setAttribute("aria-busy", "false");
  newSessionStatus.classList.remove("error");
  newSessionStatus.textContent = "「開く」で入力したフォルダを確認してください。";
});
for (const id of ["closeNewSession", "cancelNewSession"]) document.getElementById(id).addEventListener("click", () => newSessionDialog.close());
newSessionDialog.addEventListener("close", () => {
  invalidateNewSessionFolder();
  setNewSessionStarting(false);
});
createNewSession.addEventListener("click", createSessionFromPicker);
sidebarConnectionsToggle?.addEventListener("click", () => {
  setSidebarConnectionsOpen(!sidebarConnectionsOpen);
});
// Turning an iPad sideways changes which default applies, and until the header
// has been tapped once there is no choice of the owner's to override.
window.addEventListener("resize", () => {
  if (storedSidebarConnectionsOpen() !== null) return;
  const open = !isMobileViewport();
  if (open === sidebarConnectionsOpen) return;
  sidebarConnectionsOpen = open;
  applySidebarConnections();
});
threadSearch.addEventListener("input", renderThreadList);
for (const button of threadInboxTabButtons) {
  button.addEventListener("click", () => {
    setThreadInboxFilter(button.dataset.threadFilter);
  });
}
for (const button of threadSortTabButtons) {
  button.addEventListener("click", () => {
    threadSortMode = button.dataset.threadSort === "recent" ? "recent" : "project";
    localStorage.setItem(threadSortModeStorageKey, threadSortMode);
    renderThreadList();
  });
}
pluginsButton.addEventListener("click", showPlugins);
automationsButton.addEventListener("click", showAutomations);
settingsButton.addEventListener("click", showSettings);
mobileSettingsButton.addEventListener("click", showSettings);
sidebarRestartButton?.addEventListener("click", async () => {
  sidebarRestartButton.disabled = true;
  const restarting = await restartActiveBridge({
    onStart: () => showToast("再起動しています。まもなく再接続します。"),
    onError: () => showToast("再起動できませんでした。詳細はチャットの記録に残しました。", "error"),
  });
  if (!restarting) sidebarRestartButton.disabled = false;
});
mobileThreadsButton.addEventListener("click", () => {
  const nextVisible = !document.body.classList.contains("show-sidebar");
  setSidebarVisible(nextVisible);
  if (nextVisible) closeRightPanel();
});
sidebarScrim.addEventListener("click", () => {
  setSidebarVisible(false);
});
connectButton.addEventListener("click", () => connect());
promptInput.addEventListener("focus", () => {
  promptInputFocused = true;
  setReadingMode(false);
  updateQuickBarVisibility();
  keepComposerVisible();
});
promptInput.addEventListener("blur", () => {
  window.setTimeout(() => {
    promptInputFocused = document.activeElement === promptInput;
    updateQuickBarVisibility();
  }, 80);
});
promptInput.addEventListener("click", keepComposerVisible);
promptInput.addEventListener("input", () => {
  autoGrowPrompt();
  saveDraftForActiveThread();
});
terminalCommandInput?.addEventListener("focus", () => {
  setupVisualViewportVars();
  window.setTimeout(() => {
    window.scrollTo(0, 0);
    setupVisualViewportVars();
  }, 80);
});
terminalCommandInput?.addEventListener("blur", () => {
  window.setTimeout(setupVisualViewportVars, 80);
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
chatViewButton.addEventListener("click", () => setMainView("chat"));
terminalViewButton.addEventListener("click", () => setMainView("terminal"));
terminalFilter.addEventListener("change", () => {
  terminalFilterMode = terminalFilter.value || "all";
  localStorage.setItem(terminalFilterStorageKey, terminalFilterMode);
  updateTerminalFilterControls();
  renderTerminalTranscript();
});
for (const chip of terminalFilterChips) {
  chip.addEventListener("click", () => {
    terminalFilterMode = chip.dataset.terminalFilter || "all";
    localStorage.setItem(terminalFilterStorageKey, terminalFilterMode);
    terminalSearchIndex = 0;
    updateTerminalFilterControls();
    renderTerminalTranscript();
  });
}
terminalSearchInput?.addEventListener("input", () => {
  terminalSearchQuery = terminalSearchInput.value || "";
  terminalSearchIndex = 0;
  renderTerminalTranscript();
});
terminalSearchPrevButton?.addEventListener("click", () => {
  terminalSearchIndex = Math.max(0, terminalSearchIndex - 1);
  renderTerminalTranscript();
});
terminalSearchNextButton?.addEventListener("click", () => {
  terminalSearchIndex += 1;
  renderTerminalTranscript();
});
terminalFilterSheetButton?.addEventListener("click", () => toggleTerminalToolsSheet(true));
terminalCurrentFilterPill?.addEventListener("click", () => toggleTerminalToolsSheet(true));
terminalToolsButton?.addEventListener("click", () => toggleTerminalToolsSheet());
terminalToolsCloseButton?.addEventListener("click", () => toggleTerminalToolsSheet(false));
terminalCompactSearchButton?.addEventListener("click", () => {
  toggleTerminalToolsSheet(true);
  window.setTimeout(() => terminalSearchInput?.focus({ preventScroll: true }), 40);
});
terminalWrapToggle?.addEventListener("click", () => {
  terminalWrapMode = !terminalWrapMode;
  localStorage.setItem(terminalWrapStorageKey, terminalWrapMode ? "wrap" : "scroll");
  applyTerminalDisplaySettings();
  renderTerminalTranscript();
});
terminalAutoScrollButton.addEventListener("click", () => {
  setTerminalAutoScroll(!terminalAutoScroll);
});
terminalAutoScrollMini?.addEventListener("click", () => setTerminalAutoScroll(!terminalAutoScroll));
terminalClearButton.addEventListener("click", () => {
  terminalHistories.set(currentThreadColorKey(), currentTerminalHistory().filter((entry) => !isTerminalSurfaceEntry(entry)));
  renderTerminalTranscript();
  showToast("表示中のTerminal出力だけをクリアしました。");
});
terminalCopyButton.addEventListener("click", async () => {
  const text = currentTerminalSurfaceHistory()
    .filter(terminalFilterMatches)
    .map((entry) => `[${terminalTimestampLabel(entry.ts)}] ${normalizeTerminalKind(entry.kind)} ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`)
    .join("\n");
  try {
    await copyTextToClipboard(text);
    showToast("表示中のTerminal出力をコピーしました。");
  } catch (error) {
    addStatus(`Terminal出力をコピーできませんでした: ${error.message}`);
  }
});
terminalLatestButton?.addEventListener("click", () => {
  setTerminalAutoScroll(true);
});
terminalTranscript?.addEventListener("scroll", () => {
  saveScrollPositions();
  const nearBottom = terminalTranscript.scrollHeight - terminalTranscript.scrollTop - terminalTranscript.clientHeight < 40;
  if (!nearBottom && terminalAutoScroll) {
    setTerminalAutoScroll(false, { render: false });
  }
  updateTerminalLatestButton();
});
chatLatestButton?.addEventListener("click", () => {
  scrollChatToBottom();
});
log?.addEventListener("scroll", () => {
  saveScrollPositions();
  updateChatLatestButton();
  updateReadingMode();
});
// Now that neither direction brings the controls back, a tap on what is being
// read is the way to ask for them - the same gesture that dismisses a photo
// viewer's chrome, and no worse than a stray tap on a message.
log?.addEventListener("click", () => setReadingMode(false));
terminalFontDownButton?.addEventListener("click", () => setTerminalFontSize(terminalFontSize - 1));
terminalFontResetButton?.addEventListener("click", () => setTerminalFontSize(12));
terminalFontUpButton?.addEventListener("click", () => setTerminalFontSize(terminalFontSize + 1));
terminalFocusButton?.addEventListener("click", () => setTerminalFocusMode(!document.body.classList.contains("terminal-focus-mode")));
terminalCommandForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  runTerminalCommand(terminalCommandInput?.value || "");
});
terminalTextModeButton?.addEventListener("click", () => setTerminalInputMode("text"));
terminalKeysModeButton?.addEventListener("click", () => setTerminalInputMode("keys"));
terminalInputModeButton?.addEventListener("click", () => setTerminalInputMode(terminalInputMode === "keys" ? "text" : "keys"));
terminalMaxSheetButton?.addEventListener("click", () => setTerminalFocusMode(!document.body.classList.contains("terminal-focus-mode")));
terminalQuickbarPinButton?.addEventListener("click", () => setTerminalQuickbarPinned(!terminalQuickbarPinned));
terminalToolsSheet?.addEventListener("click", (event) => {
  const fontButton = event.target.closest("[data-terminal-font]");
  if (!fontButton) return;
  if (fontButton.dataset.terminalFont === "down") setTerminalFontSize(terminalFontSize - 1);
  if (fontButton.dataset.terminalFont === "reset") setTerminalFontSize(12);
  if (fontButton.dataset.terminalFont === "up") setTerminalFontSize(terminalFontSize + 1);
});
terminalOps?.addEventListener("click", (event) => {
  const keyButton = event.target.closest("[data-terminal-key]");
  if (!keyButton) return;
  handleTerminalKey(keyButton.dataset.terminalKey);
});
fleetDashboardButton?.addEventListener("click", openBridgeFleet);
bridgePill?.addEventListener("click", openBridgeFleet);
addBridgeButton?.addEventListener("click", () => openBridgeFleet({ focusAdd: true }));
closeBridgeFleetButton?.addEventListener("click", closeBridgeFleet);
bridgeAddClear?.addEventListener("click", () => {
  if (bridgeAddInput) bridgeAddInput.value = "";
  if (bridgeAddStatus) bridgeAddStatus.textContent = "";
});
bridgeAddSubmit?.addEventListener("click", addBridgeEntriesFromInput);
threadPositionPill?.addEventListener("click", openThreadSwitcher);
closeThreadSwitcherButton?.addEventListener("click", closeThreadSwitcher);
headerThreadColorButton?.addEventListener("click", () => openThreadColorPopover());
workspaceIndicator?.addEventListener("click", async () => {
  const fullPath = workspaceIndicator.dataset.fullPath || currentWorkspace.workspaceLocation || "";
  if (!fullPath) return;
  try {
    await copyTextToClipboard(fullPath);
    showToast("作業パスをコピーしました。");
  } catch {
    showToast(fullPath);
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", setupVisualViewportVars);
  window.visualViewport.addEventListener("scroll", setupVisualViewportVars);
}
window.addEventListener("resize", setupVisualViewportVars);
setupVisualViewportVars();
menuButton.addEventListener("click", () => {
  const desktopPanelVisible =
    window.matchMedia("(min-width: 1101px)").matches && !document.body.classList.contains("hide-artifacts");
  const mobilePanelVisible = document.body.classList.contains("show-panel");
  if (desktopPanelVisible || mobilePanelVisible) {
    closeRightPanel();
    addStatus("右パネルを閉じました。");
  } else {
    showRightPanel();
    addStatus("右パネルを開きました。");
  }
});
closePanelButton.addEventListener("click", closeRightPanel);
artifactPreview.addEventListener("click", (event) => {
  if (event.target.closest("[data-preview-close]")) hideArtifactPreview();
});
function isSupportedUpload(file) {
  const name = String(file.name || "").toLowerCase();
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("audio/") ||
    /\.(m4a|mp3|wav|aac|flac|ogg|webm|mp4)$/.test(name)
  );
}

addButton.addEventListener("click", () => fileInput.click());
expandPromptButton.addEventListener("click", openPromptModal);
closePromptModalButton.addEventListener("click", () => closePromptModal({ apply: true }));
cancelPromptModalButton.addEventListener("click", () => closePromptModal({ apply: false }));
applyPromptModalButton.addEventListener("click", () => closePromptModal({ apply: true }));
promptModal.addEventListener("click", (event) => {
  if (event.target === promptModal) closePromptModal({ apply: true });
});
promptModalInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePromptModal({ apply: true });
});
fileInput.addEventListener("change", async () => {
  const selectedFiles = Array.from(fileInput.files || []);
  const files = selectedFiles.filter(isSupportedUpload);
  addButton.disabled = true;
  try {
    for (const file of files) {
      addStatus(`添付をMacへアップロード中: ${file.name} (${formatBytes(file.size)})`);
      pendingFiles.push(await uploadFile(file));
      renderAttachments();
      saveDraftForActiveThread();
    }
    renderAttachments();
    saveDraftForActiveThread();
    if (files.length) addStatus(`${files.length}件のファイルを添付しました。送信時は保存済みパスだけを渡します。`);
    if (selectedFiles.length > files.length) addStatus(`${selectedFiles.length - files.length}件の未対応ファイルをスキップしました。`);
  } catch (error) {
    addEntry("error", `添付に失敗しました: ${error.message}`);
  } finally {
    addButton.disabled = false;
    fileInput.value = "";
  }
});
accessButton.addEventListener("click", () => {
  if (activeLabInfo()) return;
  const index = accessModes.findIndex((candidate) => candidate.label === accessMode.label);
  accessMode = accessModes[(index + 1) % accessModes.length];
  accessButton.textContent = accessMode.label;
  updateTerminalHeader();
  addStatus(`権限を ${accessMode.label} に切り替えました。次の送信から反映します。`);
});
labStart?.addEventListener("click", () => requestLabOperation("start"));
labShutdown?.addEventListener("click", () => requestLabOperation("shutdown"));
modelButton.addEventListener("click", toggleModelMenu);
voiceButton.addEventListener("click", startVoiceInput);
modelMenu.addEventListener("click", (event) => {
  const serviceTierToggle = event.target.closest("[data-service-tier-toggle]");
  if (serviceTierToggle) {
    selectServiceTier(selectedServiceTier === "fast" ? "" : "fast");
    return;
  }
  const reasoningRow = event.target.closest("[data-reasoning]");
  if (reasoningRow) {
    selectReasoning(reasoningRow.dataset.reasoning);
    return;
  }
  const modelRow = event.target.closest("[data-model-choice]");
  if (modelRow) {
    selectModel(modelRow.dataset.modelChoice);
    return;
  }
  if (event.target.closest("#moreModelsButton")) {
    closeModelMenu();
    showModels();
  }
});
document.addEventListener("click", (event) => {
  if (modelMenu.classList.contains("hidden")) return;
  if (modelMenu.contains(event.target) || modelButton.contains(event.target)) return;
  closeModelMenu();
});
document.addEventListener("click", (event) => {
  if (!threadColorPopover?.classList.contains("hidden")) {
    if (!threadColorPopover.contains(event.target) && !headerThreadColorButton?.contains(event.target)) closeThreadColorPopover();
  }
  if (!threadSwitcher?.classList.contains("hidden")) {
    if (!threadSwitcher.contains(event.target) && !threadPositionPill?.contains(event.target)) closeThreadSwitcher();
  }
  if (!bridgeFleetSheet?.classList.contains("hidden")) {
    if (clickClosesBridgeFleet(event.target)) closeBridgeFleet();
  }
  if (!terminalToolsSheet?.classList.contains("hidden")) {
    const toolbarTarget =
      terminalToolsSheet.contains(event.target) ||
      terminalToolsButton?.contains(event.target) ||
      terminalFilterSheetButton?.contains(event.target) ||
      terminalCurrentFilterPill?.contains(event.target) ||
      terminalCompactSearchButton?.contains(event.target);
    if (!toolbarTarget) toggleTerminalToolsSheet(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.body.classList.contains("terminal-focus-mode")) setTerminalFocusMode(false);
  closeThreadColorPopover();
  closeThreadSwitcher();
  closeBridgeFleet();
  toggleTerminalToolsSheet(false);
});
document.querySelector(".conversation").addEventListener("touchstart", handleSwipeStart, { passive: true });
document.querySelector(".conversation").addEventListener("touchend", handleSwipeEnd, { passive: true });
// On the document, not the conversation: the edge strip runs the full height of
// the screen, past the header and the composer, and the swipe has to work
// wherever along it the finger lands.
document.addEventListener("touchstart", handleSidebarEdgeSwipeStart, { passive: true });
document.addEventListener("touchend", handleSidebarEdgeSwipeEnd, { passive: true });
document.addEventListener("touchcancel", () => {
  sidebarEdgeSwipeStart = null;
}, { passive: true });
artifactsTab.addEventListener("click", () => {
  showRightPanel();
  showReviewCenter("artifacts");
});
workspaceTab.addEventListener("click", showSettings);
automationTab.addEventListener("click", showAutomations);
statusButton.addEventListener("click", showStatus);
for (const button of reviewTabButtons) {
  button.addEventListener("click", () => showReviewCenter(button.dataset.reviewTab));
}
webSearchButton.addEventListener("click", () => {
  setActivePanelTab("web");
  promptInput.value = `${promptInput.value}${promptInput.value ? "\n" : ""}Web調査を使って確認してください。`;
  promptInput.focus();
});
for (const button of artifactButtons) {
  button.addEventListener("click", () => {
    for (const candidate of artifactButtons) candidate.classList.toggle("active", candidate === button);
    showArtifact(button.dataset.artifact);
  });
}

window.addEventListener("pageshow", (event) => {
  recoverFromPageResume(event.persisted ? "ページ復帰" : "ページ表示");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recoverFromPageResume("Safari復帰");
});
window.addEventListener("focus", () => recoverFromPageResume("フォーカス復帰"));
window.addEventListener("online", () => recoverFromPageResume("ネットワーク復帰"));

applyActiveBridgeState(activeBridgeId);
setReady(false);
applyStandaloneState();
updateModelButton();
applyCurrentThreadAccent();
applyTerminalDisplaySettings();
setTerminalInputMode(terminalInputMode, { silent: true });
updateTerminalFilterControls();
renderQuickActions();
renderTaskTemplates();
initTaskTemplatesToggle();
restoreDraftForCurrentThread();
setMainView(mainViewMode);
try {
  if (sessionStorage.getItem(terminalFocusSessionKey) === "1") setTerminalFocusMode(true);
} catch {
  // Session storage is optional.
}
applySidebarConnections();
renderFleet();
loadArtifacts();
refreshBridgeState(activeBridgeId, { force: true })
  .catch(() => {})
  // Ask the bridge which provider it serves before the first thread load, so a
  // stored per-thread choice cannot send this session at a provider the bridge
  // has no way to answer.
  .finally(() => syncProviderFromBridge().finally(() => loadThreads().catch(() => {}).finally(connect)));
refreshFleet({ force: true })
  .catch(() => {})
  .finally(() => loadFleetThreads({ force: true }).catch(() => {}));
unregisterStaleServiceWorkersIfNeeded().finally(() => {
  if (params.get("pwaDiagnostics") === "1") safeWriteStorage(localStorage, pwaDiagnosticsStorageKey, "1");
  trackHeaderBlockEnd();
  showPwaInstallHint();
  renderViewportDebug();
});
setInterval(() => {
  if (document.visibilityState !== "hidden") loadThreads({ background: true });
}, 10_000);
// The other Macs are polled more slowly than the one being worked on: their
// lists move when someone is at that machine, not while this one is being used.
setInterval(() => {
  if (document.visibilityState !== "hidden") loadFleetThreads().catch(() => {});
}, 20_000);
setInterval(() => {
  if (document.visibilityState !== "hidden") refreshSelectedThread();
}, 3_000);
fleetPollTimer = setInterval(() => {
  if (document.visibilityState !== "hidden") refreshFleet().catch(() => {});
}, 7_000);
// Slow on purpose: the registry only changes when the owner adds or removes a
// machine, and this is the one thing that tells an app left open for days that
// another phone deleted one.
setInterval(() => {
  if (document.visibilityState !== "hidden") refreshBridgeRegistryFromHome().catch(() => {});
}, bridgeRegistryRefreshMs);
