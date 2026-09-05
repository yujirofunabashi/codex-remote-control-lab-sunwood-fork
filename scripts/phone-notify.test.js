const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bridgeUrls,
  tokenNeedsUrlEncoding,
  eventNotificationMessage,
  notificationTargets,
  notifyBridgeUrls,
  notifyEvent,
  notifyTaskEvent,
  redactNotificationText,
  startupTokenUrlsEnabled,
  stripTokenFromUrl,
  taskNotificationMessage,
} = require("./phone-notify");

test("bridgeUrls builds tokenized LAN URLs", () => {
  assert.deepEqual(bridgeUrls(["192.168.11.8", "10.0.0.12"], 45214, "secret"), [
    "http://192.168.11.8:45214/?token=secret",
    "http://10.0.0.12:45214/?token=secret",
  ]);
});

test("notificationTargets stays empty without opt-in environment variables", () => {
  assert.deepEqual(notificationTargets({}), []);
});

test("a notification setting can be written per slot, the way the rest of a fleet's env is", () => {
  // Two bridges share one `.env`, so every other setting there is suffixed with
  // the slot's port. These were read as bare keys only, and a webhook written
  // the way the rest of the file is written notified nobody.
  const env = {
    PHONE_UI_PORT: "46214",
    PHONE_DISCORD_WEBHOOK_URL_46214: "https://discord.com/api/webhooks/codex",
    PHONE_DISCORD_WEBHOOK_URL_45214: "https://discord.com/api/webhooks/claude",
  };
  assert.deepEqual(notificationTargets(env), [{ type: "discord", webhookUrl: "https://discord.com/api/webhooks/codex" }]);
  assert.deepEqual(notificationTargets({ ...env, PHONE_UI_PORT: "45214" }), [
    { type: "discord", webhookUrl: "https://discord.com/api/webhooks/claude" },
  ]);
});

test("a bare notification setting still covers every slot", () => {
  const shared = { PHONE_NTFY_TOPIC: "codex-phone" };
  assert.equal(notificationTargets({ ...shared, PHONE_UI_PORT: "45214" })[0].topic, "codex-phone");
  assert.equal(notificationTargets({ ...shared, PHONE_UI_PORT: "46214" })[0].topic, "codex-phone");
  // A slot key outranks it, so one bridge can be sent somewhere else.
  assert.equal(notificationTargets({ ...shared, PHONE_UI_PORT: "46214", PHONE_NTFY_TOPIC_46214: "codex-only" })[0].topic, "codex-only");
});

test("notifyBridgeUrls posts to configured ntfy topic", async () => {
  const requests = [];
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_NTFY_TOPIC: "codex-phone", PHONE_NTFY_SERVER: "https://ntfy.example", PHONE_NTFY_TOKEN: "tok" },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(results, [{ type: "ntfy", ok: true }]);
  assert.equal(requests[0].url, "https://ntfy.example/codex-phone");
  assert.equal(requests[0].options.method, "POST");
  assert.ok(requests[0].options.signal);
  assert.equal(requests[0].options.headers.authorization, "Bearer tok");
  assert.match(requests[0].options.body, /スマホブリッジを起動しました/);
});

test("notifyBridgeUrls rejects non-https ntfy servers", async () => {
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_NTFY_TOPIC: "codex-phone", PHONE_NTFY_SERVER: "http://ntfy.example" },
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, "ntfy");
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /must use https/);
});

test("notifyBridgeUrls posts to configured Pushover account", async () => {
  const requests = [];
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_PUSHOVER_TOKEN: "app", PHONE_PUSHOVER_USER: "user", PHONE_PUSHOVER_DEVICE: "iphone" },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(results, [{ type: "pushover", ok: true }]);
  assert.equal(requests[0].url, "https://api.pushover.net/1/messages.json");
  assert.equal(requests[0].options.method, "POST");
  assert.ok(requests[0].options.signal);
  assert.equal(requests[0].options.body.get("token"), "app");
  assert.equal(requests[0].options.body.get("user"), "user");
  assert.equal(requests[0].options.body.get("device"), "iphone");
});

test("notifyBridgeUrls omits provider link fields without a LAN URL", async () => {
  const requests = [];
  const results = await notifyBridgeUrls([], {
    env: {
      PHONE_NTFY_TOPIC: "codex-phone",
      PHONE_NTFY_SERVER: "https://ntfy.example",
      PHONE_PUSHOVER_TOKEN: "app",
      PHONE_PUSHOVER_USER: "user",
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(results, [
    { type: "ntfy", ok: true },
    { type: "pushover", ok: true },
  ]);
  assert.equal(requests[0].options.headers.click, undefined);
  assert.match(requests[0].options.body, /LAN内のURLを検出できませんでした/);
  assert.equal(requests[1].options.body.has("url"), false);
  assert.equal(requests[1].options.body.has("url_title"), false);
  assert.match(requests[1].options.body.get("message"), /LAN内のURLを検出できませんでした/);
});

test("notifyBridgeUrls posts to configured Discord webhook", async () => {
  const requests = [];
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    },
  });

  assert.deepEqual(results, [{ type: "discord", ok: true }]);
  assert.equal(requests[0].url, "https://discord.com/api/webhooks/123/abc");
  assert.equal(requests[0].options.method, "POST");
  assert.ok(requests[0].options.signal);
  assert.equal(requests[0].options.headers["content-type"], "application/json");
  assert.match(JSON.parse(requests[0].options.body).content, /スマホブリッジを起動しました/);
  assert.deepEqual(JSON.parse(requests[0].options.body).allowed_mentions, { parse: [] });
});

