# Phone Bridge

Phone bridge は Codex app-server をローカルで起動し、`/readyz` を待ってから LAN 用の小さな HTTP/WebSocket bridge を立ち上げます。

一番の役割は、スマホをデスクトップ Codex セッションのリモコンにすることです。Codex app-server 本体は Mac の localhost に閉じたまま、phone browser と desktop browser が同じ bridge-managed thread を共有できます。

## 起動

```bash
npm ci
npm run phone
```

terminal には LAN IPv4 ごとの伏せ字 URL が表示されます。

```text
http://192.168.11.8:45214/?token=abcd…wxyz
```

同じネットワーク上のスマホや別ブラウザから、private な起動通知で届いた token 付き URL を開くか、bridge URL を開いて local の `.phone-token` / `PHONE_TOKEN` 由来の token を入力します。スマホから prompt 送信、承認、artifact 確認まで行い、PC に戻ったら同じ thread を desktop browser で resume できます。

完全な `?token=...` URL は local access key です。private に扱ってください。bridge を止めるときは、`npm run phone` を実行している terminal で `Ctrl+C` を押します。terminal を閉じた場合や PC を再起動した場合は、もう一度 `npm run phone` を実行します。

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
PHONE_NOTIFY_EVENTS=1 npm run phone
PHONE_NOTIFY_EVENT_DEDUPE_MS=60000 npm run phone
```

複数ポート運用では、各 `PHONE_UI_PORT` を固定 workspace slot として扱い、`PHONE_WORKDIR` で slot の worktree を指定します。`CODEX_APP_SERVER_PORT` を指定しない場合、各 slot の Codex app-server は `PHONE_UI_PORT - 1` を使います。たとえば `45224 -> 45223` になり、`45214 -> 45213` の既定 app-server を複数 slot が誤って共有しません。

Bridge Fleet / Worktree Switchboard を使うと、その複数 slot を 1 つの browser tab で管理できます。bridge を別 port で起動し、1 つ目の bridge を開いてから、bridge/worktree pill で残りの protected startup URL または base URL と token を貼り付けます。保存する host profile は base URL と metadata を token store から分けます。active bridge は既存の chat、terminal、thread、artifact、model、approval UI をそのまま駆動し、inactive bridge は token-protected API で稼働状態、error、terminal tail、approval request を監視します。

各 bridge は fleet metadata 用に token-protected `GET /api/bridge/info` を公開します。返すのは label、group、port、cwd、repo root、branch、short HEAD、dirty summary、model、capabilities です。この endpoint は UI の auth header / cookie 経由で token を要求し、phone token、app-server secret、webhook URL、任意 shell 実行口は返しません。

まとめて起動したい場合は local 専用の `.phone-fleet.local.json` を作り、`npm run phone:fleet` を実行します。fleet launcher から起動した bridge では、browser UI から保存した workdir / model も対応する fleet entry へ反映され、次回の fleet 再起動後も維持されます。`provider` field は省略するか、古い local config 互換として `codex` だけ指定できます。既存の headless app-server に接続する slot は `appServerUrl` を使います。app-server が Windows など別 OS 上で動き、bridge の local `workdir` と Codex 実行 cwd が異なる場合は `appServerCwd` に app-server 側の cwd を指定します。`.phone-fleet.local.json` と `.phone-bridges.local.json` は Git に入れないでください。private な worktree path や registry 情報を含み得ます。

起動通知は任意です。`PHONE_NTFY_TOPIC` を設定すると ready URL を ntfy topic へ投稿します。`PHONE_PUSHOVER_TOKEN` と `PHONE_PUSHOVER_USER` を設定すると同じ URL を Pushover へ送ります。`PHONE_DISCORD_WEBHOOK_URL` を設定すると Discord へ投稿します。`npm run phone` は local `.env` を読んでから環境変数を参照します。`PHONE_NTFY_SERVER` は既定で `https://ntfy.sh`、HTTPS 必須です。通知 request は `PHONE_NOTIFY_TIMEOUT_MS` で timeout し、既定は 5000 ms です。LAN IPv4 URL がある場合、起動通知は互換性のため token 付き bridge URL を含み得るため、private/protected topic、account、channel で使い、通知用 credential は Git に入れないでください。

task 完了/中断通知は、設定済み provider へ送ります。その他の作業 event 通知も使う場合は `PHONE_NOTIFY_EVENTS=1` を設定します。対応 event は `bridge_started`、`approval_required`、`question_required`、`test_failed`、`connection_lost`、`history_sync_failed`、`long_running` です。payload には type、title、message、thread ID/title、project name、severity、created time、token なし bridge URL、extra を含めます。同じ thread / event type の短時間連投は `PHONE_NOTIFY_EVENT_DEDUPE_MS` で抑制します。event 通知には full token を含めません。

