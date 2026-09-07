// Two-machine smoke check for the sidebar.
//
// Sessions live on the Mac that ran them, so the phone reaches each Mac through
// its own bridge. This boots the static `public/` bundle against two mocked
// bridges on two different hosts and asserts the three things that make the
// merged list usable: both Macs' sessions are listed, every heading says which
// Mac it is on, and opening a row from the other Mac moves the connection
// there. It also pins the composer's model choice against the `ready` message
// that used to overwrite it on every reconnect.
//
// Run with `node scripts/fleet-machines-smoke.js`; pass `--shots` to also drop a
// screenshot of the two-machine sidebar into `.uploads/fleet-machines-smoke/`,
// which is the only way to check the machine colours by eye.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium, webkit } = require("playwright");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const token = "smoke-token";
const wantShots = process.argv.includes("--shots");
const shotsDir = path.join(root, ".uploads", "fleet-machines-smoke");
const airOrigin = "http://127.0.0.1:45999";
const airBridgeId = "air-bridge";
const sharedBuild = { schema: 1, available: true, head: "a".repeat(40), fingerprint: "b".repeat(64), dirty: false, restartRequired: false, upstream: { name: "origin/develop", ahead: 0, behind: 0 } };

// The mini and the Air keep the same folder names under different homes, which
// is exactly the collision the machine label has to resolve.
const miniRepo = "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab";
const miniHandover = "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/00_受け渡し";
const airRepo = "/Users/yujiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab-air";
const airHandover = "/Users/yujiro/WORK_LOCAL/00_MINI_WORKSPACE/00_受け渡し";

const miniThreads = [
  { id: "mini-1", name: "mini の作業", cwd: miniRepo, updatedAt: Date.now(), provider: "claude" },
  { id: "mini-2", name: "mini の受け渡し", cwd: miniHandover, updatedAt: Date.now() - 3_600_000, provider: "claude" },
];
const airThreads = [
  { id: "air-1", name: "Air の作業", cwd: airRepo, updatedAt: Date.now() - 600_000, provider: "claude" },
  { id: "air-2", name: "Air の受け渡し", cwd: airHandover, updatedAt: Date.now() - 7_200_000, provider: "claude" },
];

const mime = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
}

function isInsideDir(dir, target) {
  const relative = path.relative(dir, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
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

async function mockApi(page) {
  const state = { airBuild: sharedBuild, airOffline: false };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const headers = {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type, authorization, x-phone-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const fulfill = (body) => route.fulfill({ ...body, headers });
    const air = url.origin === airOrigin;
    const cwd = air ? airRepo : miniRepo;
    if (url.pathname === "/api/bridge/info") {
      if (air && state.airOffline) return route.abort();
      return fulfill({
        json: {
          id: air ? airBridgeId : "home",
          label: air ? "Air Claude" : "mini Claude",
          hostName: air ? "Yujiro-no-MacBook-Air.local" : "minijironoMac-mini.local",
          provider: "claude",
          model: air ? "opus" : "sonnet",
          repoRoot: cwd,
          cwd,
          workdir: cwd,
          branch: "develop",
          build: air ? state.airBuild : sharedBuild,
          uiPort: air ? 45214 : 45234,
        },
      });
    }
    if (url.pathname === "/api/threads") {
      return fulfill({
        json: { provider: "claude", activeProvider: "claude", data: air ? airThreads : miniThreads, hiddenProjects: [] },
      });
    }
    if (url.pathname === "/api/status") return fulfill({ json: { workdir: cwd, bridges: [] } });
    if (url.pathname === "/api/thread") return fulfill({ json: { threadId: url.searchParams.get("thread") || "mini-1", history: [] } });
    if (url.pathname === "/api/info") return fulfill({ json: { provider: "claude", model: air ? "opus" : "sonnet", workdir: cwd } });
    return fulfill({ json: { data: [] } });
  });
  return state;
}

async function seedBrowser(page) {
  await page.addInitScript(
    (payload) => {
      // The bridge protocol is not what this check is about; `ready` is, because
      // it is the message that used to take the composer's model back.
      class MockWebSocket extends EventTarget {
        constructor(url) {
          super();
          window.__wsUrls = window.__wsUrls || [];
          window.__wsUrls.push(String(url || ""));
          this.readyState = 0;
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "ready",
                  provider: "claude",
                  model: String(url).includes("45999") ? "opus" : "sonnet",
                  threadId: "",
                  history: [],
                }),
              }),
            );
          }, 10);
        }
        send() {}
        close() {}
      }
      MockWebSocket.OPEN = 1;
      window.WebSocket = MockWebSocket;
      localStorage.setItem("codexPhoneThreadInboxFilter:v1", "recent");
      localStorage.setItem(
        "codexPhoneBridgeRegistry:v1",
        JSON.stringify({
          version: 1,
          bridges: [
            { id: payload.airBridgeId, label: "Air Claude", baseUrl: payload.airOrigin, port: 45214, status: "connected", rememberToken: true },
          ],
        }),
      );
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ [payload.airBridgeId]: payload.token }));
    },
    { airBridgeId, airOrigin, token },
  );
}

