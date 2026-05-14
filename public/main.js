const log = document.querySelector("#log");
const meta = document.querySelector("#meta");
const connectButton = document.querySelector("#connect");
const newThreadButton = document.querySelector("#newThread");
const searchButton = document.querySelector("#searchButton");
const pluginsButton = document.querySelector("#pluginsButton");
const automationsButton = document.querySelector("#automationsButton");
const settingsButton = document.querySelector("#settingsButton");
const menuButton = document.querySelector("#menuButton");
const mobileSettingsButton = document.querySelector("#mobileSettingsButton");
const closePanelButton = document.querySelector("#closePanelButton");
const addButton = document.querySelector("#addButton");
const expandPromptButton = document.querySelector("#expandPromptButton");
const accessButton = document.querySelector("#accessButton");
const thinkingButton = document.querySelector("#thinkingButton");
const modelButton = document.querySelector("#modelButton");
const modelMenu = document.querySelector("#modelMenu");
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
const statusButton = document.querySelector("#statusButton");
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
const workspaceRepo = document.querySelector("#workspaceRepo");
const workspaceLocation = document.querySelector("#workspaceLocation");
const branchName = document.querySelector("#branchName");
const sendButton = document.querySelector("#send");
const interruptButton = document.querySelector("#interruptRun");
const promptModal = document.querySelector("#promptModal");
const promptModalInput = document.querySelector("#promptModalInput");
const closePromptModalButton = document.querySelector("#closePromptModalButton");
const cancelPromptModalButton = document.querySelector("#cancelPromptModalButton");
const applyPromptModalButton = document.querySelector("#applyPromptModalButton");
const approval = document.querySelector("#approval");
const approvalText = document.querySelector("#approvalText");
const approveButton = document.querySelector("#approve");
const declineButton = document.querySelector("#decline");

