// Mobile smoke check for the phone bridge UI.
//
// Boots the static `public/` bundle with a mocked bridge API + WebSocket, opens
// it in an iPhone-sized viewport, and asserts the mobile terminal-compact layout
// invariants (dynamic thread title, status/quick-action band, workspace strip,
// Chat/Term switch). Run with `node scripts/mobile-smoke.js`; pass `--shots` to
// also drop screenshots into `.uploads/mobile-smoke/` for manual review.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const token = "smoke-token";
const wantShots = process.argv.includes("--shots");
const shotsDir = path.join(root, ".uploads", "mobile-smoke");
const artifactRepo = path.join(root, "..", "artifact-workspace");
const drawerRepo = path.join(root, "..", "drawer-workspace");

const mime = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

const activeThread = { id: "thread-mobile-compact", name: "Mobile terminal compact polish", cwd: root, updatedAt: Date.now() };
const threads = [
  activeThread,
  { id: "thread-artifacts", name: "Artifact preview polish", cwd: artifactRepo, updatedAt: Date.now() - 3600_000 },
  { id: "thread-drawer", name: "Drawer and composer tuning", cwd: drawerRepo, updatedAt: Date.now() - 86_400_000 },
];
const staleThreadList = threads.filter((thread) => thread.id !== activeThread.id);
const repoColorOverrides = {
  "repo:codex-remote-control-lab": "#2563eb",
  "repo:artifact-workspace": "#db2777",
  "repo:drawer-workspace": "#16a34a",
};

const history = [
  { type: "user", text: "モバイルの terminal compact レイアウトを確認したい。" },
  { type: "assistant", text: "ヘッダー・ステータス帯・ワンタップ入力・作業ストリップを点検しました。" },
  { type: "status", text: "前回完了・送信できます" },
];

function isInsideDir(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.resolve(publicDir, `.${pathname}`);
    if (!isInsideDir(publicDir, file)) return res.writeHead(403).end("Forbidden");
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "content-type": mime.get(path.extname(file)) || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function mockApi(page, origin) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/bridge/info") {
      return route.fulfill({
        json: {
          label: "Home bridge",
          provider: "codex",
          repoRoot: root,
          cwd: root,
          workdir: root,
          branch: "feature/mobile-terminal-compact",
        },
      });
    }
    if (url.pathname === "/api/threads") return route.fulfill({ json: { data: staleThreadList } });
    if (url.pathname === "/api/thread") return route.fulfill({ json: { threadId: "thread-mobile-compact", history } });
    if (url.pathname === "/api/artifacts") return route.fulfill({ json: { data: [] } });
    if (url.pathname === "/api/file") {
      return route.fulfill({ json: { path: url.searchParams.get("path") || "README.md", kind: "markdown", text: "# Smoke" } });
    }
    if (url.pathname === "/api/config") {
      return route.fulfill({ json: { auth: { authMethod: "token" }, config: { config: { model: "gpt-5.5", cwd: root } }, errors: [] } });
    }
    if (url.pathname === "/api/models") {
      return route.fulfill({ json: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "medium" }] } });
    }
    if (url.pathname === "/api/status") {
      return route.fulfill({
        json: {
          uiPort: 45214,
          codexUrl: "ws://127.0.0.1:45213",
          historySyncEnabled: true,
          workdir: root,
          repoName: "codex-remote-control-lab",
          gitBranch: "feature/mobile-terminal-compact",
          bridges: [{ threadId: "thread-mobile-compact", clients: 1, ready: true }],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "mock route not found" } });
  });
}

async function mockWebSocket(page) {
  await page.addInitScript((payload) => {
    class MockWebSocket extends EventTarget {
      constructor() {
        super();
        this.readyState = MockWebSocket.CONNECTING;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "turn",
                  status: "completed",
                  turnId: "turn-smoke-completed",
                  run: { state: "done", label: "完了しました", updatedAt: Date.now() },
                }),
              }),
            );
          }, 180);
        }, 80);
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    }
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    window.WebSocket = MockWebSocket;
  }, {
    type: "ready",
    threadId: "thread-mobile-compact",
    history,
    model: "gpt-5.5",
    clients: 1,
    workdir: root,
    repoName: "codex-remote-control-lab",
    gitBranch: "feature/mobile-terminal-compact",
  });
}

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
}