async function run() {
  const { server, origin } = await startServer();
  let browser;
  try {
    browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch();
    // The network-pass-through worker otherwise takes requests outside route
    // mocks after activation in WebKit; these bridges are deliberately fake.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
    const browserErrors = [];
    page.on("console", msg => { if (msg.type() === "error") browserErrors.push(msg.text()); });
    page.on("requestfailed", req => browserErrors.push(`${req.method()} ${req.url()}: ${req.failure()?.errorText}`));
    await seedBrowser(page);
    const apiState = await mockApi(page);
    await page.goto(`${origin}/?token=${token}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(1500);
    if (wantShots) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: path.join(shotsDir, "sidebar-two-machines.png") });
    }

    const groups = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".project-group:not(.hidden-projects)")).map((group) => {
        const chip = group.querySelector(".project-machine");
        return {
          name: group.querySelector(".project-name")?.textContent?.trim() || "",
          machine: chip?.textContent?.trim() || "",
          accent: chip?.dataset.machine || "",
          color: chip ? getComputedStyle(chip).color : "",
          rows: Array.from(group.querySelectorAll(".thread-title")).map((node) => node.textContent.trim()),
        };
      }),
    );
    check("matching shared builds do not crowd the mobile sidebar", await page.locator("#bridgeBuildNotice").isHidden());

    const titles = groups.flatMap((group) => group.rows);
    check("the Air's sessions are listed next to the mini's", titles.includes("Air の作業") && titles.includes("mini の作業"), titles.join(" / "));
    check(
      "every heading says which Mac it is on",
      groups.length > 0 && groups.every((group) => group.machine),
      groups.map((group) => `${group.machine}:${group.name}`).join(" / "),
    );
    const handover = groups.filter((group) => group.name === "00_受け渡し");
    check(
      "one folder name on two Macs is two headings, not one",
      handover.length === 2 && new Set(handover.map((group) => group.machine)).size === 2,
      handover.map((group) => `${group.machine}:${group.name}(${group.rows.length})`).join(" / "),
    );

    // The label is read at a glance by colour before it is read as a word.
    const accents = new Map(groups.map((group) => [group.machine, group]));
    const miniChip = accents.get("mini");
    const airChip = accents.get("Air");
    check(
      "each Mac's label carries that Mac's own colour",
      miniChip?.accent === "mini" && airChip?.accent === "air" && miniChip.color !== airChip.color,
      `mini=${miniChip?.accent}/${miniChip?.color} air=${airChip?.accent}/${airChip?.color}`,
    );

    // Chosen here, on a bridge whose own model is `sonnet`, and read back after
    // switching to a bridge whose own model is `opus`.
    await page.evaluate(() => document.body.classList.remove("show-sidebar"));
    await page.waitForTimeout(300);
    await page.locator("#modelButton").click();
    await page.waitForTimeout(300);
    const modelBefore = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("[data-model-choice]")).find((item) => item.dataset.modelChoice === "haiku");
      row.click();
      return document.querySelector("#modelButton").textContent.trim();
    });
    await page.waitForTimeout(300);

    await page.locator("#mobileThreads").click();
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".thread-item")).find((item) => item.textContent.includes("Air の作業"));
      row.querySelector(".thread-select").click();
    });
    await page.waitForTimeout(1500);

    const wsUrls = await page.evaluate(() => window.__wsUrls || []);
    const lastUrl = String(wsUrls.at(-1) || "");
    check(
      "opening an Air session moves the connection to the Air",
      lastUrl.includes("45999") && lastUrl.includes(encodeURIComponent(airRepo)),
      lastUrl,
    );

    const modelAfter = await page.evaluate(() => document.querySelector("#modelButton").textContent.trim());
    check(
      "the chosen model survives the reconnect that follows",
      modelBefore.startsWith("haiku") && modelAfter.startsWith("haiku"),
      `${modelBefore} -> ${modelAfter}`,
    );

    await page.locator("#mobileThreads").click();
    if (await page.locator("#sidebarConnectionsToggle").getAttribute("aria-expanded") === "true") {
      await page.locator("#sidebarConnectionsToggle").click();
    }
    const refreshAir = async () => {
      await page.waitForFunction(() => !getBridgeState("air-bridge").refreshing);
      await page.evaluate(() => refreshBridgeState("air-bridge", { force: true }));
    };
    const notice = page.locator("#bridgeBuildNotice");
    apiState.airBuild = { ...sharedBuild, fingerprint: "c".repeat(64), dirty: true };
    await refreshAir();
    check("same-commit unshared UI changes stay visible with connections folded",
      await notice.isVisible() && /版が異なります/.test(await notice.innerText())
      && /Air.*未共有/.test(await notice.innerText()) && await page.locator("#sidebarConnections").isHidden(),
      await page.evaluate(() => JSON.stringify({ text: document.querySelector("#bridgeBuildNotice").textContent, error: getBridgeState("air-bridge").lastError })));
    apiState.airBuild = { ...sharedBuild, restartRequired: true };
    await refreshAir();
    check("updated files with an old running server warn about restart", /Air.*再起動待ち/.test(await notice.innerText()));
    apiState.airBuild = null;
    await refreshAir();
    check("an old server without build metadata is unknown, not synchronized", /Air.*確認できません/.test(await notice.innerText()));
    apiState.airBuild = sharedBuild;
    await refreshAir();
    apiState.airOffline = true;
    await refreshAir();
    check("a disconnected peer cannot keep a cached synchronized claim", await notice.isVisible() && /Air.*確認できません/.test(await notice.innerText()));
    apiState.airOffline = false;
    await refreshAir();
    check("rechecking matching builds clears the warning", await notice.isHidden());
    await page.locator("#sidebarConnectionsToggle").click();
    check("app identity is separate from selected workspace metadata",
      /アプリ aaaaaaa/.test(await page.locator("#fleetCurrentBuild").innerText())
      && /作業場所:/.test(await page.locator("#fleetCurrentMeta").innerText()));
    if (checks.some(result => !result.ok)) console.error(browserErrors.join("\n"));

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
  console.log(`\n${checks.length - failed}/${checks.length} checks passed${wantShots ? ` — screenshot in ${path.relative(root, shotsDir)}` : ""}`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