レート制限表示は local の非公式 Codex snapshot に対応しています。`PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` を設定すると、bridge は Codex auth file `~/.codex/auth.json` を読み、Codex Desktop が使う usage endpoint を呼び、表示に必要な残量 percentage/reset だけを正規化して `.phone-rate-limits.json` に cache します。従来の `PHONE_RATE_LIMIT_REFRESH_COMMAND` も Codex 互換として維持しています。token や raw API response は cache しません。失敗時は前回 cache か `unavailable` に fallback します。Codex app UI の macOS Accessibility fallback を明示的に使う場合だけ `PHONE_RATE_LIMIT_SOURCE=desktop` を設定します。

Codex Desktop ではなく Chrome 上の ChatGPT を使う場合は、`PHONE_RATE_LIMIT_SOURCE=chrome` を設定し、`chatgpt.com` tab を開いて Chrome の `表示 > デベロッパー > Apple Events からの JavaScript を許可` を有効にします。Chrome provider は account/profile menu を開いた後の `document.body.innerText` だけを読みます。cookie、local storage、request header は読みません。

background の thread 一覧 polling は、同じ error の連続表示を抑えます。app-server の短い再起動や token mismatch が起きても、同じ `/api/threads` failure が chat log に増え続けることは避けます。

## UI でできること

- 最近の thread 一覧と resume
- デスクトップ Codex セッションをスマホから操作
- shared bridge-managed thread による PC/スマホ間の継続利用
- 複数 bridge / worktree slot を 1 tab で扱う Bridge Fleet / Worktree Switchboard
- 登録済み bridge 全体の global running monitor と approval inbox
- thread status badge と `要対応 / 実行中 / 最近` inbox filter
- Summary / Diff / Tests / Terminal / Artifacts / Actions を持つ Review Center
- bridge、app-server、WebSocket、history sync、token age、notification provider、host、LAN URL を見る health panel
- `/api/*`、WebSocket、token 付き URL、uploads、raw file response を除外する PWA app shell cache
- thread 位置、稼働状態、thread 色、compact cwd、mini thread switcher をまとめた cockpit header
- text input、terminal log、artifact preview、approval card、横スクロール領域では誤発火しない swipe navigation
- unread badge と draft / scroll 復元つきの Codex / Terminal 切り替え
- 手動 command 入力と出力に専念する phone terminal。chat composer と chat status log は terminal 面に出さず、`user@host cwd %` 形式の現在地 prompt を表示
- filter chip、client-side search、表示出力コピー、auto-scroll pause、wrap / font control、key-intent chip、CSS focus mode
- chat / terminal のどちらでも見える approval card
- 勝手に送信せず入力欄へ prompt template を挿入する quick action chip
- model、plugin、config、auth、automation の確認
- Codex model 表示は Standard では `5.5-L/M/H/XH`、Fast mode では `5.5-XH ⚡` のように省略表示します。dropdown では Fast mode を1行トグルにし、reasoning は Low / Medium / High / Extra High のフルネームで表示します
- 次 turn 向けの承認・sandbox mode 切り替え
- repository artifact preview
- chat と artifact の Markdown rendering
- browser 画像添付を `localImage` input として Codex に渡す
- 設定 panel から simple / cyberpunk / botanical のカラーテーマを切り替え
- bridge-managed thread を LAN 内の複数端末で共有

terminal の key row は、認証なしの raw shell 実行口ではありません。`$` は Codex への安全なコマンド実行依頼テンプレートを挿入するだけで、bridge access は引き続き token protected、Codex app-server は localhost bind のままです。

## PWA 注意

`site.webmanifest` は token を含まず、`display: standalone` を使います。secure context または localhost では `service-worker.js` を登録し、app shell だけを cache します。API response、WebSocket、token 付き URL、upload、raw file route、terminal history、approval payload は cache しません。LAN HTTP ではブラウザ制約で Service Worker 登録ができないことがありますが、通常の browser UI はそのまま使えます。

ホーム画面に追加した後も、保存された token はその端末の private state として扱ってください。token がない、または rotation した場合は、private な起動通知の URL を一度開くか、token 入力欄で local の `.phone-token` / `PHONE_TOKEN` を保存すると、UI は address bar に token を残さず再接続します。