async function run() {
  const { server, origin } = await startServer();
  let browser;
  const consoleErrors = [];
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("requestfailed", (req) => consoleErrors.push(`requestfailed ${req.url()}`));
    page.on("response", (res) => {
      if (res.status() >= 400) consoleErrors.push(`${res.status()} ${res.url()}`);
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    await mockWebSocket(page);
    await mockApi(page, origin);
    await page.addInitScript((colors) => {
      localStorage.setItem("codexPhoneRepoColors:v1", JSON.stringify(colors));
      localStorage.setItem("codexPhoneThreadInboxFilter:v1", "recent");
    }, repoColorOverrides);
    await page.goto(`${origin}/?token=${token}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-state="ready"], [data-state="done"]');
    await page.waitForTimeout(300);
    const pwaDismiss = page.locator("[data-pwa-dismiss]");
    if (await pwaDismiss.count()) await pwaDismiss.click();

    // Issue 3: the title is the real thread name, not the old fixed label.
    const title = (await page.locator("#threadTitle").textContent())?.trim();
    check("thread title is dynamic (not the fixed label)", title && title !== "稼働中スレッド", `title="${title}"`);
    check("no #threadSubtitle element remains", (await page.locator("#threadSubtitle").count()) === 0);
    await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done");
    await page.waitForTimeout(300);
    const completedListState = await page.evaluate(() => ({
      currentGroupCount: document.querySelectorAll(".current-thread-group").length,
      activeNormalRows: document.querySelectorAll(".project-group:not(.current-thread-group) .thread-item.active").length,
    }));
    check(
      "completed current thread returns to the normal list without restart",
      completedListState.currentGroupCount === 0 && completedListState.activeNormalRows === 1,
      JSON.stringify(completedListState),
    );

    // Issue 2: status + quick actions live together in one band, clearly separable.
    check("composer status band exists", (await page.locator(".composer-status-bar").count()) === 1);
    check("run-state is inside the status band", (await page.locator(".composer-status-bar #runState").count()) === 1);
    check("quick actions are inside the status band", (await page.locator(".composer-status-bar #quickActions").count()) === 1);
    const chipCount = await page.locator("#quickActions .quick-action-chip").count();
    check("quick action chips render", chipCount >= 8, `chips=${chipCount}`);
    const quickActionLabels = await page.locator("#quickActions .quick-action-chip").evaluateAll((chips) =>
      chips.map((chip) => chip.textContent?.trim()).filter(Boolean),
    );
    check(
      "git quick actions are available",
      ["プッシュ", "マージ", "コミット", "追加"].every((label) => quickActionLabels.includes(label)),
      quickActionLabels.join(", "),
    );
    const bandRows = await page.evaluate(() => {
      const runState = document.querySelector(".composer-status-bar #runState");
      const quick = document.querySelector(".composer-status-bar #quickActions");
      if (!runState || !quick) return null;
      const a = runState.getBoundingClientRect();
      const b = quick.getBoundingClientRect();
      return { sameRow: Math.abs(a.top - b.top) < a.height, runStateBordered: getComputedStyle(runState).borderBottomWidth };
    });
    check("status and quick actions sit on one row", bandRows && bandRows.sameRow);
    check("run-state reads as a label (no border)", bandRows && bandRows.runStateBordered === "0px");

    // Issue 4: workspace details remain in the DOM for a11y/details, but the
    // duplicate strip is hidden on mobile because the bridge pill already
    // identifies the active worktree.
    check("workspace tags use quiet labels", (await page.locator(".workspace-tag").count()) === 2);
    check("legacy pwd badge is gone", (await page.locator(".workspace-pwd-badge").count()) === 0);
    const workspaceStripDisplay = await page.locator("#workspaceIndicator").evaluate((el) => getComputedStyle(el).display);
    check("mobile workspace strip is visually hidden", workspaceStripDisplay === "none", `display=${workspaceStripDisplay}`);
    const bridgeListState = await page.locator("#bridgeFleetList").evaluate((el) => ({
      hidden: el.hidden,
      rows: el.querySelectorAll(".bridge-fleet-row").length,
    }));
    check("single bridge row is not duplicated in the sidebar", bridgeListState.hidden && bridgeListState.rows === 0, JSON.stringify(bridgeListState));
    const userFacingLabels = await page.evaluate(() => ({
      fleet: document.querySelector("#fleetCurrentLabel")?.textContent?.trim(),
      bridge: document.querySelector("#bridgePillLabel")?.textContent?.trim(),
      chatTab: document.querySelector("#chatViewButton")?.textContent?.trim(),
      logTab: document.querySelector("#terminalViewButton")?.textContent?.trim(),
      statusTitle: document.querySelector("#statusButton")?.getAttribute("title"),
    }));
    check(
      "bridge pill identifies the active worktree",
      userFacingLabels.fleet === "現在の接続先" && userFacingLabels.bridge === "codex-remote-control-lab",
      JSON.stringify(userFacingLabels),
    );
    check("main tabs use Japanese user-facing labels", userFacingLabels.chatTab?.includes("チャット") && userFacingLabels.logTab?.includes("ログ"), JSON.stringify(userFacingLabels));
    check("status panel is named for connection state", userFacingLabels.statusTitle === "接続状態", JSON.stringify(userFacingLabels));
    await page.locator("#bridgePill").click();
    await page.waitForTimeout(120);
    const connectionSheetText = await page.locator("#bridgeFleetSheet").innerText();
    check(
      "connection sheet hides internal terminology",
      !/(Home bridge|Bridge Fleet|Worktree|\btoken\b)/.test(connectionSheetText),
      connectionSheetText.replace(/\s+/g, " ").slice(0, 240),
    );
    await page.locator("#closeBridgeFleet").click();

    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(120);
    await page.locator("#addBridgeButton").click();
    await page.waitForTimeout(180);
    const addConnectionSheet = await page.evaluate(() => {
      const sheet = document.querySelector("#bridgeFleetSheet");
      const input = document.querySelector("#bridgeAddInput");
      return {
        hidden: sheet?.classList.contains("hidden"),
        sidebarVisible: document.body.classList.contains("show-sidebar"),
        inputInSheet: Boolean(input && sheet?.contains(input)),
        activeId: document.activeElement?.id || "",
      };
    });
    check(
      "add connection command opens the connection sheet",
      addConnectionSheet && !addConnectionSheet.hidden && !addConnectionSheet.sidebarVisible && addConnectionSheet.inputInSheet,
      JSON.stringify(addConnectionSheet),
    );
    check("add connection command focuses the input", addConnectionSheet?.activeId === "bridgeAddInput", JSON.stringify(addConnectionSheet));
    await page.locator("#closeBridgeFleet").click();

    // Issue 5: header color button is quieter (smaller, neutral background).
    const colorBtn = await page.evaluate(() => {
      const el = document.querySelector("#headerThreadColorButton");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { width: el.getBoundingClientRect().width, border: cs.borderTopWidth };
    });
    check("header color button is compact", colorBtn && colorBtn.width <= 31, JSON.stringify(colorBtn));
    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(120);
    const repoColorState = await page.evaluate(() => {
      const canonicalColor = (value) => {
        const probe = document.createElement("span");
        probe.style.color = value;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const accent = canonicalColor(getComputedStyle(document.documentElement).getPropertyValue("--thread-accent").trim());
      const dot = document.querySelector(".thread-item.active .thread-color-button");
      return {
        accent,
        dot: dot ? getComputedStyle(dot).backgroundColor : "",
        title: dot?.getAttribute("title") || "",
      };
    });
    check(
      "active thread marker uses the repo color",
      repoColorState.accent && repoColorState.dot === repoColorState.accent && repoColorState.title.includes("リポ色"),
      JSON.stringify(repoColorState),
    );
    const repoMarkerState = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".project-group"))
        .map((group) => {
          const project = group.querySelector(".project-name")?.textContent?.trim() || "";
          const dot = group.querySelector(".thread-color-button");
          return {
            project,
            color: dot ? getComputedStyle(dot).backgroundColor : "",
          };
        })
        .filter((item) => item.project && item.color),
    );
    const repoMarkerColors = new Set(repoMarkerState.map((item) => item.color));
    check(
      "repo markers are scoped by repo",
      repoMarkerState.length >= 3 && repoMarkerColors.size >= 3,
      JSON.stringify(repoMarkerState),
    );
    if (wantShots) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, "sidebar.png") });
    }
    await page.evaluate(() => {
      document.body.classList.remove("show-sidebar");
      document.querySelector("#mobileThreads")?.setAttribute("aria-expanded", "false");
    });
    await page.waitForTimeout(120);

    if (wantShots) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, "chat.png") });
    }

    // Chat / Term switch still works.
    await page.locator("#terminalViewButton").click();
    await page.waitForTimeout(250);
    check("terminal view activates", (await page.locator("#mainTerminalView:not(.hidden)").count()) === 1);
    if (wantShots) await page.screenshot({ path: path.join(shotsDir, "terminal.png") });

    // Focus the composer: it must stay fully inside the visible viewport (issue 1).
    await page.locator("#chatViewButton").click();
    await page.waitForTimeout(150);
    await page.locator("#prompt").focus();
    await page.waitForTimeout(200);
    const composerFit = await page.evaluate(() => {
      const rect = document.querySelector("#composer").getBoundingClientRect();
      const style = getComputedStyle(document.querySelector("#composer"));
      return {
        bottom: Math.round(rect.bottom),
        viewport: Math.round(window.innerHeight),
        gapAbove: Math.round(rect.top),
        gapBelow: Math.round(window.innerHeight - rect.bottom),
        position: style.position,
      };
    });
    check("composer stays within the viewport when focused", composerFit.bottom <= composerFit.viewport + 2, JSON.stringify(composerFit));
    check("focused composer is fixed to the viewport bottom", composerFit.position === "fixed" && composerFit.gapBelow <= 8, JSON.stringify(composerFit));
    if (wantShots) await page.screenshot({ path: path.join(shotsDir, "composer-focus.png") });

    // Issue 1: browser Safari reports a smaller visualViewport while keeping a
    // taller layout viewport. The app shell should keep filling that layout
    // viewport so we do not create a blank band below the composer.
    const keyboardLayout = await page.evaluate(() => {
      const keyboard = 336;
      const visible = window.innerHeight - keyboard;
      document.documentElement.style.setProperty("--visual-viewport-height", `${visible}px`);
      document.documentElement.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
      document.documentElement.style.setProperty("--keyboard-inset", `${keyboard}px`);
      document.body.classList.add("keyboard-open");
      const shell = document.querySelector(".app-shell").getBoundingClientRect();
      const composer = document.querySelector("#composer").getBoundingClientRect();
      return {
        visible,
        layout: Math.round(window.innerHeight),
        shellBottom: Math.round(shell.bottom),
        composerBottom: Math.round(composer.bottom),
        gapBelowShell: Math.round(window.innerHeight - shell.bottom),
        gapBelowComposer: Math.round(window.innerHeight - composer.bottom),
      };
    });
    check(
      "no phantom app gap when the keyboard is open in browser mode",
      Math.abs(keyboardLayout.gapBelowShell) <= 2,
      JSON.stringify(keyboardLayout),
    );
    check(
      "composer stays near the browser viewport bottom when the keyboard is open",
      Math.abs(keyboardLayout.gapBelowComposer) <= 8,
      JSON.stringify(keyboardLayout),
    );
    if (wantShots) await page.screenshot({ path: path.join(shotsDir, "keyboard-open.png") });
    await page.evaluate(() => document.body.classList.remove("keyboard-open"));

    check("no console / page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

    await page.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  let failed = 0;
  for (const result of checks) {
    const tag = result.ok ? "PASS" : "FAIL";
    if (!result.ok) failed += 1;
    console.log(`${tag}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed${wantShots ? ` — screenshots in ${path.relative(root, shotsDir)}` : ""}`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
