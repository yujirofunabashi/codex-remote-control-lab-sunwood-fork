const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bridgeUrls,
  eventNotificationMessage,
  notificationTargets,
  notifyBridgeUrls,
  notifyEvent,
  notifyTaskEvent,
  redactNotificationText,
  stripTokenFromUrl,
  taskNotificationMessage,
} = require("./phone-notify");

test("bridgeUrls builds tokenized LAN URLs", () => {
  assert.deepEqual(bridgeUrls(["192.168.11.8", "10.0.0.12"], 45214, "secret"), [
    "http://192.168.11.8:45214/?token=secret",
    "http://10.0.0.12:45214/?token=secret",
  ]);
});

test("bridgeUrls omits token query for tokenless debug URLs", () => {
  assert.deepEqual(bridgeUrls(["127.0.0.1"], 45214, ""), ["http://127.0.0.1:45214/"]);
});

test("notificationTargets stays empty without opt-in environment variables", () => {
  assert.deepEqual(notificationTargets({}), []);
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
  assert.match(requests[0].options.body, /Codex phone bridge is ready/);
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
  assert.match(requests[0].options.body, /No LAN URL was detected/);
  assert.equal(requests[1].options.body.has("url"), false);
  assert.equal(requests[1].options.body.has("url_title"), false);
  assert.match(requests[1].options.body.get("message"), /No LAN URL was detected/);
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
  assert.match(JSON.parse(requests[0].options.body).content, /Codex phone bridge is ready/);
  assert.deepEqual(JSON.parse(requests[0].options.body).allowed_mentions, { parse: [] });
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
  assert.match(body.content, /codex task completed/);
  assert.match(body.content, /Thread: thread-123/);
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

test("notifyEvent dedupes and strips tokenized URLs", async () => {
  const requests = [];
  const env = {
    PHONE_NOTIFY_EVENTS: "1",
    PHONE_NOTIFY_EVENT_DEDUPE_MS: "10000",
    PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
  };
  const event = {
    type: "approval_required",
    title: "Approval required",
    message: "Approve npm test",
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
    /claude task failed[\s\S]*process exited/,
  );
});

test("taskNotificationMessage can include multiple task links", () => {
  const message = taskNotificationMessage({
    status: "approval",
    provider: "codex",
    urls: ["http://192.168.11.8:45214/?token=secret", "http://100.64.0.1:45214/?token=secret"],
    url: "http://192.168.11.8:45214/?token=secret",
  });

  assert.match(message, /Links:/);
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
