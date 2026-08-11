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
const artifactBridgeOrigin = "http://127.0.0.1:45224";
const artifactBridgeId = "artifact-bridge";

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
  // One Claude thread: only Claude sessions are resumed with `claude --resume`,
  // so the copy-command button belongs to them alone.
  { id: "thread-drawer", name: "Drawer and composer tuning", cwd: drawerRepo, updatedAt: Date.now() - 86_400_000, provider: "claude" },
  // Enough in one project to pass the collapsed cap of 6, so the show-more
  // control has something to reveal.
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `thread-bulk-${index}`,
    name: `Bulk thread ${index}`,
    cwd: artifactRepo,
    updatedAt: Date.now() - (index + 2) * 3600_000,
  })),
];
const threadsById = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
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

// Which folders hold tooling rather than work is a per-machine choice, so the
// bridge stores it and the sidebar reads it back.
let hiddenProjects = [];

// The app asks its home bridge for the connection list on load, so that the
// list survives the Home Screen icon being deleted. Nothing here is under
// test; the mock exists so the request is answered rather than logged as an
// error by the console check.
let registryBackup = { version: 2, revision: 0, updatedAt: 0, bridges: [], deleted: [], tokens: {} };
const restartCalls = [];

async function mockApi(page, origin) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const artifactBridge = url.origin === artifactBridgeOrigin;
    const activeRoot = artifactBridge ? artifactRepo : root;
    const activeRepoName = artifactBridge ? "artifact-workspace" : "codex-remote-control-lab";
    const activeBranch = artifactBridge ? "feature/artifacts" : "feature/mobile-terminal-compact";
    if (url.pathname === "/api/bridge/info") {
      return route.fulfill({
        json: {
          label: artifactBridge ? "artifact-workspace" : "Home bridge",
          hostName: "mini-smoke",
          provider: "codex",
          repoRoot: activeRoot,
          cwd: activeRoot,
          workdir: activeRoot,
          branch: activeBranch,
          uiPort: artifactBridge ? 45224 : 45214,
        },
      });
    }
    if (url.pathname === "/api/bridge/registry") {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        registryBackup = {
          version: 1,
          revision: Number(body.revision || 0) + 1,
          updatedAt: Date.now(),
          bridges: Array.isArray(body.bridges) ? body.bridges : [],
          deleted: Array.isArray(body.deleted) ? body.deleted : [],
          tokens: body.tokens && typeof body.tokens === "object" ? body.tokens : {},
        };
      }
      return route.fulfill({ json: { ok: true, ...registryBackup } });
    }
    if (url.pathname === "/api/threads") {
      const listed = (artifactBridge ? threads : staleThreadList).filter((thread) => !hiddenProjects.includes(thread.cwd));
      return route.fulfill({ json: { data: listed, hiddenProjects: [...hiddenProjects] } });
    }
    if (url.pathname === "/api/workspaces/hidden") {
      const body = JSON.parse(route.request().postData() || "{}");
      const target = String(body.path || "").replace(/\/+$/, "");
      hiddenProjects = body.hidden === false ? hiddenProjects.filter((item) => item !== target) : [...new Set([...hiddenProjects, target])];
      return route.fulfill({ json: { ok: true, path: target, hidden: hiddenProjects.includes(target), hiddenProjects: [...hiddenProjects] } });
    }
    if (url.pathname === "/api/thread") return route.fulfill({ json: { threadId: url.searchParams.get("thread") || "thread-mobile-compact", history } });
    if (url.pathname === "/api/artifacts") return route.fulfill({ json: { data: [] } });
    if (url.pathname === "/api/terminal/run") {
      return route.fulfill({
        json: {
          command: "pwd",
          cwd: activeRoot,
          code: 0,
          stdout: activeRoot,
          stderr: "",
          truncated: false,
          durationMs: 12,
        },
      });
    }
    if (url.pathname === "/api/restart") {
      restartCalls.push(url.origin);
      return route.fulfill({ json: { ok: true, message: "Restarting phone bridge" } });
    }
    if (url.pathname === "/api/file") {
      return route.fulfill({ json: { path: url.searchParams.get("path") || "README.md", kind: "markdown", text: "# Smoke" } });
    }
    if (url.pathname === "/api/config") {
      return route.fulfill({ json: { auth: { authMethod: "token" }, config: { config: { model: "gpt-5.5", cwd: activeRoot } }, errors: [] } });
    }
    if (url.pathname === "/api/models") {
      return route.fulfill({ json: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "medium" }] } });
    }
    if (url.pathname === "/api/status") {
      return route.fulfill({
        json: {
          uiPort: artifactBridge ? 45224 : 45214,
          codexUrl: "ws://127.0.0.1:45213",
          historySyncEnabled: true,
          health: { hostName: "mini-smoke" },
          workdir: activeRoot,
          repoName: activeRepoName,
          gitBranch: activeBranch,
          bridges: [
            {
              threadId: artifactBridge ? "thread-artifacts" : "thread-mobile-compact",
              clients: 1,
              ready: true,
              workdir: activeRoot,
              repoName: activeRepoName,
              workspaceLocation: activeRoot,
              gitBranch: activeBranch,
              run: {
                state: "done",
                repoName: activeRepoName,
                workspaceLocation: activeRoot,
                gitBranch: activeBranch,
              },
            },
          ],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "mock route not found" } });
  });
}

