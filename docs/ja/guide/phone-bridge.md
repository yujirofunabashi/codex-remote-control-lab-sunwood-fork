# Phone Bridge

Phone bridge は Codex app-server をローカルで起動し、`/readyz` を待ってから LAN 用の小さな HTTP/WebSocket bridge を立ち上げます。

一番の役割は、スマホをデスクトップ Codex セッションのリモコンにすることです。Codex app-server 本体は Mac の localhost に閉じたまま、phone browser と desktop browser が同じ bridge-managed thread を共有できます。

## 起動

```bash
npm ci
npm run phone
```

次のような URL が表示されます。

```text
http://192.168.11.8:45214/?token=...
```

同じネットワーク上のスマホや別ブラウザから、その URL をそのまま開きます。スマホから prompt 送信、承認、artifact 確認まで行い、PC に戻ったら同じ thread を desktop browser で resume できます。

表示された URL には `?token=...` が含まれます。この URL は private に扱ってください。bridge を止めるときは、`npm run phone` を実行している terminal で `Ctrl+C` を押します。terminal を閉じた場合や PC を再起動した場合は、もう一度 `npm run phone` を実行します。

## 構成

```text
phone browser
  -> token-protected bridge on 0.0.0.0:45214
  -> Codex app-server on ws://127.0.0.1:45213
```

複数ブラウザで同じ bridge thread を共有できます。既存 thread を指定するときは `thread=<thread_id>` を URL に足します。これが PC/スマホ同期の経路で、端末ごとに別セッションを作るのではなく、同じ Codex 会話を両方から操作します。

trusted LAN の外から使う場合、認証なしの public tunnel や raw port forwarding で bridge を公開しないでください。SSH forwarding、VPN、device authentication 付き mesh network などの trusted access を前に置いてください。

Codex Desktop 本体とライブ同期したい場合は、Desktop の通常ローカル会話画面ではなく、Desktop の Remote Connection が接続する headless app-server と OCdex を同じ endpoint に接続します。Desktop の通常ローカル会話画面は `stdio` 接続の専用 app-server を使うため、外部クライアントからその画面へ直接ライブ注入する公開経路はありません。

通常の Desktop 画面向けの履歴同期として、OCdex は turn 完了後に `thread/read` と scan-backed な `thread/list` を呼び、app-server の履歴/index を温めます。これは Desktop の sidebar/history と、thread を開き直す/再読込したときの追従を狙うものです。すでに開いている通常 Desktop thread の本文へライブ反映する経路ではありません。

既存の control socket を OCdex と共有する例:

```bash
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock \
PHONE_WORKDIR=/Users/admin/Prj/demo \
PHONE_TOKEN=demo-test-token \
npm run phone
```

このモードでは OCdex は新しい app-server を起動せず、指定した socket の app-server を使います。Desktop 側も同じ headless app-server を Remote Connection として開くと、Desktop Remote 画面と OCdex browser が同じ thread event stream を購読できます。

## 環境変数

```bash
PHONE_UI_PORT=45214 npm run phone
PHONE_WORKDIR=/Users/admin/Prj/some-project npm run phone
CODEX_MODEL=gpt-5.4 npm run phone
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock npm run phone
CODEX_APP_SERVER_URL=ws://127.0.0.1:45213 npm run phone
CODEX_HISTORY_SYNC=0 npm run phone
PHONE_TOKEN=choose-your-own-token npm run phone
PHONE_NTFY_TOPIC=your-private-topic npm run phone
PHONE_PUSHOVER_TOKEN=app-token PHONE_PUSHOVER_USER=user-key npm run phone
PHONE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... npm run phone
PHONE_NOTIFY_TIMEOUT_MS=5000 npm run phone
```

複数ポート運用では、各 `PHONE_UI_PORT` を固定 workspace slot として扱い、`PHONE_WORKDIR` で slot の worktree を指定します。Codex / Claude は browser UI から切り替えられ、`PHONE_AGENT_PROVIDER` は再起動後に最初に開く既定 provider だけを決めます。

起動通知は任意です。`PHONE_NTFY_TOPIC` を設定すると ready URL を ntfy topic へ投稿します。`PHONE_PUSHOVER_TOKEN` と `PHONE_PUSHOVER_USER` を設定すると同じ URL を Pushover へ送ります。`PHONE_DISCORD_WEBHOOK_URL` を設定すると Discord へ投稿します。`npm run phone` は local `.env` を読んでから環境変数を参照します。`PHONE_NTFY_SERVER` は既定で `https://ntfy.sh`、HTTPS 必須です。通知 request は `PHONE_NOTIFY_TIMEOUT_MS` で timeout し、既定は 5000 ms です。LAN IPv4 URL がある場合、通知本文には token 付き bridge URL が入るため、private/protected topic、account、channel を使い、通知用 credential は Git に入れないでください。LAN IPv4 URL を検出できない場合は、provider の link field を省略し、host console を確認するよう通知します。

レート制限表示は local の非公式 provider 別 snapshot に対応しています。Codex では `PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` を設定すると、bridge は Codex auth file `~/.codex/auth.json` を読み、Codex Desktop が使う usage endpoint を呼び、表示に必要な残量 percentage/reset だけを正規化して `.phone-rate-limits.json` に cache します。従来の `PHONE_RATE_LIMIT_REFRESH_COMMAND` も Codex 用としてだけ維持しているため、Claude mode で Codex の制限値が混ざることは避けます。token や raw API response は cache しません。失敗時は前回の provider cache か `unavailable` に fallback します。Codex app UI の macOS Accessibility fallback を明示的に使う場合だけ `PHONE_RATE_LIMIT_SOURCE=desktop` を設定します。

Codex Desktop ではなく Chrome 上の ChatGPT を使う場合は、`PHONE_RATE_LIMIT_SOURCE=chrome` を設定し、`chatgpt.com` tab を開いて Chrome の `表示 > デベロッパー > Apple Events からの JavaScript を許可` を有効にします。Chrome provider は account/profile menu を開いた後の `document.body.innerText` だけを読みます。cookie、local storage、request header は読みません。

Claude の subscription limit は Anthropic API の rate-limit header とは別物です。Claude mode では、headless の `claude --output-format stream-json` 実行から流れる Claude Code の `rate_limit_event` を bridge が監視し、5時間 / 7日 の subscription window を `.phone-rate-limits.claude.json` に正規化 cache します。interactive な Claude Code session では、status line command として `node /absolute/path/to/scripts/capture-claude-rate-limits.js` を設定すると、Claude Code の `rate_limits` status-line JSON を読み、同じ cache に残量 percentage/reset だけを書きます。

background の thread 一覧 polling は、同じ error の連続表示を抑えます。app-server の短い再起動や token mismatch が起きても、同じ `/api/threads` failure が chat log に増え続けることは避けます。

## UI でできること

- 最近の thread 一覧と resume
- デスクトップ Codex セッションをスマホから操作
- shared bridge-managed thread による PC/スマホ間の継続利用
- model、plugin、config、auth、automation の確認
- Codex model 表示は `5.5-L/M/H/XH` 形式。`L/M/H/XH` は Low / Medium / High / Extra High
- 次 turn 向けの承認・sandbox mode 切り替え
- repository artifact preview
- chat と artifact の Markdown rendering
- browser 画像添付を `localImage` input として Codex に渡す
- 設定 panel から simple / cyberpunk / botanical のカラーテーマを切り替え
- bridge-managed thread を LAN 内の複数端末で共有