// A startup message posts on every restart, and the channel it posts to keeps
// its history. A tokenized URL there is the whole fleet's key, because a bridge
// serves the registry backup, so the token has to be asked for rather than
// assumed.
test("the startup message carries a token only when the operator opts in", () => {
  assert.equal(startupTokenUrlsEnabled({}), false);
  assert.equal(startupTokenUrlsEnabled({ PHONE_NOTIFY_STARTUP_TOKEN_URLS: "" }), false);
  assert.equal(startupTokenUrlsEnabled({ PHONE_NOTIFY_STARTUP_TOKEN_URLS: "0" }), false);
  assert.equal(startupTokenUrlsEnabled({ PHONE_NOTIFY_STARTUP_TOKEN_URLS: "1" }), true);
  assert.equal(startupTokenUrlsEnabled({ PHONE_NOTIFY_STARTUP_TOKEN_URLS: "true" }), true);
  // Two bridges share one `.env`, so this reads per slot like every other
  // notification setting.
  assert.equal(startupTokenUrlsEnabled({ PHONE_UI_PORT: "45214", PHONE_NOTIFY_STARTUP_TOKEN_URLS_45214: "on" }), true);
  assert.equal(startupTokenUrlsEnabled({ PHONE_UI_PORT: "45224", PHONE_NOTIFY_STARTUP_TOKEN_URLS_45214: "on" }), false);
});

test("notifyTaskEvent posts a Discord completion notification", async () => {
  const requests = [];
  const results = await notifyTaskEvent(
    {
      status: "completed",
      provider: "codex",
      threadId: "thread-123",
      turnId: "turn-456",
      model: "gpt-5.4",
      workdir: "/tmp/demo",
      url: "http://100.64.0.1:45214/?token=secret&thread=thread-123",
    },
    {
      env: { PHONE_NOTIFY_EVENTS: "1", PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 204 };
      },
    },
  );

  assert.deepEqual(results, [{ type: "discord", ok: true }]);
  assert.equal(requests[0].url, "https://discord.com/api/webhooks/123/abc");
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.content, /Codex：ターン完了/);
  assert.match(body.content, /スレッド: thread-123/);
  assert.match(body.content, /http:\/\/100\.64\.0\.1:45214/);
  assert.doesNotMatch(body.content, /secret/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("notifyTaskEvent is quiet unless event notifications are enabled", async () => {
  const results = await notifyTaskEvent(
    { status: "completed", provider: "codex", threadId: "thread-123" },
    {
      env: { PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" },
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    },
  );

  assert.deepEqual(results, []);
});

test("notifyTaskEvent can force completion notifications for configured providers", async () => {
  const requests = [];
  const results = await notifyTaskEvent(
    { status: "completed", provider: "codex", threadId: "thread-123" },
    {
      env: { PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" },
      force: true,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 204 };
      },
    },
  );

  assert.deepEqual(results, [{ type: "discord", ok: true }]);
  assert.equal(requests.length, 1);
  assert.match(JSON.parse(requests[0].options.body).content, /Codex：ターン完了/);
});

test("notifyEvent dedupes and strips tokenized URLs", async () => {
  const requests = [];
  const env = {
    PHONE_NOTIFY_EVENTS: "1",
    PHONE_NOTIFY_EVENT_DEDUPE_MS: "10000",
    PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
  };
  const event = {
    type: "approval_required",
    title: "承認待ち",
    message: "npm test の承認待ちです",
    threadId: "thread-123",
    url: "http://100.64.0.1:45214/?token=secret&thread=thread-123",
  };

  const first = await notifyEvent(event, {
    env,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    },
  });
  const second = await notifyEvent(event, {
    env,
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.deepEqual(first, [{ type: "discord", ok: true }]);
  assert.deepEqual(second, []);
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.content, /approval_required/);
  assert.doesNotMatch(body.content, /secret|token=/);
});

test("notifyEvent redacts tokenized URLs from event message text", async () => {
  const requests = [];
  await notifyEvent(
    {
      type: "connection_lost",
      title: "Connection lost",
      message: "Reconnect at http://100.64.0.1:45214/?token=secret&thread=abc",
      threadId: "thread-redacted-message",
      url: "http://100.64.0.1:45214/?token=secret&thread=abc",
    },
    {
      env: {
        PHONE_NOTIFY_EVENTS: "1",
        PHONE_NOTIFY_EVENT_DEDUPE_MS: "0",
        PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
      },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 204 };
      },
    },
  );
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.content, /thread=abc/);
  assert.doesNotMatch(body.content, /secret|token=/);
});

