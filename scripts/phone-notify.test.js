const test = require("node:test");
const assert = require("node:assert/strict");

const {
  approvalDetail,
  bridgeUrls,
  tokenNeedsUrlEncoding,
  discordPayload,
  eventNotificationMessage,
  eventNotificationParts,
  machineColor,
  notificationExcerpt,
  notificationExcerptChars,
  notificationMessage,
  notificationTargets,
  notifyBridgeUrls,
  notifyEvent,
  notifyTaskEvent,
  ntfyHeaderValue,
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
  assert.match(requests[0].options.body, /スマホブリッジが起動しました/);
  // A Japanese title cannot travel in an HTTP header as-is; ntfy reads RFC 2047.
  assert.match(requests[0].options.headers.title, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

test("ntfy header values stay readable: ASCII as-is, anything else RFC 2047 encoded", () => {
  assert.equal(ntfyHeaderValue("Codex phone bridge ready"), "Codex phone bridge ready");
  const encoded = ntfyHeaderValue("承認待ち");
  assert.match(encoded, /^=\?UTF-8\?B\?(.+)\?=$/);
  assert.equal(Buffer.from(encoded.match(/^=\?UTF-8\?B\?(.+)\?=$/)[1], "base64").toString("utf8"), "承認待ち");
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
  assert.match(requests[0].options.body, /接続用のURLを見つけられませんでした/);
  assert.equal(requests[1].options.body.has("url"), false);
  assert.equal(requests[1].options.body.has("url_title"), false);
  assert.match(requests[1].options.body.get("message"), /接続用のURLを見つけられませんでした/);
});

test("the startup message names the Mac and lists the published address first", () => {
  const message = notificationMessage(["https://mini.tailnet.ts.net:8444/", "http://192.168.11.8:45214/"], {
    machine: "mini",
    project: "codex-remote-control-lab",
  });
  assert.match(message, /^🟢 mini のスマホブリッジが起動しました\nフォルダ: codex-remote-control-lab\n/);
  assert.ok(message.indexOf("https://mini.tailnet.ts.net:8444/") < message.indexOf("http://192.168.11.8:45214/"));
  // Without a Mac name it still says what happened.
  assert.match(notificationMessage(["http://192.168.11.8:45214/"]), /^🟢 スマホブリッジが起動しました/);
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
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.content, "🟢 スマホブリッジが起動しました");
  assert.equal(body.username, "スマホブリッジ");
  assert.match(body.embeds[0].description, /http:\/\/192\.168\.11\.8:45214\/\?token=secret/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
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
  // Read by a person: who did what, where, and one link. The identifiers the
  // old message listed - thread, turn, model, raw event type - are looked up
  // in the app, not read in a channel.
  // Discord shows three things apart: the name the post is made under, the
  // message text (what a lock screen shows), and an embed carrying the rest.
  assert.equal(body.content, "✅ Codex の作業が終わりました");
  assert.equal(body.username, "Codex");
  const embed = body.embeds[0];
  assert.match(embed.description, /^フォルダ: demo\n/);
  assert.match(embed.description, /開く: http:\/\/100\.64\.0\.1:45214\/\?thread=thread-123/);
  assert.equal(embed.description.match(/https?:\/\//g).length, 1);
  assert.equal(typeof embed.color, "number");
  assert.doesNotMatch(`${body.content}\n${embed.description}`, /secret|スレッド:|ターン:|モデル:|種別:|重要度:|turn_completed|gpt-5\.4/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("which Mac a message came from is visible before it is read", () => {
  // Two Macs post to one channel, and "Claude finished" from one looks exactly
  // like the other. The Mac leads the headline, the post is made under that
  // Mac's name, and the embed carries the colour its Home Screen icon has.
  const mini = eventNotificationParts({ type: "turn_completed", provider: "claude", machine: "mini", projectName: "demo" });
  assert.equal(mini.headline, "✅ mini の Claude の作業が終わりました");
  assert.equal(mini.author, "Claude mini");
  assert.equal(mini.color, "#F59E0B");
  const air = eventNotificationParts({ type: "approval_required", provider: "codex", machine: "Air", questionCount: 1, detail: "A?" });
  assert.equal(air.headline, "❓ Air の Codex から質問があります");
  assert.equal(air.author, "Codex Air");
  assert.equal(air.color, "#2563EB");
  assert.equal(eventNotificationParts({ type: "bridge_started", machine: "Air" }).author, "スマホブリッジ Air");
  assert.match(eventNotificationParts({ type: "history_sync_failed", machine: "mini" }).headline, /^⚠️ mini のチャット履歴の同期に失敗しました/);
  // A Mac nobody named gets a colour of its own, the same every time; a
  // configured colour wins over the guess.
  assert.equal(machineColor("studio"), machineColor("studio"));
  assert.notEqual(machineColor("studio"), machineColor(""));
  assert.equal(machineColor("mini", "#123abc"), "#123ABC");
  assert.equal(machineColor("MacBook-Air.local"), "#2563EB");

  const payload = discordPayload({ ...mini, message: `${mini.headline}\n${mini.body}` });
  assert.equal(payload.username, "Claude mini");
  assert.equal(payload.content, mini.headline);
  assert.equal(payload.embeds[0].color, 0xf59e0b);
  assert.match(payload.embeds[0].description, /^フォルダ: demo/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  // Nothing to embed when there is no body: the text alone is posted.
  assert.equal(discordPayload({ headline: "x", body: "", author: "Codex" }).embeds, undefined);
});

test("a completion notification quotes what was asked and what was answered", () => {
  const message = taskNotificationMessage({
    status: "completed",
    provider: "claude",
    machine: "mini",
    workdir: "/Users/me/Prj/demo",
    prompt: "Discord通知を読みやすくして\n\n細かい要望は後で書きます",
    reply: "## 結果\n\n通知の文面を書き直しました。\n\n- 見出しの重複をなくした\n```js\nconsole.log(1)\n```",
    url: "https://mini.tailnet.ts.net:8444/?thread=abc&provider=claude",
  });
  assert.match(message, /^✅ mini の Claude の作業が終わりました\nフォルダ: demo\n依頼: Discord通知を読みやすくして 細かい要望は後で書きます\n/);
  // Markdown scaffolding is dropped and the answer is one line.
  assert.match(message, /\n返答: 結果 通知の文面を書き直しました。 見出しの重複をなくした console\.log\(1\)\n/);
  assert.doesNotMatch(message, /```|##|^- /m);
  assert.match(message, /\n開く: https:\/\/mini\.tailnet\.ts\.net:8444\/\?thread=abc&provider=claude$/);
});

test("the quoted answer is cut to a length a notification can hold, and can be left out", () => {
  const long = "あ".repeat(500);
  assert.equal(notificationExcerpt(long, 200).length, 200);
  assert.match(notificationExcerpt(long, 200), /…$/);
  assert.equal(notificationExcerpt("short answer", 200), "short answer");
  assert.equal(notificationExcerpt(long, 0), "");
  // The setting reads like every other notification setting, per slot too.
  assert.equal(notificationExcerptChars({}), 200);
  assert.equal(notificationExcerptChars({ PHONE_NOTIFY_EXCERPT_CHARS: "0" }), 0);
  assert.equal(notificationExcerptChars({ PHONE_NOTIFY_EXCERPT_CHARS: "80" }), 80);
  assert.equal(notificationExcerptChars({ PHONE_NOTIFY_EXCERPT_CHARS: "nonsense" }), 200);
  assert.equal(notificationExcerptChars({ PHONE_UI_PORT: "45234", PHONE_NOTIFY_EXCERPT_CHARS_45234: "50" }), 50);

  const without = taskNotificationMessage({ status: "completed", provider: "claude", reply: "the answer", excerptChars: 0 });
  assert.doesNotMatch(without, /返答/);
  const clipped = taskNotificationMessage({ status: "completed", provider: "claude", reply: "x".repeat(300), excerptChars: 20 });
  assert.match(clipped, /\n返答: x{19}…$/);
});

test("PHONE_NOTIFY_EXCERPT_CHARS reaches the message a bridge sends", async () => {
  const requests = [];
  await notifyTaskEvent(
    { status: "completed", provider: "codex", threadId: "thread-1", reply: "a long answer that says a lot" },
    {
      env: { PHONE_NOTIFY_EXCERPT_CHARS: "0", PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" },
      force: true,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 204 };
      },
    },
  );
  const body = JSON.parse(requests[0].options.body);
  assert.doesNotMatch(`${body.content}\n${body.embeds?.[0]?.description || ""}`, /返答|a long answer/);
});

test("an interrupted turn says so, and quotes what it had written", () => {
  const message = taskNotificationMessage({ status: "interrupted", provider: "codex", reply: "途中まで" });
  assert.match(message, /^⏹ Codex の作業を途中で止めました\n/);
  assert.match(message, /途中までの返答: 途中まで/);
  assert.match(message, /もう一度送ってください/);
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
  assert.match(JSON.parse(requests[0].options.body).content, /Codex の作業が終わりました/);
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
  const text = `${body.content}\n${body.embeds[0].description}`;
  assert.equal(body.content, "🔔 Codex が承認を待っています");
  assert.match(text, /内容: npm test の承認待ちです/);
  assert.match(text, /「承認」か「拒否」/);
  assert.doesNotMatch(text, /secret|token=/);
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
  const text = `${body.content}\n${body.embeds[0].description}`;
  assert.match(text, /thread=abc/);
  assert.doesNotMatch(text, /secret|token=/);
});

test("a failure notification says what went wrong and what to do", () => {
  const message = taskNotificationMessage({
    status: "failed",
    provider: "claude",
    threadId: "session-123",
    message: "process exited",
  });
  assert.match(message, /^❌ Claude の作業が失敗しました\n/);
  assert.match(message, /\n原因: process exited\n/);
  assert.match(message, /もう一度送ってください/);
});

test("a notification is written for the person reading it, not for a log", () => {
  // The owner read the old format - raw event type, severity, thread id, ISO
  // time, the same heading twice - as noise they could not act on. What stays
  // is what they need: what happened, on which Mac, in which folder, about
  // which request, and what to do now.
  const message = eventNotificationMessage({
    type: "approval_required",
    title: "承認待ち",
    message: "Bash の承認待ちです",
    machine: "air",
    projectName: "codex-remote-control-lab-air",
    prompt: "READMEを直して",
    severity: "warning",
    createdAt: "2026-08-06T01:23:45.000Z",
    threadId: "session-123",
  });

  assert.match(message, /^🔔 air の Codex が承認を待っています\nフォルダ: codex-remote-control-lab-air\n依頼: READMEを直して\n/);
  assert.match(message, /\n内容: Bash の承認待ちです\n/);
  assert.match(message, /アプリを開いて「承認」か「拒否」を選んでください/);
  assert.doesNotMatch(message, /approval_required|session-123|2026-08-06|種別|重要度|発生|スレッド|Type:|Severity:|Created:|Project:|Thread:/);
  assert.equal(message.match(/承認/g).length >= 1, true);
  assert.equal(message.split("\n")[0], "🔔 air の Codex が承認を待っています");
});

test("every kind of event has a headline in plain words", () => {
  assert.match(eventNotificationMessage({ type: "long_running" }), /^⏳ Codex の作業が長時間続いています\n/);
  assert.match(eventNotificationMessage({ type: "long_running", minutes: 10, provider: "claude" }), /^⏳ Claude の作業が10分以上続いています\n/);
  assert.match(eventNotificationMessage({ type: "turn_completed" }), /^✅ Codex の作業が終わりました/);
  assert.match(eventNotificationMessage({ type: "question_required", provider: "claude", detail: "どちらにしますか？" }), /^❓ Claude から質問があります\n[\s\S]*質問: どちらにしますか？[\s\S]*返信してください/);
  assert.match(eventNotificationMessage({ type: "approval_required", questionCount: 2, detail: "A? / B?" }), /^❓ Codex から質問があります\n[\s\S]*質問: A\? \/ B\?/);
  assert.match(eventNotificationMessage({ type: "connection_lost", detail: "ECONNREFUSED" }), /^⚠️ Codex との接続が切れました\n[\s\S]*詳細: ECONNREFUSED[\s\S]*「再起動」/);
  assert.match(eventNotificationMessage({ type: "history_sync_failed", detail: "push rejected" }), /^⚠️ チャット履歴の同期に失敗しました\n[\s\S]*詳細: push rejected[\s\S]*作業はそのまま続けられます/);
  assert.match(eventNotificationMessage({ type: "bridge_started", machine: "mini" }), /^🟢 mini のスマホブリッジが起動しました\n/);
  // A question that waits says for how long, and one that ran out says so.
  assert.match(
    eventNotificationMessage({ type: "approval_required", provider: "claude", questionCount: 1, detail: "A?", deadlineMinutes: 20 }),
    /答えるまで作業は止まっています。\n20分以内に答えがないときは「拒否」として作業を続けます。/,
  );
  assert.match(eventNotificationMessage({ type: "approval_required", detail: "コマンドの実行: ls" }), /選ぶまで作業は止まっています。\n\n開く|選ぶまで作業は止まっています。$/);
  assert.match(
    eventNotificationMessage({ type: "approval_expired", provider: "claude", questionCount: 1, detail: "A?", deadlineMinutes: 20 }),
    /^⌛ Claude の質問は時間切れになりました\n[\s\S]*質問: A\?\n\n20分たっても答えがなかったため、「拒否」として作業を続けました。/,
  );
  assert.match(eventNotificationMessage({ type: "approval_expired", detail: "コマンドの実行: ls" }), /^⌛ Codex の承認待ちは時間切れになりました\n[\s\S]*内容: コマンドの実行: ls/);
  // An event nobody named yet falls back to its title, then to its type.
  assert.match(eventNotificationMessage({ type: "something_new", title: "新しい出来事" }), /^新しい出来事/);
  assert.match(eventNotificationMessage({ type: "something_new" }), /^something new/);
});

test("a run notification links once, to the address it was given, without its token", () => {
  const message = taskNotificationMessage({
    status: "approval",
    provider: "codex",
    urls: ["http://192.168.11.8:45214/?token=secret", "http://100.64.0.1:45214/?token=secret"],
    url: "http://192.168.11.8:45214/?token=secret",
  });

  assert.match(message, /\n開く: http:\/\/192\.168\.11\.8:45214\/$/);
  assert.equal(message.match(/http:\/\//g).length, 1);
  assert.doesNotMatch(message, /secret|token=|リンク:/);
});

test("approvalDetail names what is being asked for, the way the approval card does", () => {
  // Claude: a tool name and its input.
  assert.deepEqual(approvalDetail({ method: "claude/requestApproval", params: { toolName: "Bash", input: { command: "npm test", description: "Run tests" } } }), {
    kind: "command",
    text: "コマンドの実行: npm test",
  });
  assert.deepEqual(approvalDetail({ method: "claude/requestApproval", params: { toolName: "Edit", input: { file_path: "/Users/me/Prj/demo/scripts/phone-notify.js" } } }), {
    kind: "file",
    text: "ファイルの変更: …/scripts/phone-notify.js",
  });
  assert.deepEqual(approvalDetail({ method: "claude/requestApproval", params: { toolName: "AskUserQuestion", input: { questions: [{ question: "A案でいい？" }, { question: "テストも？" }] } } }), {
    kind: "question",
    questionCount: 2,
    text: "A案でいい？ / テストも？",
  });
  assert.deepEqual(approvalDetail({ method: "claude/requestApproval", params: { toolName: "WebFetch", input: { url: "https://example.com" } } }), {
    kind: "tool",
    text: "WebFetch: https://example.com",
  });
  // Codex: a JSON-RPC method with params. The method name itself is not shown.
  assert.deepEqual(approvalDetail({ method: "item/commandExecution/requestApproval", params: { command: ["bash", "-lc", "npm test"], cwd: "/tmp" } }), {
    kind: "command",
    text: "コマンドの実行: bash -lc npm test",
  });
  assert.deepEqual(approvalDetail({ method: "item/fileChange/requestApproval", params: { changes: { "/Users/me/Prj/demo/public/main.js": {} } } }), {
    kind: "file",
    text: "ファイルの変更: …/public/main.js",
  });
  assert.equal(approvalDetail({ method: "item/commandExecution/requestApproval", params: {} }).text, "コマンドの実行: (内容を取得できませんでした)");
  assert.equal(approvalDetail({ method: "item/fileChange/requestApproval", params: {} }).text, "ファイルの変更: (対象を取得できませんでした)");
  assert.doesNotMatch(approvalDetail({ method: "item/commandExecution/requestApproval", params: { command: "ls" } }).text, /requestApproval/);
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