async function mockWebSocket(page) {
  await page.addInitScript((payload) => {
    window.__mockWebSocketUrls = [];
    class MockWebSocket extends EventTarget {
      constructor(url) {
        super();
        window.__mockWebSocketUrls.push(String(url || ""));
        const target = new URL(String(url || ""), location.href);
        const requestedThreadId = target.searchParams.get("thread") || payload.threadId;
        const requestedThread = payload.threadsById[requestedThreadId] || payload.threadsById[payload.threadId] || {};
        const requestedWorkdir = target.searchParams.get("workdir") || requestedThread.cwd || payload.workdir;
        const repoName = requestedWorkdir.split(/[\\/]/).filter(Boolean).pop() || payload.repoName;
        const threadTitle = requestedThread.name || requestedThread.displayTitle || payload.threadTitle || "Mobile terminal compact polish";
        const readyPayload = {
          ...payload,
          threadId: requestedThreadId,
          workdir: requestedWorkdir,
          repoName,
          workspaceLocation: requestedWorkdir,
          thread: {
            ...requestedThread,
            id: requestedThreadId,
            name: threadTitle,
            displayTitle: threadTitle,
            preview: threadTitle,
            cwd: requestedWorkdir,
            provider: "codex",
            updatedAt: Date.now(),
          },
        };
        this.readyState = MockWebSocket.CONNECTING;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(readyPayload) }));
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
    threadsById,
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
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      // Headless Chromium refuses a clipboard write without this, which would
      // exercise the fallback path instead of the one a phone actually takes.
      permissions: ["clipboard-read", "clipboard-write"],
    });
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
    await page.addInitScript((payload) => {
      const { colors, artifactRepo, artifactBridgeId, artifactBridgeOrigin, token } = payload;
      localStorage.setItem("codexPhoneRepoColors:v1", JSON.stringify(colors));
      localStorage.setItem("codexPhoneThreadInboxFilter:v1", "recent");
      localStorage.setItem(
        "codexPhoneBridgeRegistry:v1",
        JSON.stringify({
          version: 1,
          bridges: [
            {
              id: artifactBridgeId,
              label: "artifact-workspace",
              baseUrl: artifactBridgeOrigin,
              port: 45224,
              status: "connected",
              rememberToken: true,
            },
          ],
        }),
      );
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ [artifactBridgeId]: token }));
    }, { colors: repoColorOverrides, artifactRepo, artifactBridgeId, artifactBridgeOrigin, token });
    await page.goto(`${origin}/?token=${token}&thread=thread-artifacts`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-state="ready"], [data-state="done"]');
    await page.waitForTimeout(300);
    const startupNavigation = await page.evaluate((expectedWorkdir) => {
      const target = [...(window.__mockWebSocketUrls || [])].reverse().find((url) => url.includes("thread-artifacts")) || "";
      const parsed = new URL(target);
      return {
        thread: parsed.searchParams.get("thread"),
        workdir: parsed.searchParams.get("workdir"),
        host: parsed.host,
      };
    }, artifactRepo);
    check(
      "startup URL thread switches to the refreshed matching bridge and workdir",
      startupNavigation.thread === "thread-artifacts" &&
        startupNavigation.workdir === artifactRepo &&
        startupNavigation.host === "127.0.0.1:45224",
      JSON.stringify(startupNavigation),
    );
    const pwaDismiss = page.locator("[data-pwa-dismiss]");
    if (await pwaDismiss.count()) await pwaDismiss.click();

    // Issue 3: the title is the real thread name, not the old fixed label.
    const title = (await page.locator("#threadTitle").textContent())?.trim();
    check("thread title is dynamic (not the fixed label)", title && title !== "稼働中スレッド", `title="${title}"`);
    check("no #threadSubtitle element remains", (await page.locator("#threadSubtitle").count()) === 0);
    await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done").catch(async (error) => {
      const debug = await page.evaluate(() => ({
        runState: document.querySelector("#runState")?.dataset.state || "",
        runLabel: document.querySelector("#runStateLabel")?.textContent || "",
        wsUrls: window.__mockWebSocketUrls || [],
      }));
      throw new Error(`${error.message} ${JSON.stringify(debug)} ${consoleErrors.join(" | ")}`);
    });
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
    // The card above the list already is the current bridge, so this list is the
    // ones you can move to - every registered bridge except that one.
    const bridgeListState = await page.locator("#bridgeFleetList").evaluate((el) => ({
      hidden: el.hidden,
      rows: el.querySelectorAll(".bridge-fleet-row").length,
      registered: JSON.parse(localStorage.getItem("codexPhoneBridgeRegistry:v1") || "{}").bridges?.length || 0,
    }));
    check(
      "the sidebar offers the other registered bridges to switch to",
      !bridgeListState.hidden && bridgeListState.rows >= 1 && bridgeListState.rows === bridgeListState.registered - 1,
      JSON.stringify(bridgeListState),
    );
    const userFacingLabels = await page.evaluate(() => ({
      fleet: document.querySelector("#fleetCurrentLabel")?.textContent?.trim(),
      bridge: document.querySelector("#bridgePillLabel")?.textContent?.trim(),
      chatTab: document.querySelector("#chatViewButton")?.textContent?.trim(),
      logTab: document.querySelector("#terminalViewButton")?.textContent?.trim(),
      statusTitle: document.querySelector("#statusButton")?.getAttribute("title"),
    }));
    check(
      "bridge pill identifies the active worktree",
      userFacingLabels.fleet === "artifact-workspace" && userFacingLabels.bridge === "artifact-workspace",
      JSON.stringify(userFacingLabels),
    );
    check("main tabs identify Codex and Terminal views", userFacingLabels.chatTab?.includes("Codex") && userFacingLabels.logTab?.includes("Terminal"), JSON.stringify(userFacingLabels));
    check("status panel is named for connection state", userFacingLabels.statusTitle === "接続状態", JSON.stringify(userFacingLabels));
    await page.locator("#bridgePill").click();
    await page.waitForTimeout(120);
    const connectionSheetText = await page.locator("#bridgeFleetSheet").innerText();
    check(
      "connection sheet hides internal terminology",
      !/(Home bridge|Bridge Fleet|Worktree|\btoken\b)/.test(connectionSheetText),
      connectionSheetText.replace(/\s+/g, " ").slice(0, 240),
    );
    await page.locator(".bridge-sheet-card", { hasText: "codex-remote-control-lab" }).locator("button", { hasText: "切替" }).click();
    await page.waitForFunction(
      (expectedWorkdir) =>
        [...(window.__mockWebSocketUrls || [])].reverse().some((url) => {
          const parsed = new URL(url);
          return parsed.host !== "127.0.0.1:45224" && parsed.searchParams.get("workdir") === expectedWorkdir && !parsed.searchParams.get("thread");
        }),
      root,
    );
    const manualBridgeSwitch = await page.evaluate((expectedWorkdir) => {
      const target =
        [...(window.__mockWebSocketUrls || [])].reverse().find((url) => {
          const parsed = new URL(url);
          return parsed.host !== "127.0.0.1:45224" && parsed.searchParams.get("workdir") === expectedWorkdir;
        }) || "";
      const parsed = new URL(target);
      return {
        thread: parsed.searchParams.get("thread"),
        workdir: parsed.searchParams.get("workdir"),
        host: parsed.host,
        workspaceRepo: document.querySelector("#workspaceRepo")?.textContent?.trim() || "",
        bridgePill: document.querySelector("#bridgePillLabel")?.textContent?.trim() || "",
        mismatchHidden: document.querySelector("#contextMismatch")?.classList.contains("hidden"),
      };
    }, root);
    check(
      "manual bridge switch drops stale thread cwd and uses the active bridge workdir",
      !manualBridgeSwitch.thread &&
        manualBridgeSwitch.workdir === root &&
        manualBridgeSwitch.workspaceRepo === "codex-remote-control-lab" &&
        manualBridgeSwitch.mismatchHidden === true,
      JSON.stringify(manualBridgeSwitch),
    );
    if (await page.locator("#bridgeFleetSheet.hidden").count()) {
      await page.locator("#bridgePill").click();
      await page.waitForTimeout(120);
    }
    const artifactSwitchCard = page.locator(".bridge-sheet-card", { hasText: "artifact-workspace" });
    await artifactSwitchCard.scrollIntoViewIfNeeded();
    await artifactSwitchCard.locator("button", { hasText: "切替" }).click();
    await page.waitForFunction(() =>
      [...(window.__mockWebSocketUrls || [])].reverse().some((url) => {
        const parsed = new URL(url);
        return parsed.host === "127.0.0.1:45224" && parsed.searchParams.get("workdir")?.includes("artifact-workspace");
      }),
    );
    if (!(await page.locator("#bridgeFleetSheet.hidden").count())) await page.locator("#closeBridgeFleet").click();

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
    // Work spread across folders is only findable if the list can be read in
    // the order it happened, not just grouped by where it lives.
    const projectHeadings = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".project-group:not(.current-thread-group) .project-name")).map((node) => node.textContent?.trim() || ""),
    );
    check("project order is the default view", projectHeadings.length >= 3, JSON.stringify(projectHeadings));
    await page.locator("[data-thread-sort='recent']").click();
    const dateOrdered = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll(".project-group:not(.current-thread-group)"));
      const rows = Array.from(document.querySelectorAll(".project-group:not(.current-thread-group) .thread-item"));
      return {
        groups: groups.length,
        heading: groups[0]?.querySelector(".project-name")?.textContent?.trim() || "",
        rows: rows.length,
        workdirs: new Set(rows.map((row) => row.querySelector(".thread-workdir")?.textContent?.trim() || "")).size,
      };
    });
    check(
      "date order collapses every project into one list",
      dateOrdered.groups === 1 && dateOrdered.heading === "日時順" && dateOrdered.workdirs >= 2,
      JSON.stringify(dateOrdered),
    );
    await page.locator("[data-thread-sort='project']").click();
    const backToProjects = await page.evaluate(
      () => document.querySelectorAll(".project-group:not(.current-thread-group)").length,
    );
    check("switching back restores the project headings", backToProjects >= 3, String(backToProjects));
    // "もっと表示する" was a bare div with no handler, so the rows past the cap
    // could not be reached and the label was decoration.
    const beforeExpand = await page.evaluate(() => {
      const group = Array.from(document.querySelectorAll(".project-group")).find((item) => item.querySelector(".project-more"));
      const toggle = group?.querySelector(".project-more");
      return { tag: toggle?.tagName || "", label: toggle?.textContent?.trim() || "", rows: group?.querySelectorAll(".thread-item").length ?? -1 };
    });
    check(
      "showing more is a control, not a label",
      beforeExpand.tag === "BUTTON" && beforeExpand.rows === 6 && beforeExpand.label.startsWith("もっと表示する"),
      JSON.stringify(beforeExpand),
    );
    await page.locator(".project-more").first().click();
    const afterExpand = await page.evaluate(() => {
      const group = Array.from(document.querySelectorAll(".project-group")).find((item) => item.querySelector(".project-more"));
      return { label: group?.querySelector(".project-more")?.textContent?.trim() || "", rows: group?.querySelectorAll(".thread-item").length ?? -1 };
    });
    check(
      "it reveals the rows that were out of reach",
      afterExpand.rows > beforeExpand.rows && afterExpand.label === "表示を減らす",
      JSON.stringify(afterExpand),
    );
    await page.locator(".project-more").first().click();
    const afterCollapse = await page.evaluate(() => {
      const group = Array.from(document.querySelectorAll(".project-group")).find((item) => item.querySelector(".project-more"));
      return { rows: group?.querySelectorAll(".thread-item").length ?? -1 };
    });
    // Expanding with no way back is its own trap.
    check("and collapses again", afterCollapse.rows === 6, JSON.stringify(afterCollapse));
    // Tooling writes sessions into folders of its own, and which those are
    // differs per machine, so the sidebar has to be told rather than guess.
    await page.locator(".project-group", { hasText: "drawer-workspace" }).locator(".project-hide").click();
    const afterHide = await page
      .waitForFunction(
        () => {
          const headings = Array.from(document.querySelectorAll(".project-group:not(.hidden-projects) .project-name")).map((n) => n.textContent?.trim() || "");
          if (headings.some((text) => text === "drawer-workspace")) return null;
          return {
            headings,
            hiddenSection: document.querySelector(".hidden-projects .project-name")?.textContent?.trim() || "",
            restoreRows: document.querySelectorAll(".hidden-project").length,
          };
        },
        null,
        { timeout: 4000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    check(
      "hiding a project drops it from the list and offers a way back",
      afterHide?.hiddenSection?.includes("非表示のプロジェクト") && afterHide.restoreRows === 1,
      JSON.stringify(afterHide),
    );
    await page.locator(".hidden-project").click();
    const afterRestore = await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".project-group:not(.hidden-projects) .project-name")).some((n) => n.textContent?.trim() === "drawer-workspace")
            ? { hiddenRows: document.querySelectorAll(".hidden-project").length }
            : null,
        null,
        { timeout: 4000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    check("restoring puts the project back and clears the section", afterRestore?.hiddenRows === 0, JSON.stringify(afterRestore));
    // Picking a session back up on the PC needs both the id and the folder it
    // belongs to, so the row hands over the whole command rather than the id.
    const resumeCopy = await page.evaluate(() => {
      const rowFor = (title) =>
        Array.from(document.querySelectorAll(".thread-item")).find((item) => item.querySelector(".thread-title")?.textContent?.includes(title));
      const claudeRow = rowFor("Drawer and composer tuning");
      return {
        command: claudeRow?.querySelector(".thread-resume-copy")?.title || "",
        label: claudeRow?.querySelector(".thread-resume-copy")?.getAttribute("aria-label") || "",
        // Codex sessions are not resumed with this command, so they get no button.
        codexButtons: rowFor("Artifact preview polish")?.querySelectorAll(".thread-resume-copy").length ?? -1,
      };
    });
    check(
      "a Claude row offers the command that reopens it on the PC",
      /^cd \S*drawer-workspace && claude --resume thread-drawer$/.test(resumeCopy.command) &&
        resumeCopy.label.includes("コピー") &&
        resumeCopy.codexButtons === 0,
      JSON.stringify(resumeCopy),
    );
    // The row is a grid, so a column the button does not fit into silently
    // wraps it onto a second line instead of overflowing visibly.
    const copyButtonPlacement = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".thread-item")).find((item) => item.querySelector(".thread-resume-copy"));
      if (!row) return null;
      const rowBox = row.getBoundingClientRect();
      const button = row.querySelector(".thread-resume-copy").getBoundingClientRect();
      const title = row.querySelector(".thread-title").getBoundingClientRect();
      return {
        rowHeight: Math.round(rowBox.height),
        sameLine: button.top < title.bottom && button.bottom > title.top,
        atEnd: Math.round(rowBox.right - button.right) <= 12,
        tall: Math.round(button.height) >= 28,
      };
    });
    check(
      "the copy button sits on the row rather than wrapping below it",
      copyButtonPlacement?.sameLine && copyButtonPlacement.atEnd && copyButtonPlacement.tall,
      JSON.stringify(copyButtonPlacement),
    );
    const selectedBeforeCopy = await page.evaluate(() => document.querySelector("#threadTitle")?.textContent?.trim() || "");
    await page.locator(".thread-item", { hasText: "Drawer and composer tuning" }).locator(".thread-resume-copy").click();
    const copyFeedback = await page
      .waitForFunction(
        () => {
          // Newest toast: earlier ones are still on screen from bridge switching.
          const toasts = document.querySelectorAll(".toast");
          const toast = toasts[toasts.length - 1]?.textContent?.trim() || "";
          return toast.includes("コピー") ? { toast, title: document.querySelector("#threadTitle")?.textContent?.trim() || "" } : null;
        },
        null,
        { timeout: 4000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => ({ toast: "", title: "" }));
    check(
      "copying reports back without opening the chat",
      copyFeedback.toast.includes("コピーしました") && copyFeedback.title === selectedBeforeCopy,
      JSON.stringify({ ...copyFeedback, selectedBeforeCopy }),
    );
    if (wantShots) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, "sidebar.png") });
    }
    await page.locator(".project-group", { hasText: "drawer-workspace" }).locator(".project-new-thread").click();
    await page.waitForFunction(() => window.__mockWebSocketUrls?.some((url) => url.includes("fresh=1") && url.includes("drawer-workspace")));
    const crossRepoCreate = await page.evaluate((expectedWorkdir) => {
      const target = [...(window.__mockWebSocketUrls || [])].reverse().find((url) => url.includes("fresh=1") && url.includes("drawer-workspace")) || "";
      const parsed = new URL(target);
      return {
        fresh: parsed.searchParams.get("fresh"),
        workdir: parsed.searchParams.get("workdir"),
      };
    }, drawerRepo);
    check(
      "cross-repo new-thread button keeps the target workdir",
      crossRepoCreate.fresh === "1" && crossRepoCreate.workdir === drawerRepo,
      JSON.stringify(crossRepoCreate),
    );
    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(120);
    await page.locator(".thread-item", { hasText: "Drawer and composer tuning" }).locator(".thread-select").click();
    await page.waitForFunction(() => window.__mockWebSocketUrls?.some((url) => url.includes("thread-drawer")));
    const unregisteredRepoNavigation = await page.evaluate((expectedWorkdir) => {
      const target = [...(window.__mockWebSocketUrls || [])].reverse().find((url) => url.includes("thread-drawer")) || "";
      const parsed = new URL(target);
      return {
        thread: parsed.searchParams.get("thread"),
        workdir: parsed.searchParams.get("workdir"),
        host: parsed.host,
        workspaceRepo: document.querySelector("#workspaceRepo")?.textContent?.trim() || "",
        bridgePill: document.querySelector("#bridgePillLabel")?.textContent?.trim() || "",
        mismatchHidden: document.querySelector("#contextMismatch")?.classList.contains("hidden"),
      };
    }, drawerRepo);
    check(
      "cross-repo existing thread without a matching bridge still carries the target workdir",
      unregisteredRepoNavigation.thread === "thread-drawer" &&
        unregisteredRepoNavigation.workdir === drawerRepo &&
        unregisteredRepoNavigation.workspaceRepo === "drawer-workspace" &&
        unregisteredRepoNavigation.bridgePill === "drawer-workspace" &&
        unregisteredRepoNavigation.mismatchHidden === true,
      JSON.stringify(unregisteredRepoNavigation),
    );
    await page.waitForTimeout(650);
    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(120);
    const retainedLocalThread = await page.locator(".thread-item", { hasText: "Mobile terminal compact polish" }).count();
    const retainedThreadListText = retainedLocalThread ? "" : (await page.locator("#threadList").innerText()).replace(/\s+/g, " ").slice(0, 360);
    check(
      "previous local-only thread remains visible after switching threads",
      retainedLocalThread >= 1,
      retainedThreadListText,
    );
    const retainedLocalThreadOrder = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll(".project-group:not(.current-thread-group)"));
      const codexGroup = groups.find((group) => group.querySelector(".project-name")?.textContent?.trim() === "codex-remote-control-lab");
      return Array.from(codexGroup?.querySelectorAll(".thread-title") || []).map((item) => item.textContent?.trim() || "");
    });
    check(
      "previously opened local thread is promoted within its repo immediately",
      retainedLocalThreadOrder[0] === "Mobile terminal compact polish",
      JSON.stringify(retainedLocalThreadOrder.slice(0, 4)),
    );
    await page.locator(".thread-item", { hasText: "Artifact preview polish" }).locator(".thread-select").click();
    await page.waitForFunction(() => window.__mockWebSocketUrls?.some((url) => url.includes("thread-artifacts")));
    const crossRepoNavigation = await page.evaluate((expectedWorkdir) => {
      const target = [...(window.__mockWebSocketUrls || [])].reverse().find((url) => url.includes("thread-artifacts")) || "";
      const parsed = new URL(target);
      return {
        thread: parsed.searchParams.get("thread"),
        workdir: parsed.searchParams.get("workdir"),
        host: parsed.host,
      };
    }, artifactRepo);
    check(
      "cross-repo thread selection switches to the target bridge and workdir",
      crossRepoNavigation.thread === "thread-artifacts" &&
        crossRepoNavigation.workdir === artifactRepo &&
        crossRepoNavigation.host === "127.0.0.1:45224",
      JSON.stringify(crossRepoNavigation),
    );
    await page.waitForFunction(() => document.querySelector("#sidebarProjectName")?.textContent?.trim() === "artifact-workspace");
    await page.waitForTimeout(1300);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
    const selectedWorkspaceAfterFleetRefresh = await page.evaluate(() => ({
      sidebarProject: document.querySelector("#sidebarProjectName")?.textContent?.trim() || "",
      workspaceRepo: document.querySelector("#workspaceRepo")?.textContent?.trim() || "",
      fullPath: document.querySelector("#workspaceIndicator")?.dataset.fullPath || "",
      bridgePill: document.querySelector("#bridgePillLabel")?.textContent?.trim() || "",
      mismatchHidden: document.querySelector("#contextMismatch")?.classList.contains("hidden"),
      mismatchText: document.querySelector("#contextMismatch")?.innerText || "",
      mismatchTitle: document.querySelector("#contextMismatch")?.getAttribute("title") || "",
    }));
    check(
      "fleet refresh keeps selected Agent cwd and matching bridge",
      selectedWorkspaceAfterFleetRefresh.sidebarProject === "artifact-workspace" &&
        selectedWorkspaceAfterFleetRefresh.workspaceRepo === "artifact-workspace" &&
        selectedWorkspaceAfterFleetRefresh.fullPath === artifactRepo &&
        selectedWorkspaceAfterFleetRefresh.bridgePill === "artifact-workspace",
      JSON.stringify(selectedWorkspaceAfterFleetRefresh),
    );
    check(
      "repo mismatch warning hides after auto-switching to the matching bridge",
      selectedWorkspaceAfterFleetRefresh.mismatchHidden === true,
      JSON.stringify(selectedWorkspaceAfterFleetRefresh),
    );
    await page.evaluate(() => {
      document.body.classList.remove("show-sidebar");
      document.querySelector("#mobileThreads")?.setAttribute("aria-expanded", "false");
    });
    await page.waitForTimeout(120);

    // Drawer edge swipe. A real touch keeps the element it started on for the
    // whole gesture, so both events go to that one target - the drawer swipe and
    // the chat-switch swipe listen on different nodes and the conflict between
    // them only shows up when the events travel the way the browser sends them.
    const edgeSwipe = async (fromX, toX, y = 420) =>
      page.evaluate(
        ({ fromX, toX, y }) => {
          const target = document.elementFromPoint(fromX, y) || document.body;
          const dispatch = (type, x) => {
            const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
            target.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: type === "touchend" ? [] : [touch],
                changedTouches: [touch],
              }),
            );
          };
          dispatch("touchstart", fromX);
          dispatch("touchend", toX);
        },
        { fromX, toX, y },
      );

    const socketsBeforeSwipe = await page.evaluate(() => (window.__mockWebSocketUrls || []).length);
    await edgeSwipe(6, 30);
    await page.waitForTimeout(120);
    const afterShortSwipe = await page.evaluate((before) => ({
      sidebarVisible: document.body.classList.contains("show-sidebar"),
      newSockets: (window.__mockWebSocketUrls || []).length - before,
    }), socketsBeforeSwipe);
    check(
      "a short drag from the edge leaves the drawer closed",
      afterShortSwipe.sidebarVisible === false,
      JSON.stringify(afterShortSwipe),
    );
    check(
      "a drag from the edge never falls through to the chat-switch swipe",
      afterShortSwipe.newSockets === 0,
      JSON.stringify(afterShortSwipe),
    );
    await edgeSwipe(6, 180);
    await page.waitForTimeout(250);
    const afterEdgeSwipe = await page.evaluate((before) => ({
      sidebarVisible: document.body.classList.contains("show-sidebar"),
      expanded: document.querySelector("#mobileThreads")?.getAttribute("aria-expanded") || "",
      drawerLeft: Math.round(document.querySelector("#threadSidebar")?.getBoundingClientRect().left ?? -999),
      newSockets: (window.__mockWebSocketUrls || []).length - before,
    }), socketsBeforeSwipe);
    check(
      "swiping in from the left edge opens the drawer",
      afterEdgeSwipe.sidebarVisible === true && afterEdgeSwipe.drawerLeft === 0,
      JSON.stringify(afterEdgeSwipe),
    );
    check(
      "the edge swipe leaves the drawer button reporting its open state",
      afterEdgeSwipe.expanded === "true",
      JSON.stringify(afterEdgeSwipe),
    );
    check(
      "opening the drawer by swipe does not also change the chat behind it",
      afterEdgeSwipe.newSockets === 0,
      JSON.stringify(afterEdgeSwipe),
    );
    // The switcher under the current-bridge card lists where you can go, not
    // where you already are. Repeating the active bridge there put the same
    // connection on screen twice under the same name.
    const fleetRows = await page.evaluate(() => ({
      current: document.querySelector("#fleetCurrentLabel")?.textContent?.trim() || "",
      rows: [...document.querySelectorAll("#bridgeFleetList .bridge-fleet-row strong")].map((el) => el.textContent.trim()),
      registered: JSON.parse(localStorage.getItem("codexPhoneBridgeRegistry:v1") || "{}").bridges?.length || 0,
    }));
    check(
      "the bridge switcher does not repeat the bridge already shown above it",
      fleetRows.rows.length === fleetRows.registered - 1 && !fleetRows.rows.includes(fleetRows.current),
      JSON.stringify(fleetRows),
    );
    check(
      "no bridge is listed under the sidebar's own heading text",
      !fleetRows.rows.includes("現在の接続先") && fleetRows.current !== "現在の接続先",
      JSON.stringify(fleetRows),
    );

    // A badge tone written as a bare state word is a global class: `.approval`
    // is the chat's full-width approval card, and it reshaped every badge
    // wearing that word - same digit, different box, different height.
    const badgeBoxes = await page.evaluate(() => {
      const host = document.createElement("span");
      host.className = "fleet-current-badges";
      host.style.cssText = "position:fixed;top:0;left:0";
      for (const tone of ["running", "approval"]) {
        const badge = document.createElement("span");
        badge.className = `fleet-badge fleet-badge-${tone}`;
        badge.textContent = "1";
        host.appendChild(badge);
      }
      document.body.appendChild(host);
      const [a, b] = [...host.children].map((el) => el.getBoundingClientRect());
      host.remove();
      return {
        widths: [Math.round(a.width), Math.round(b.width)],
        heights: [Math.round(a.height), Math.round(b.height)],
        sameTop: Math.round(a.top) === Math.round(b.top),
      };
    });
    check(
      "count badges of different tones share one box",
      badgeBoxes.widths[0] === badgeBoxes.widths[1] && badgeBoxes.heights[0] === badgeBoxes.heights[1] && badgeBoxes.sameTop,
      JSON.stringify(badgeBoxes),
    );
    const bareToneClasses = await page.evaluate(() => {
      const states = ["approval", "running", "error", "syncing", "question", "diff", "done", "recent"];
      return [...document.querySelectorAll(".fleet-badge, .thread-status-badge")]
        .map((el) => [...el.classList].filter((name) => states.includes(name)))
        .filter((hits) => hits.length)
        .flat();
    });
    check(
      "badge tones are namespaced instead of borrowing a global class name",
      bareToneClasses.length === 0,
      JSON.stringify(bareToneClasses),
    );

    // Beside the drawer, not through it: the scrim covers the whole screen, so
    // its centre sits under the panel it is there to dismiss.
    await page.locator("#sidebarScrim").click({ position: { x: 370, y: 500 } });
    await page.waitForTimeout(250);
    check(
      "the drawer opened by swipe closes again from the scrim",
      (await page.evaluate(() => document.body.classList.contains("show-sidebar"))) === false,
    );
    await page.locator("#bridgePill").click();
    await page.waitForTimeout(180);
    await edgeSwipe(6, 180);
    await page.waitForTimeout(250);
    const swipeUnderSheet = await page.evaluate(() => ({
      sheetHidden: document.querySelector("#bridgeFleetSheet")?.classList.contains("hidden"),
      sidebarVisible: document.body.classList.contains("show-sidebar"),
    }));
    check(
      "the edge swipe holds back while a sheet is covering the drawer",
      swipeUnderSheet.sheetHidden === false && swipeUnderSheet.sidebarVisible === false,
      JSON.stringify(swipeUnderSheet),
    );
    await page.locator("#closeBridgeFleet").click();
    await page.waitForTimeout(180);

    if (wantShots) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, "chat.png") });
    }

    // Codex / Terminal switch still works.
    await page.locator("#terminalViewButton").click();
    await page.waitForTimeout(250);
    check("terminal view activates", (await page.locator("#mainTerminalView:not(.hidden)").count()) === 1);
    check("terminal command input is available", (await page.locator("#terminalCommandInput").count()) === 1);
    const terminalCompactState = await page.evaluate(() => {
      const nav = document.querySelector(".thread-nav");
      const input = document.querySelector("#terminalCommandInput");
      const titlebar = document.querySelector(".titlebar");
      const composer = document.querySelector("#composer");
      return {
        navDisplay: nav ? getComputedStyle(nav).display : "",
        inputFontSize: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
        titlebarAreas: titlebar ? getComputedStyle(titlebar).gridTemplateAreas : "",
        composerDisplay: composer ? getComputedStyle(composer).display : "",
        transcriptText: document.querySelector("#terminalTranscript")?.innerText || "",
      };
    });
    check(
      "terminal phone header does not stack thread arrows under the drawer button",
      terminalCompactState.navDisplay === "none" && !terminalCompactState.titlebarAreas.includes("nav"),
      JSON.stringify(terminalCompactState),
    );
    check(
      "terminal command input uses an iOS-safe font size",
      terminalCompactState.inputFontSize >= 16,
      JSON.stringify(terminalCompactState),
    );
    check("terminal view hides the chat composer", terminalCompactState.composerDisplay === "none", JSON.stringify(terminalCompactState));
    check(
      "terminal view does not show chat status logs before manual commands",
      !terminalCompactState.transcriptText.includes("前回完了") && /@\S+\s+\S+\s+%/.test(terminalCompactState.transcriptText),
      JSON.stringify(terminalCompactState),
    );
    const terminalKeyboardLayout = await page.evaluate(() => {
      const keyboard = 336;
      const visible = window.innerHeight - keyboard;
      document.querySelector("#terminalCommandInput")?.focus();
      document.documentElement.style.setProperty("--visual-viewport-height", `${visible}px`);
      document.documentElement.style.setProperty("--app-viewport-height", `${visible}px`);
      document.documentElement.style.setProperty("--keyboard-inset", `${keyboard}px`);
      document.body.classList.add("keyboard-open", "terminal-command-focused");
      window.scrollTo(0, 0);
      const shell = document.querySelector(".app-shell").getBoundingClientRect();
      const terminal = document.querySelector("#mainTerminalView").getBoundingClientRect();
      const form = document.querySelector("#terminalCommandForm").getBoundingClientRect();
      return {
        visible,
        shellBottom: Math.round(shell.bottom),
        terminalBottom: Math.round(terminal.bottom),
        formBottom: Math.round(form.bottom),
        gapBelowTerminal: Math.round(visible - terminal.bottom),
        gapBelowForm: Math.round(visible - form.bottom),
      };
    });
    check(
      "terminal command input stays attached above the keyboard",
      terminalKeyboardLayout.formBottom <= terminalKeyboardLayout.visible + 2 && Math.abs(terminalKeyboardLayout.gapBelowTerminal) <= 8,
      JSON.stringify(terminalKeyboardLayout),
    );
    await page.evaluate(() => {
      document.body.classList.remove("keyboard-open", "terminal-command-focused");
      document.documentElement.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
      document.documentElement.style.setProperty("--visual-viewport-height", `${window.innerHeight}px`);
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
    });
    await page.locator("#terminalCommandInput").fill("pwd");
    await page.locator("#terminalCommandRun").click();
    await page.waitForTimeout(220);
    const terminalText = await page.locator("#terminalTranscript").innerText();
    check("terminal command runs from the selected bridge workdir", terminalText.includes("$ pwd") && terminalText.includes(artifactRepo), terminalText.slice(-400));
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

    // Last on purpose: a restart that goes through reloads the page 1.8s later,
    // which would pull the ground out from under anything checked after it.
    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(180);
    const restartInDrawer = await page.evaluate(() => {
      const button = document.querySelector("#sidebarRestartButton");
      const settings = document.querySelector("#settingsButton");
      if (!button || !settings) return null;
      const rect = button.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      return {
        insideDrawer: Boolean(button.closest("#threadSidebar")),
        width: Math.round(rect.width),
        onScreen: rect.left >= 0 && rect.right <= window.innerWidth,
        besideSettings: Math.abs(rect.top - settingsRect.top) <= 2 && rect.left >= settingsRect.right,
        // Bottom of the drawer, where a thumb already is - the point of moving it
        // out of the settings panel.
        withinThumbReach: rect.bottom > window.innerHeight * 0.6,
      };
    });
    check(
      "the drawer carries a restart button beside 設定",
      restartInDrawer?.insideDrawer && restartInDrawer.width > 0 && restartInDrawer.onScreen && restartInDrawer.besideSettings,
      JSON.stringify(restartInDrawer),
    );
    check(
      "the drawer restart button sits low enough to reach",
      restartInDrawer?.withinThumbReach === true,
      JSON.stringify(restartInDrawer),
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#sidebarRestartButton").click();
    await page.waitForTimeout(200);
    check("a dismissed confirm leaves the bridge running", restartCalls.length === 0, JSON.stringify(restartCalls));
    check(
      "a dismissed confirm hands the button back",
      (await page.evaluate(() => document.querySelector("#sidebarRestartButton")?.disabled)) === false,
    );
    let restartPrompt = "";
    page.once("dialog", (dialog) => {
      restartPrompt = dialog.message();
      dialog.accept();
    });
    await page.locator("#sidebarRestartButton").click();
    await page.waitForTimeout(300);
    check("confirming restarts the bridge the phone is talking to", restartCalls.length === 1, JSON.stringify(restartCalls));
    check("the confirm says what a restart costs before it happens", /切断/.test(restartPrompt), restartPrompt);

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