const params = new URLSearchParams(location.search);
const token = params.get("token") || localStorage.getItem("codexPhoneToken") || "";
const preserveBookmarkEntryUrl = location.pathname.replace(/\/+$/, "").endsWith("/bookmark");
let selectedThread = preserveBookmarkEntryUrl ? "" : params.get("thread") || "";
if (token) localStorage.setItem("codexPhoneToken", token);
if (token && !params.get("token") && window.history?.replaceState) {
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("token", token);
  window.history.replaceState(null, "", nextUrl);
}
if (preserveBookmarkEntryUrl && params.has("thread") && window.history?.replaceState) {
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

function appPath(path) {
  const raw = String(path || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;
  return `${appBasePath}${raw}`;
}

function setSidebarVisible(visible) {
  document.body.classList.toggle("show-sidebar", visible);
  mobileThreadsButton.setAttribute("aria-expanded", visible ? "true" : "false");
}

if (manifestLink && token) {
  manifestLink.href = appPath(
    `/site.webmanifest?token=${encodeURIComponent(token)}&base=${encodeURIComponent(appBasePath)}`,
  );
}

const themeOptions = [
  { id: "simple", name: "シンプル", detail: "今のCodex Desktop風" },
  { id: "cyberpunk", name: "サイバーパンク", detail: "暗め / ネオンアクセント" },
  { id: "botanical", name: "ボタニカル", detail: "葉色 / 紙のような柔らかさ" },
];
let selectedTheme = localStorage.getItem("codexPhoneTheme") || "simple";

let ws = null;
let pendingApproval = null;
let assistantEntry = null;
let liveOutputGroup = "";
let statusGroup = null;
let reconnectTimer = null;
let threadCache = [];
let liveTurnActive = false;
let connectionReady = false;
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
let threadProvider = normalizeProviderName(params.get("provider") || (selectedThread.startsWith("claude:") ? "claude" : ""));
let threadProviderExplicit = Boolean(threadProvider);
const selectedThreadByProvider = new Map();
if (selectedThread && threadProvider) selectedThreadByProvider.set(threadProvider, selectedThread);
let selectedModel = localStorage.getItem("codexPhoneModel") || "";
let selectedModelLabel = localStorage.getItem("codexPhoneModelLabel") || "5.5";
let selectedReasoning = localStorage.getItem("codexPhoneReasoning") || "中";
let settingsRenderSeq = 0;
let artifactItems = [];
let activeArtifactPath = "";
let latestRateLimits = null;
let selectedExtensionView = localStorage.getItem("codexPhoneExtensionView") || "plugins";
let extensionPanelState = null;
const currentWorkspace = {
  repoName: "",
  workspaceLocation: "",
  gitBranch: "",
};
let currentRunState = "connecting";
let interruptRequestPending = false;
let accessMode = {
  label: "フルアクセス",
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
};
let pendingFiles = [];
const suppressedSocketReconnects = new WeakSet();
const apiTimeoutMs = 9000;
const uploadTimeoutMs = 60_000;
const resumeRefreshDebounceMs = 1200;
const staleSocketMs = 45_000;

const runStateText = {
  connecting: "接続中",
  ready: "未実行・送信できます",
  running: "Agent 処理中",
  streaming: "回答生成中",
  approval: "承認待ち",
  interrupting: "中断中",
  interrupted: "中断しました",
  syncing: "履歴同期中",
  done: "完了しました",
  disconnected: "切断",
  error: "エラー",
};
const interruptibleRunStates = new Set(["running", "streaming", "approval", "interrupting"]);
const terminalRunStates = new Set(["ready", "done", "interrupted", "disconnected", "error"]);

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
  const nextLabel = label || runStateText[state] || state;
  currentRunState = state;
  if (terminalRunStates.has(state)) interruptRequestPending = false;
  if (runState.dataset.state !== state || runStateLabel.textContent !== nextLabel) {
    runState.dataset.state = state;
    runStateLabel.textContent = nextLabel;
  }
  updateInterruptButton();
}

function applyServerRunState(run = {}) {
  const state = run.state || "ready";
  if (terminalRunStates.has(state)) interruptRequestPending = false;
  if (state !== "approval" && pendingApproval) {
    pendingApproval = null;
    approval.classList.add("hidden");
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
const inlineModelChoices = {
  codex: ["gpt-5.5", "gpt-5.4"],
  claude: ["sonnet", "opus", "haiku"],
};

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

function setSelectedModel(model, { persist = true } = {}) {
  selectedModel = model || "";
  selectedModelLabel = labelForModel(selectedModel);
  if (persist) {
    localStorage.setItem("codexPhoneModel", selectedModel);
    localStorage.setItem("codexPhoneModelLabel", selectedModelLabel);
  }
  updateModelButton();
}

function providerSupportsReasoning() {
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

function setActiveProvider(provider) {
  const previousProvider = activeProvider;
  activeProvider = normalizeProviderName(provider) || "codex";
  if (!threadProviderExplicit && (!threadProvider || threadProvider === previousProvider)) {
    threadProvider = activeProvider;
  }
  document.documentElement.dataset.provider = activeProvider;
  updateModelButton();
}

function updateModelButton() {
  const showReasoning = providerSupportsReasoning();
  modelButton.textContent = showReasoning ? `${selectedModelLabel} ${selectedReasoning}` : selectedModelLabel;
  thinkingButton.hidden = !showReasoning;
  modelMenu.classList.toggle("no-reasoning", !showReasoning);
  renderInlineModelChoices();
  for (const row of modelMenu.querySelectorAll(".model-menu-label, [data-reasoning]")) {
    row.hidden = !showReasoning;
  }
  const separator = modelMenu.querySelector(".model-menu-separator");
  if (separator) separator.hidden = !showReasoning;
  for (const row of modelMenu.querySelectorAll("[data-reasoning]")) {
    const active = row.dataset.reasoning === selectedReasoning;
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
  const choices = [...(inlineModelChoices[activeProvider] || inlineModelChoices.codex)];
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
  selectedReasoning = value;
  localStorage.setItem("codexPhoneReasoning", value);
  updateModelButton();
  closeModelMenu();
  addStatus(`インテリジェンスを ${value} に設定しました。`);
}

function selectModel(model) {
  setSelectedModel(model);
  closeModelMenu();
  addStatus(`モデルを ${model.toUpperCase()} に設定しました。次の送信から反映します。`);
}

function titleForThread(thread) {
  const raw = thread.name || thread.preview || thread.cwd || "";
  const firstLine = raw.split("\n").find(Boolean) || "";
  if (!firstLine || firstLine === thread.id || isOpaqueThreadId(firstLine)) return "名前未設定のthread";
  return firstLine.length > 54 ? `${firstLine.slice(0, 54)}...` : firstLine;
}

function isOpaqueThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function projectForThread(thread) {
  const cwd = String(thread.cwd || "").replace(/\/+$/, "");
  if (!cwd) return "No project";
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const hours = Math.floor(diffSeconds / 3600);
  const days = Math.floor(diffSeconds / 86400);
  const months = Math.floor(days / 30);
  if (diffSeconds < 3600) return "今";
  if (hours < 24) return `${hours}時間`;
  if (days < 30) return `${days}日`;
  return `${months || 1}か月`;
}

function isBlockStart(line) {
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
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
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return blocks.join("");
}

function stripUiDirectives(text) {
  return String(text || "")
    .replace(/(?:^|\n)::[a-z0-9-]+\{[^\n]*\}(?=\n|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const text = String(raw || "").trim();
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
  return {
    text: shortened || "エラー",
    label: "エラー",
    retrying: false,
    signature: shortened.slice(0, 180),
  };
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
  body.markdownSource = kind === "assistant" ? stripUiDirectives(text) : text || "";
  if (kind === "assistant" || kind === "user") body.innerHTML = renderMarkdown(body.markdownSource);
  else body.textContent = body.markdownSource;
}

function urlWithToken(url) {
  const target = new URL(appPath(url), location.href);
  target.searchParams.set("token", token);
  return target.pathname + target.search;
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
  return parts.length ? parts.join("、") : `${items.length}件の作業ログ`;
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

function addStatusGroupItem(text) {
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
    statusGroup = { items: [], summaryText, count, list };
  }
  statusGroup.items.push(text);
  updateStatusGroup(statusGroup);
  log.scrollTop = log.scrollHeight;
}

function addEntry(kind, text, images = [], options = {}) {
  if (kind === "status") {
    addStatusGroupItem(text);
    return null;
  }
  if (kind === "user" && !String(text || "").trim() && !images.length) return null;
  statusGroup = null;
  const el = document.createElement("article");
  el.className = `entry ${kind}`;

  const avatar = document.createElement("div");
  avatar.className = "entry-avatar";
  avatar.textContent = kind === "user" ? "U" : kind === "assistant" ? "C" : "›";

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
  log.scrollTop = log.scrollHeight;
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

function compactWorkspaceLocation(location) {
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

  const repo = currentWorkspace.repoName;
  const location = currentWorkspace.workspaceLocation;
  const displayLocation = compactWorkspaceLocation(location);
  const branch = currentWorkspace.gitBranch;
  workspaceRepo.textContent = repo || "--";
  workspaceLocation.textContent = displayLocation || "--";
  branchName.textContent = branch || "--";
  const empty = !repo && !location && !branch;
  workspaceIndicator.classList.toggle("empty", empty);
  const label = empty ? "作業場所を取得できません" : `repo: ${repo || "--"} / 現在地: ${location || "--"} / branch: ${branch || "--"}`;
  workspaceIndicator.title = label;
  workspaceIndicator.setAttribute("aria-label", label);
}

function setReady(ready) {
  connectionReady = ready;
  sendButton.disabled = !ready || Boolean(pendingSubmission);
  promptInput.disabled = false;
  composer.dataset.ready = ready ? "true" : "false";
  sendButton.title = pendingSubmission ? "送信確認中です" : ready ? "送信" : "接続後に送信できます";
  updateInterruptButton();
}

function clientMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `phone-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileDraftSignature(files = pendingFiles) {
  return JSON.stringify(files.map((file) => [file.name, file.absolutePath || file.path || file.url || "", file.size || 0]));
}

function setPendingSubmission(submission) {
  if (pendingSubmissionTimer) window.clearTimeout(pendingSubmissionTimer);
  pendingSubmission = submission;
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
  clearPendingSubmissionTimer();
  if (shouldClearDraft) {
    promptInput.value = "";
    pendingFiles = [];
    renderAttachments();
  } else {
    addStatus("送信は受理されました。入力欄は変更されているため残しました。");
  }
  setReady(connectionReady);
  return true;
}

function releasePendingSubmission(message = "") {
  if (!pendingSubmission) return;
  const submission = pendingSubmission;
  pendingSubmission = null;
  clearPendingSubmissionTimer();
  if (!promptInput.value && submission.inputValue) promptInput.value = submission.inputValue;
  if (!pendingFiles.length && submission.files?.length) {
    pendingFiles = submission.files.map((file) => ({ ...file }));
    renderAttachments();
  }
  setReady(connectionReady);
  if (message) addStatus(`${message} 入力は残しています。`);
}

function renderHistory(history) {
  log.replaceChildren();
  statusGroup = null;
  const outputGroupLastIndex = new Map();
  for (const [index, entry] of (history || []).entries()) {
    if (entry.type !== "assistant" || !entry.outputGroup) continue;
    outputGroupLastIndex.set(entry.outputGroup, index);
  }
  for (const [index, entry] of (history || []).entries()) {
    const outputGroup = entry.outputGroup || "";
    const showBulkCopy = entry.type === "assistant" && outputGroup && outputGroupLastIndex.get(outputGroup) === index;
    addEntry(entry.type, entry.text, entry.attachments || [], {
      outputGroup,
      showBulkCopy,
    });
  }
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
  return {
    ...thread,
    provider: nextProvider,
    updatedAt: thread.updatedAt || thread.updated_at || thread.updated_at_ms,
    createdAt: thread.createdAt || thread.created_at || thread.created_at_ms,
  };
}

function renderThreadList() {
  threadList.replaceChildren();
  const query = threadSearch.value.trim().toLowerCase();
  const provider = currentThreadProvider();
  const newProject = document.createElement("button");
  newProject.type = "button";
  newProject.className = selectedThread ? "project-heading new-project" : "project-heading new-project active";
  newProject.innerHTML = `<span class="project-folder"></span><span>New ${providerLabel(provider)} thread</span>`;
  newProject.addEventListener("click", () => selectThread(""));
  threadList.appendChild(newProject);

  const groups = new Map();
  for (const thread of threadCache) {
    const project = projectForThread(thread);
    const title = titleForThread(thread);
    const matches = !query || project.toLowerCase().includes(query) || title.toLowerCase().includes(query);
    if (!matches) continue;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(thread);
  }

  for (const [project, threads] of groups) {
    const group = document.createElement("section");
    group.className = "project-group";

    const heading = document.createElement("div");
    heading.className = "project-heading";
    const folder = document.createElement("span");
    folder.className = "project-folder";
    const name = document.createElement("span");
    name.textContent = project;
    heading.append(folder, name);
    group.appendChild(heading);

    const visibleThreads = threads.slice(0, 6);
    for (const thread of visibleThreads) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = thread.id === selectedThread ? "thread-item active" : "thread-item";
      item.title = titleForThread(thread);
      const title = document.createElement("span");
      title.className = "thread-title";
      title.textContent = titleForThread(thread);
      const time = document.createElement("span");
      time.className = "thread-time";
      time.textContent = formatRelativeTime(thread.updatedAt || thread.createdAt);
      item.append(title, time);
      item.addEventListener("click", () => selectThread(thread.id));
      group.appendChild(item);
    }

    if (threads.length > visibleThreads.length) {
      const more = document.createElement("div");
      more.className = "project-more";
      more.textContent = "もっと表示する";
      group.appendChild(more);
    } else if (!visibleThreads.length) {
      const empty = document.createElement("div");
      empty.className = "project-empty";
      empty.textContent = "チャットはありません";
      group.appendChild(empty);
    }
    threadList.appendChild(group);
  }

  if (!groups.size) {
    const empty = document.createElement("div");
    empty.className = "project-empty";
    empty.textContent = `${providerLabel(provider)}のチャットはありません`;
    threadList.appendChild(empty);
  }
}

function authQuery() {
  return `token=${encodeURIComponent(token)}`;
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

async function apiGet(path) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetchWithTimeout(appPath(`${path}${separator}${authQuery()}`));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

async function apiPost(path, body = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetchWithTimeout(appPath(`${path}${separator}${authQuery()}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

function switchThreadProvider(provider, { reload = true } = {}) {
  const nextProvider = normalizeProviderName(provider) || activeProvider;
  const previousProvider = currentThreadProvider();
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
  threadCache = [];
  lastHistorySignature = "";
  renderHistory([]);
  updateUrlThread();
  renderThreadList();
  closeSocket({ suppressReconnect: true });
  setReady(false);
  meta.textContent = `${providerLabel(nextProvider)} へ接続を切り替え中`;
  connect();

  if (reload) loadThreads({ provider: nextProvider, background: true }).catch(() => {});
}

async function loadThreads({ background = false, provider = "" } = {}) {
  if (!token) return;
  const requestedProvider = normalizeProviderName(provider || threadProvider);
  const path = requestedProvider ? `/api/threads?provider=${encodeURIComponent(requestedProvider)}` : "/api/threads";
  try {
    const result = await apiGet(path);
    if (result.activeProvider) setActiveProvider(result.activeProvider);
    const resultProvider = normalizeProviderName(result.provider || requestedProvider || activeProvider) || currentThreadProvider();
    if (requestedProvider && requestedProvider !== currentThreadProvider()) return;
    if (!threadProviderExplicit) threadProvider = resultProvider;
    threadCache = (result.data || []).map((thread) => normalizeThreadRecord(thread, resultProvider));
    renderThreadList();
    lastThreadListError = "";
  } catch (error) {
    const message = error.message || String(error);
    if (message !== lastThreadListError) {
      lastThreadListError = message;
      const text = `thread一覧を読めませんでした: ${message}`;
      if (background) addStatus(text);
      else addEntry("error", text);
    }
    if (!background) throw error;
  }
}

async function refreshSelectedThread() {
  if (!selectedThread || liveTurnActive || selectedThreadRefreshActive) return;
  const provider = currentThreadProvider();
  selectedThreadRefreshActive = true;
  try {
    const result = await apiGet(`/api/thread?thread=${encodeURIComponent(selectedThread)}&provider=${encodeURIComponent(provider)}`);
    if (result.threadId !== selectedThread) return;
    if (result.missing) {
      resetMissingSelectedThread(result.threadId);
      return;
    }
    renderHistoryIfChanged(result.history || []);
    lastThreadRefreshError = "";
  } catch (error) {
    const message = error.message || String(error);
    if (message !== lastThreadRefreshError) {
      lastThreadRefreshError = message;
      addStatus(`thread更新を読めませんでした: ${message}`);
    }
  } finally {
    selectedThreadRefreshActive = false;
  }
}

function resetMissingSelectedThread(threadId) {
  if (threadId && selectedThread !== threadId) return;
  selectedThreadByProvider.delete(currentThreadProvider());
  selectedThread = "";
  lastHistorySignature = "";
  renderHistory([]);
  threadTitle.textContent = "新しい共有thread";
  updateUrlThread();
  renderThreadList();
  addStatus("選択中のthreadが見つからないため、新しいthreadに戻しました。");
  closeSocket({ suppressReconnect: true });
  setReady(false);
  connect();
}

async function loadArtifacts() {
  if (!token) return;
  try {
    const result = await apiGet("/api/artifacts");
    renderArtifactIndex(result.data || []);
  } catch (error) {
    addEntry("error", `artifact一覧を読めませんでした: ${error.message}`);
  }
}

function updateUrlThread() {
  const next = new URL(location.href);
  if (selectedThread && !preserveBookmarkEntryUrl) next.searchParams.set("thread", selectedThread);
  else next.searchParams.delete("thread");
  if (threadProviderExplicit) next.searchParams.set("provider", currentThreadProvider());
  else next.searchParams.delete("provider");
  history.replaceState(null, "", next);
}

function syncReadyThread(threadId) {
  if (!threadProviderExplicit) threadProvider = activeProvider;
  if (threadId) selectedThreadByProvider.set(currentThreadProvider(), threadId);
  if (!threadId || selectedThread === threadId) return;
  selectedThread = threadId;
  updateUrlThread();
  const selected = threadCache.find((thread) => thread.id === selectedThread);
  threadTitle.textContent = selected ? titleForThread(selected) : "新しい共有thread";
  renderThreadList();
}

function selectThread(threadId) {
  selectedThread = threadId;
  selectedThreadByProvider.set(currentThreadProvider(), selectedThread);
  updateUrlThread();
  renderThreadList();
  setSidebarVisible(false);
  connect();
  if (selectedThread) refreshSelectedThread();
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
  requestAnimationFrame(() => composer.scrollIntoView({ block: "nearest", inline: "nearest" }));
  window.setTimeout(() => composer.scrollIntoView({ block: "nearest", inline: "nearest" }), 250);
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

function pluginDisplayName(plugin) {
  const summary = plugin?.summary || plugin || {};
  return summary.interface?.displayName || summary.name || summary.id || "プラグイン";
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
  if (value.startsWith("plugin:")) return "プラグイン由来";
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
  return view === "skills" ? "スキル" : "プラグイン";
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
  switcher.setAttribute("aria-label", "プラグインとスキルを切り替え");
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
  activeArtifactPath = "";
  setActivePanelTab("artifacts");
  artifactTitle.textContent = "アーティファクト";
  artifactList.classList.add("artifact-browser-list");
  renderArtifactRows();
  hideArtifactPreview();
}

function renderArtifactRows() {
  artifactList.replaceChildren();
  for (const item of artifactItems) {
    const icon = item.kind === "image" ? "IMG" : item.kind === "markdown" ? "MD" : "FILE";
    const row = addPanelRow(item.name, item.path, () => showArtifact(item.path), { badge: icon });
    row.classList.toggle("active", item.path === activeArtifactPath);
  }
  if (!artifactItems.length) addPanelRow("アーティファクトは見つかりませんでした");
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
  clearPanel("プラグイン / スキル", "extensions");
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
    addEntry("error", `プラグイン: ${pluginsResult.reason.message}`);
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
  clearPanel("オートメーション", "automation");
  addPanelRow("読み込み中...");
  try {
    const result = await apiGet("/api/automations");
    artifactList.replaceChildren();
    for (const automation of result.data || []) addPanelRow(automation.name, automation.status);
    if (!artifactList.children.length) addPanelRow("登録済みオートメーションはありません");
  } catch (error) {
    showToolError("オートメーション", error);
  }
}

async function showSettings() {
  const renderSeq = ++settingsRenderSeq;
  clearPanel("設定", "workspace");
  artifactList.replaceChildren();
  renderThemeSettings();
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
    addPanelRow("承認", accessMode.approvalPolicy);
    addPanelRow("サンドボックス", accessMode.sandboxMode);
    addPanelRow("作業ディレクトリ", localResult.value?.active?.workdir || "");
    if (result.errors?.length) addPanelRow("補足エラー", result.errors.join(" / "));
  } catch (error) {
    if (renderSeq !== settingsRenderSeq) return;
    loadingRow.remove();
    addPanelRow("読み込みに失敗しました", error.message);
    addEntry("error", `設定: ${error.message}`);
  }
}

function renderLocalSettings(payload) {
  const group = document.createElement("section");
  group.className = "local-settings";

  const title = document.createElement("div");
  title.className = "theme-settings-title";
  title.textContent = "起動設定";
  group.appendChild(title);

  const active = payload.active || {};
  const settings = payload.settings || {};
  const options = payload.options || {};
  const modelsByProvider = options.modelsByProvider || { [active.provider || "codex"]: options.models || [] };
  const defaultModels = options.defaultModels || {};
  let workspaceItems = options.workspaces || [];

  const modelLabel = document.createElement("div");
  modelLabel.className = "local-settings-current";
  modelLabel.innerHTML = `
    <span>現在</span>
    <strong>${escapeHtml(`${active.provider || "codex"} / ${active.model || "unknown"}`)}</strong>
    <code>${escapeHtml(shortenPath(active.workdir || ""))}</code>
  `;
  group.appendChild(modelLabel);

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
  renderWorkspaceOptions(workspaceSelect, workspaceItems, settings.workdir || active.workdir || "");

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

  const form = document.createElement("form");
  form.className = "settings-form";
  form.append(
    settingField("Provider", providerSelect),
    settingField("モデル", modelSelect),
    settingField("作業ディレクトリ", workspaceSelect),
    settingField("候補にないフォルダを追加", manualRow),
    historyLabel,
    status,
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
    setSettingsStatus(status, "Providerを切り替えました。保存するとこのポートの既定になります。");
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
      renderWorkspaceOptions(workspaceSelect, workspaceItems, result.workspace?.path || nextPath);
      manualInput.value = "";
      setSettingsStatus(status, "候補に追加しました。保存すると次回起動の作業ディレクトリになります。");
      addStatus("作業ディレクトリ候補を追加しました。");
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
      setSelectedModel(modelSelect.value);
      workspaceItems = result.options?.workspaces || workspaceItems;
      renderWorkspaceOptions(workspaceSelect, workspaceItems, result.settings?.workdir || workspaceSelect.value);
      switchThreadProvider(providerSelect.value);
      setSettingsStatus(status, result.restartRequired ? "保存しました。作業ディレクトリやモデルは再起動で既定に反映します。" : "保存しました。", result.restartRequired ? "warning" : "");
      addStatus("起動設定を保存しました。");
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  });

  restartButton.addEventListener("click", async () => {
    restartButton.disabled = true;
    setSettingsStatus(status, "再起動中...");
    addStatus("phone bridgeを再起動しています。");
    try {
      await apiPost("/api/restart", {});
    } catch (error) {
      setSettingsStatus(status, error.message, "error");
      restartButton.disabled = false;
      return;
    }
    setTimeout(() => location.reload(), 1800);
  });

  group.appendChild(form);
  artifactList.appendChild(group);
}

function renderWorkspaceOptions(select, items, selectedValue) {
  const selectedPath = selectedValue || "";
  const groups = new Map();
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.path || seen.has(item.path)) continue;
    seen.add(item.path);
    const groupName = item.group || "フォルダ";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  }
  if (selectedPath && !seen.has(selectedPath)) {
    groups.set("選択中", [{ path: selectedPath, label: shortenPath(selectedPath), group: "選択中" }]);
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
    addStatus("このブラウザでは音声入力APIが使えません。");
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

async function showStatus() {
  clearPanel("バックグラウンド", "status");
  try {
    const result = await apiGet(`/api/status?provider=${encodeURIComponent(currentThreadProvider())}`);
    addPanelRow("UI port", String(result.uiPort));
    addPanelRow("Provider", result.provider || "codex");
    if (result.defaultProvider && result.defaultProvider !== result.provider) addPanelRow("既定Provider", result.defaultProvider);
    if (result.codexUrl) addPanelRow("Codex app-server", result.codexUrl);
    latestRateLimits = result.rateLimits || null;
    renderRateLimitCard(latestRateLimits);
    addRateLimitPanelRows(latestRateLimits);
    addPanelRow("履歴同期", result.historySyncEnabled ? "有効" : "無効");
    addPanelRow("作業ディレクトリ", result.workdir);
    addPanelRow("Repo", result.repoName || "--");
    addPanelRow("現在地", result.workspaceLocation || "--");
    addPanelRow("Git branch", result.gitBranch || "--");
    setWorkspaceMeta(result);
    for (const bridge of result.bridges || []) {
      addPanelRow(bridge.threadId || "thread準備中", `${bridge.clients}端末 / ${bridge.ready ? "ready" : "starting"}`);
    }
  } catch (error) {
    showToolError("バックグラウンド", error);
  }
}

async function showArtifact(path) {
  showRightPanel();
  setActivePanelTab("artifacts");
  artifactTitle.textContent = "アーティファクト";
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
    const result = await apiGet(`/api/file?path=${encodeURIComponent(path)}`);
    setArtifactPreview(result);
    artifactPreview.classList.remove("hidden");
  } catch (error) {
    artifactPreview.innerHTML = `
      <div class="artifact-preview-header">
        <div class="artifact-preview-title">${escapeHtml(path)}</div>
        <button type="button" class="artifact-preview-close" data-preview-close>閉じる</button>
      </div>
      <p>読み込みに失敗しました: ${escapeHtml(error.message)}</p>
    `;
    addEntry("error", `アーティファクト: ${error.message}`);
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
  artifactPreview.innerHTML = `${header}${
    isMarkdown ? renderMarkdown(result.text, { allowHtml: true, headingOffset: 0 }) : `<pre><code>${escapeHtml(result.text)}</code></pre>`
  }`;
}

function renderAttachments() {
  attachments.replaceChildren();
  attachments.classList.toggle("has-attachments", pendingFiles.length > 0);
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
    close.textContent = "×";
    chip.append(thumb, label, close);
    chip.addEventListener("click", () => {
      pendingFiles = pendingFiles.filter((candidate) => candidate !== file);
      renderAttachments();
    });
    attachments.appendChild(chip);
  }
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

function scheduleReconnect(reason = "reconnect", delay = 900) {
  if (!canReconnect() || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!canReconnect()) return;
    addStatus(`接続を復旧します: ${reason}`);
    connect({ preserveHistory: true });
  }, delay);
}

function recoverFromPageResume(reason = "resume") {
  if (!token || document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastResumeRefreshAt < resumeRefreshDebounceMs) return;
  lastResumeRefreshAt = now;
  selectedThreadRefreshActive = false;
  loadThreads({ background: true }).catch(() => {});
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
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name || "upload"),
        "x-file-size": String(file.size || 0),
      },
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

function connect({ preserveHistory = false } = {}) {
  if (!token) {
    addEntry("error", "URLに token がありません。Mac側に表示されたURLをそのまま開いてください。");
    return;
  }
  const provider = currentThreadProvider();
  closeSocket({ suppressReconnect: true });
  liveTurnActive = false;
  liveOutputGroup = "";
  setRunState("connecting");
  if (!preserveHistory) {
    lastHistorySignature = "";
    renderHistory([]);
  }
  const selected = threadCache.find((thread) => thread.id === selectedThread);
  threadTitle.textContent = selected ? titleForThread(selected) : "新しい共有thread";

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const threadParam = selectedThread ? `&thread=${encodeURIComponent(selectedThread)}` : "";
  ws = new WebSocket(
    `${proto}//${location.host}${appPath(`/bridge?token=${encodeURIComponent(token)}&provider=${encodeURIComponent(provider)}${threadParam}`)}`,
  );
  const socket = ws;
  connectButton.disabled = true;
  meta.textContent = "接続中";

  socket.addEventListener("open", () => {
    lastWsMessageAt = Date.now();
    setRunState("connecting", "Agent に接続中");
    addEntry("status", "Macの共有ブリッジへ接続しました。");
  });

  socket.addEventListener("message", (event) => {
    lastWsMessageAt = Date.now();
    const msg = JSON.parse(event.data);
    if (msg.type === "ready") {
      setReady(true);
      setActiveProvider(msg.provider || "codex");
      setSelectedModel(msg.model, { persist: false });
      setWorkspaceMeta({
        repoName: msg.repoName || msg.run?.repoName,
        workspaceLocation: msg.workspaceLocation || msg.run?.workspaceLocation,
        gitBranch: msg.gitBranch || msg.run?.gitBranch,
      });
      syncReadyThread(msg.threadId);
      renderHistoryIfChanged(msg.history || []);
      meta.textContent = `${msg.model}  •  ${msg.clients}端末  •  ${msg.workdir}`;
      applyServerRunState(msg.run || { state: "ready" });
      addEntry("status", `共有${msg.provider || "codex"} thread ready: ${msg.threadId}`);
      return;
    }
    if (msg.type === "runState") {
      setWorkspaceMeta(msg);
      applyServerRunState(msg);
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
      addEntry("user", msg.text, msg.attachments || []);
      return;
    }
    if (msg.type === "promptAccepted") {
      acceptPendingSubmission(msg.clientMessageId);
      return;
    }
    if (msg.type === "assistantDelta") {
      setRunState("streaming");
      if (!assistantEntry) {
        assistantEntry = addEntry("assistant", "", [], {
          outputGroup: liveOutputGroup || `live-${Date.now()}`,
          showBulkCopy: true,
        });
      }
      setEntryText(assistantEntry, "assistant", `${assistantEntry.markdownSource || ""}${msg.text}`);
      log.scrollTop = log.scrollHeight;
      return;
    }
    if (msg.type === "approval") {
      pendingApproval = msg.request;
      setRunState("approval");
      approvalText.textContent = JSON.stringify(msg.request.params, null, 2);
      approval.classList.remove("hidden");
      return;
    }
    if (msg.type === "turn" && msg.status === "started") {
      if (msg.turnId && !assistantEntry) liveOutputGroup = msg.turnId;
      applyServerRunState(msg.run || { state: "running", label: "Agent 処理中", turnId: msg.turnId });
      return;
    }
    if (msg.type === "turn" && msg.status === "completed") {
      lastHistorySignature = "";
      assistantEntry = null;
      liveOutputGroup = "";
      applyServerRunState(msg.run || { state: "done", label: "完了しました", turnId: msg.turnId });
      loadThreads();
      refreshSelectedThread();
      return;
    }
    if (msg.type === "error") {
      releasePendingSubmission("送信に失敗しました。");
      showBridgeError(msg.text || "エラー");
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
    if (!shouldSuppressReconnect) scheduleReconnect("WebSocket切断");
  });

  socket.addEventListener("error", () => {
    interruptRequestPending = false;
    updateInterruptButton();
    setRunState("disconnected", "接続エラー");
    releasePendingSubmission("接続エラーで送信できませんでした。");
    if (!suppressedSocketReconnects.has(socket)) scheduleReconnect("WebSocketエラー");
  });
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const inputValue = promptInput.value;
  const text = inputValue.trim();
  if (!text && !pendingFiles.length) return;
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
    ws.send(
      JSON.stringify({
      type: "prompt",
      token,
      clientMessageId: submission.id,
      text: text || "添付ファイルを確認してください。",
      attachments: attachmentsToSend,
      options: {
        model: selectedModel || undefined,
        approvalPolicy: accessMode.approvalPolicy,
        sandboxMode: accessMode.sandboxMode,
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
  setRunState("interrupting", "中断要求を送信中");
  try {
    ws.send(JSON.stringify({ type: "interrupt", token }));
  } catch (error) {
    interruptRequestPending = false;
    updateInterruptButton();
    addEntry("error", `中断要求の送信に失敗しました: ${error.message}`);
  }
});

approveButton.addEventListener("click", () => {
  if (!pendingApproval) return;
  ws.send(JSON.stringify({ type: "approval", token, decision: "accept", request: pendingApproval }));
  approval.classList.add("hidden");
  pendingApproval = null;
  setRunState("running", "承認済み・処理中");
});

declineButton.addEventListener("click", () => {
  if (!pendingApproval) return;
  ws.send(JSON.stringify({ type: "approval", token, decision: "decline", request: pendingApproval }));
  approval.classList.add("hidden");
  pendingApproval = null;
  setRunState("running", "拒否済み・処理中");
});

newThreadButton.addEventListener("click", () => selectThread(""));
searchButton.addEventListener("click", () => {
  threadSearch.classList.toggle("hidden");
  threadSearch.focus();
  renderThreadList();
  setSidebarVisible(true);
});
threadSearch.addEventListener("input", renderThreadList);
pluginsButton.addEventListener("click", showPlugins);
automationsButton.addEventListener("click", showAutomations);
settingsButton.addEventListener("click", showSettings);
mobileSettingsButton.addEventListener("click", showSettings);
mobileThreadsButton.addEventListener("click", () => {
  const nextVisible = !document.body.classList.contains("show-sidebar");
  setSidebarVisible(nextVisible);
  if (nextVisible) closeRightPanel();
});
sidebarScrim.addEventListener("click", () => {
  setSidebarVisible(false);
});
connectButton.addEventListener("click", connect);
promptInput.addEventListener("focus", keepComposerVisible);
promptInput.addEventListener("click", keepComposerVisible);
if (window.visualViewport) {
  const updateKeyboardState = () => {
    const inset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    document.body.classList.toggle("keyboard-open", inset > 80);
    if (document.activeElement === promptInput) keepComposerVisible();
  };
  window.visualViewport.addEventListener("resize", updateKeyboardState);
  window.visualViewport.addEventListener("scroll", updateKeyboardState);
  updateKeyboardState();
}
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
    }
    renderAttachments();
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
  const index = accessModes.findIndex((candidate) => candidate.label === accessMode.label);
  accessMode = accessModes[(index + 1) % accessModes.length];
  accessButton.textContent = accessMode.label;
  addStatus(`権限を ${accessMode.label} に切り替えました。次の送信から反映します。`);
});
thinkingButton.addEventListener("click", toggleModelMenu);
modelButton.addEventListener("click", toggleModelMenu);
voiceButton.addEventListener("click", startVoiceInput);
modelMenu.addEventListener("click", (event) => {
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
  if (modelMenu.contains(event.target) || modelButton.contains(event.target) || thinkingButton.contains(event.target)) return;
  closeModelMenu();
});
artifactsTab.addEventListener("click", () => {
  showRightPanel();
  renderArtifactIndex(artifactItems);
});
workspaceTab.addEventListener("click", showSettings);
automationTab.addEventListener("click", showAutomations);
statusButton.addEventListener("click", showStatus);
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

setReady(false);
updateModelButton();
loadArtifacts();
loadThreads().catch(() => {}).finally(connect);
setInterval(() => {
  if (document.visibilityState !== "hidden") loadThreads({ background: true });
}, 10_000);
setInterval(() => {
  if (document.visibilityState !== "hidden") refreshSelectedThread();
}, 3_000);