test("taskNotificationMessage includes failure details", () => {
  assert.match(
    taskNotificationMessage({
      status: "failed",
      provider: "claude",
      threadId: "session-123",
      message: "process exited",
    }),
    /Claude：失敗[\s\S]*process exited/,
  );
});

test("a notification reads in the language the UI it links to is written in", () => {
  // It arrives on a phone and is read by a person. Only the identifiers stay as
  // they are - a thread id, a model name, the raw event type kept beside its
  // label so a search in the channel still has something to match.
  const message = eventNotificationMessage({
    type: "approval_required",
    title: "承認待ち",
    message: "Bash の承認待ちです",
    projectName: "codex-remote-control-lab-air",
    severity: "warning",
    createdAt: "2026-08-06T01:23:45.000Z",
    threadId: "session-123",
  });

  assert.match(message, /種別: 承認待ち \(approval_required\)/);
  assert.match(message, /重要度: 注意/);
  assert.match(message, /プロジェクト: codex-remote-control-lab-air/);
  assert.match(message, /スレッド: session-123/);
  assert.doesNotMatch(message, /Type:|Severity:|Created:|Project:|Thread:/);
  // The host's own clock, not an ISO timestamp in UTC.
  assert.doesNotMatch(message, /2026-08-06T01:23:45/);
  assert.match(message, new RegExp(`発生: ${new Date("2026-08-06T01:23:45.000Z").toLocaleString("ja-JP", { hour12: false }).replace(/[/]/g, "\\/")}`));
});

test("an event with no title of its own is still named in Japanese", () => {
  assert.match(eventNotificationMessage({ type: "long_running" }), /^長時間実行/);
  assert.match(eventNotificationMessage({ type: "turn_completed" }), /種別: ターン完了 \(turn_completed\)/);
});

test("taskNotificationMessage can include multiple task links", () => {
  const message = taskNotificationMessage({
    status: "approval",
    provider: "codex",
    urls: ["http://192.168.11.8:45214/?token=secret", "http://100.64.0.1:45214/?token=secret"],
    url: "http://192.168.11.8:45214/?token=secret",
  });

  assert.match(message, /リンク:/);
  assert.match(message, /http:\/\/192\.168\.11\.8:45214/);
  assert.match(message, /http:\/\/100\.64\.0\.1:45214/);
  assert.equal(message.match(/http:\/\//g).length, 2);
  assert.doesNotMatch(message, /secret|token=/);
});

test("notifyBridgeUrls rejects non-Discord webhook URLs", async () => {
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_DISCORD_WEBHOOK_URL: "https://example.com/webhook" },
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].type, "discord");
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Discord https webhook URL/);
});

test("event URL helpers remove local access keys", () => {
  assert.equal(stripTokenFromUrl("http://x.test/?token=secret&thread=abc"), "http://x.test/?thread=abc");
  assert.doesNotMatch(eventNotificationMessage({ type: "turn_completed", url: "http://x.test/?token=secret" }), /secret|token=/);
  assert.equal(redactNotificationText("open http://x.test/?token=secret&thread=abc"), "open http://x.test/?thread=abc");
});

test("notifyBridgeUrls reports provider HTTP failures without stopping startup", async () => {
  const results = await notifyBridgeUrls(["http://192.168.11.8:45214/?token=secret"], {
    env: { PHONE_PUSHOVER_TOKEN: "app", PHONE_PUSHOVER_USER: "user" },
    fetch: async () => ({ ok: false, status: 401 }),
  });

  assert.deepEqual(results, [{ type: "pushover", ok: false, error: "Pushover returned HTTP 401" }]);
});

// The Air bridge's token ended with a literal backslash and an `n` - a stray
// `printf '...\n'` when the file was written. Pasted into a URL raw, that is not
// the token any more, and a Home Screen icon added from such a link could never
// connect while the bridge beside it reported itself perfectly healthy.
test("a token that needs escaping still survives the URL it is pasted into", () => {
  const token = "-xhtPkRDaE4-nf1AZAkR9qTT\\n";
  const [url] = bridgeUrls(["192.168.1.63"], 45214, token);
  assert.equal(new URL(url).searchParams.get("token"), token);
  assert.doesNotMatch(new URL(url).search, /\\/);

  for (const awkward of ["a b", "a&b=c", "a#b", "a%b", "a+b"]) {
    const [built] = bridgeUrls(["10.0.0.1"], 45214, awkward);
    assert.equal(new URL(built).searchParams.get("token"), awkward, `token ${JSON.stringify(awkward)} did not survive`);
  }
});

test("the bridge can tell which tokens will not survive being copied by hand", () => {
  assert.equal(tokenNeedsUrlEncoding("-xhtPkRDaE4-nf1AZAkR9qTT\\n"), true);
  assert.equal(tokenNeedsUrlEncoding("a b"), true);
  assert.equal(tokenNeedsUrlEncoding("ogoURPoWqL0f4sMUeVkZdmb4"), false);
  assert.equal(tokenNeedsUrlEncoding(""), false);
});
