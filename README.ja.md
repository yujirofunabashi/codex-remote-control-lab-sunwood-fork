<p align="center">
  <img src="docs/assets/codex-remote-control-lab-header.png" alt="Codex Remote Control Lab" style="width:100%;height:auto;">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://sunwood-ai-labs.github.io/codex-remote-control-lab/ja/">Docs</a> ·
  <a href="https://github.com/Sunwood-ai-labs/codex-remote-control-lab">GitHub</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933">
  <img alt="Codex CLI" src="https://img.shields.io/badge/Codex%20CLI-0.130.0-111111">
  <img alt="License" src="https://img.shields.io/badge/License-ISC-blue">
  <img alt="Public safe" src="https://img.shields.io/badge/Public--safe-localhost%20first-41d6a4">
</p>

# Codex Remote Control Lab

Codex Remote Control Lab は、デスクトップで動いている Codex セッションをスマホから操作できるようにする実験 repo です。Mac で bridge を起動し、スマホで token 付き URL を開けば、同じ Codex thread を PC とスマホのどちらからでも継続できます。

OpenAI Codex CLI の `remote-control` / `app-server` をローカル優先で扱います。Codex app-server は `127.0.0.1` に閉じ、同じ LAN 上の端末へは token 付きの小さな browser bridge だけを公開します。

## ✨ できること

- repo-local の Codex CLI `0.130.0` app-server を起動
- スマホの browser からデスクトップ側の Codex app-server を操作
- PC とスマホで 1 つの Codex thread を同期し、PC で始めた作業をスマホからそのまま続行
- スマホ向け browser UI で thread resume、artifact preview、承認、model 選択、画像添付、カラーテーマ切替を扱う
- phone と desktop browser で 1 つの bridge-managed Codex thread を共有
- `.phone-token`、`.uploads/`、`.codex-home*/`、log、session database を Git に入れない
- VitePress と GitHub Pages で日英 docs を公開

## 🚀 Quick Start

```bash
git clone https://github.com/Sunwood-ai-labs/codex-remote-control-lab.git
cd codex-remote-control-lab
npm ci
npm run phone
```

terminal には次のような伏せ字の bridge URL が表示されます。

```text
http://192.168.11.8:45214/?token=abcd…wxyz
```

同じ Wi-Fi/LAN 上のスマホでは、private な起動通知で届いた token 付き URL を開くか、bridge URL を開いて local の `.phone-token` / `PHONE_TOKEN` 由来の token を入力します。

## 🧭 構成

```text
phone browser -> http://Mac-LAN-IP:45214 -> Node bridge -> ws://127.0.0.1:45213 -> Codex app-server
```

安全境界は意図的です。Codex app-server は localhost に残し、LAN に出るのは token-protected bridge だけです。

## 🧪 検証コマンド

```bash
npm run check
npm run docs:build
npm audit --omit=dev
```

protocol だけを smoke test する場合:

```bash
npm run server:ws
npm run probe:ws
```

local smoke test では、WebSocket app-server 経由の `initialize` / `thread/start` と、`/readyz` / `/healthz` の挙動を確認しています。

## 📱 Phone Bridge

この bridge の一番大きな価値は、デスクトップ上の Codex をスマホから操作できることです。Codex 本体は Mac の localhost に置いたまま、スマホは LAN 経由のリモコンとして動きます。同じ bridge-managed thread を PC browser と phone browser の両方で開けるため、作業セッションが端末ごとに分断されず、PC とスマホで同期した感覚で続けられます。

便利な環境変数:

```bash
PHONE_UI_PORT=45214 npm run phone
PHONE_UI_PORT=45224 PHONE_WORKDIR=/Users/admin/Prj/some-project PHONE_APP_NAME="Slot 45224" PHONE_APP_ID=slot-45224 npm run phone
PHONE_BRIDGE_ID=work-a PHONE_BRIDGE_LABEL=WorkA PHONE_BRIDGE_GROUP=client PHONE_BRIDGE_COLOR=#2f6f2f npm run phone
PHONE_MACHINE_LABEL=mini npm run phone
npm run phone:fleet
CODEX_WORKDIR=/Users/admin/Prj/some-project npm run phone
CODEX_MODEL=gpt-5.6-sol npm run phone
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock npm run phone
CODEX_APP_SERVER_URL=ws://127.0.0.1:45213 npm run phone
CODEX_HISTORY_SYNC=0 npm run phone
PHONE_TOKEN=choose-your-own-token npm run phone
PHONE_NTFY_TOPIC=your-private-topic npm run phone
PHONE_PUSHOVER_TOKEN=app-token PHONE_PUSHOVER_USER=user-key npm run phone
PHONE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... npm run phone
PHONE_NOTIFY_TIMEOUT_MS=5000 npm run phone
```

複数 bridge / 複数 worktree を 1 つの browser tab で扱う場合は、Bridge Fleet / Worktree Switchboard を使います。通常通り 1 つ目の bridge を開き、ヘッダーまたは sidebar の bridge/worktree pill から、残りの protected startup URL または base URL と token を追加します。`CODEX_APP_SERVER_PORT` を指定しない場合、各 slot の Codex app-server は `PHONE_UI_PORT - 1` を使います。たとえば `45224 -> 45223` になり、`45214 -> 45213` の既定 app-server を複数 slot が奪い合いません。active bridge を切り替えると chat / terminal / thread / artifact / approval UI はその bridge の状態へ切り替わり、inactive bridge の稼働・エラー・承認待ちは global monitor / inbox に出ます。session は実行した Mac に残るため、sidebar の thread 一覧は登録済み bridge すべてから集めた 1 つの一覧になります。2 台以上の Mac が並ぶときだけ project 見出しと thread 行に機体名（`mini` / `Air` など）が付き、ホーム画面アイコンに合わせて mini は琥珀色、Air は青で表示されます。別の Mac の thread を開くとその bridge へ接続が切り替わります。設定画面の作業場所・フォルダ選択も、いま見ているのがどの Mac かを見出しとパス表示に出し、上部の chip で設定対象の Mac を切り替えられます。機体名は hostname から推定し、`PHONE_MACHINE_LABEL` を指定した場合はそちらが優先されます。

各 bridge は token-protected な `GET /api/bridge/info` で label、port、cwd、branch、dirty summary、model、capabilities を返します。token は UI では mask され、host profile には base URL と metadata だけを保存し、保存 token は端末内の token store、保存しない token は sessionStorage に分けます。`.phone-fleet.local.json` を作って `npm run phone:fleet` を使うと、複数 slot をまとめて起動できます。各 entry に `"provider": "codex"` または `"provider": "claude"` を入れると、その slot の既定 provider を再起動後も固定できます。Codex のモデル一覧は app-server の `model/list` に追従します。app-server 起動時とスマホがモデル一覧を開いたときに取得し、最後の応答を `.phone-codex-models.json` に保存して、作業中のモデルメニューと設定画面の両方に組み込みの予備リストより先に出します。アカウントに新しいモデルが届けば、この repo を更新しなくてもそのまま選べます。fleet mode では browser UI から保存した workdir / model / provider も対応する `.phone-fleet.local.json` entry へ反映され、次回の fleet 再起動後も維持されます。この local config は Git に入れないでください。

`CODEX_APP_SERVER_SOCK` または `CODEX_APP_SERVER_URL` を指定すると、bridge は新しい app-server を起動せず、既存の headless app-server に接続します。Codex Desktop 本体とライブ同期したい場合は、Desktop の通常ローカル会話画面ではなく、Desktop の Remote Connection と OCdex を同じ headless app-server に接続してください。Desktop の通常ローカル会話画面は専用の `stdio` app-server を使うため、外部 bridge からその画面へ直接ライブ注入する公開経路はありません。

履歴同期は既定で有効です。Web 側の turn 完了後、bridge は `thread/read` と scan-backed な `thread/list` を実行して app-server の履歴/index を温めます。`/api/threads` も state DB 限定ではなく scan-and-repair で取得します。これにより Codex Desktop 側で thread を開き直す/再読込したときに、更新済み session を見つけやすくします。ただし、通常の Desktop 会話画面へライブ注入するものではありません。追加の履歴 refresh を止めたい場合は `CODEX_HISTORY_SYNC=0` を指定します。

通知は opt-in です。`PHONE_NTFY_TOPIC` がある場合は ntfy topic へ、`PHONE_PUSHOVER_TOKEN` と `PHONE_PUSHOVER_USER` がある場合は Pushover へ、`PHONE_DISCORD_WEBHOOK_URL` がある場合は Discord へ送ります。起動時は Mac 名と接続 URL を 1 件だけ送ります。task 完了/中断通知は、設定済み provider へ常に送ります。その他の作業 event 通知も使う場合は `PHONE_NOTIFY_EVENTS=1` を設定します。`approval_required`、`approval_expired`、`question_required`、`test_failed`、`connection_lost`、`history_sync_failed`、`long_running` を送信でき、`PHONE_NOTIFY_EVENT_DEDUPE_MS` で非強制 event の短時間重複通知を抑制します。文面は人が読む日本語です。見出しはどの Mac の誰が何をしたか（例 `✅ mini の Claude の作業が終わりました`。Mac 名は `PHONE_MACHINE_LABEL`、未設定なら hostname）で、続けてフォルダ名、依頼文の冒頭、完了なら返答の冒頭（既定 200 文字。`PHONE_NOTIFY_EXCERPT_CHARS` で変更、`0` で省略）、承認待ちなら実行したいコマンドや変更するファイル、質問ならその質問文、失敗なら原因、最後に開くリンクを 1 つ載せます。Discord では送り主名も `Claude mini` / `Codex Air` のように Mac ごとに変わり、本文はその Mac の色（mini は琥珀色、Air は青。`PHONE_BRIDGE_COLOR` で上書き可）の帯が付いた embed で届くので、どの Mac からの通知か一目で分かります。thread ID、turn ID、model 名、event type の生の値は載せません。質問で終わった turn は質問の通知だけを送り、完了通知を重ねません。リンクは `tailscale serve` がその bridge を HTTPS で公開していればその公開アドレス、なければ tailnet/LAN の IP を使います。起動通知は互換性のため token 付き URL を含み得るので private/protected topic、account、channel 限定で使ってください。event 通知の URL には token を含めません。

Claude mode の turn は、出力が止まったまま終了しない process を検知します。`PHONE_CLAUDE_STALL_WARN_MS`（既定 90000 ms）で作業ログに一度警告し、`PHONE_CLAUDE_STALL_KILL_MS`（既定 300000 ms）で process を終了して turn を「応答なし」として閉じます。tool 実行を待っている turn は長い build でも終了させません。

現在の bridge は次をサポートします。

- Codex Desktop 風の sidebar / conversation / artifact panel / composer layout
- 最近の thread 一覧と直接 resume
- 複数 bridge profile を 1 tab に登録する Bridge Fleet / Worktree Switchboard
- 登録済み bridge 全体の thread 一覧を 1 つの sidebar にまとめ、project 見出しにどの Mac のものかを表示
- 登録済み bridge 全体の global running monitor と global approval inbox
- thread ごとのアクセント色を browser localStorage に保存し、複数作業を見分けやすくする
- チャット / ターミナル表示を切り替え、command・file change・承認・error などの監視ログを確認
- 状態、位置、thread 色、compact path、mini thread switcher をまとめたスマホ向け cockpit header
- スマホ幅では誤爆を抑えた左右スワイプ、ヘッダーの前後ボタン、または位置 pill から thread を切り替え
- filter chip、検索、表示ログコピー、auto-scroll pause、文字サイズ、safe key-intent chip、focus mode を備えたスマホ向け terminal view
- chat / terminal のどちらでも見える approval card と、大きめの承認 / 拒否操作
- 勝手に送信せず入力欄へ挿入する quick action chip
- Desktop の開き直し/再読込に寄せた既定の履歴同期 refresh
- plugin、model、config/auth、automation status panel
- 次 turn 向けの approval / sandbox mode control
- chat と artifact preview の Markdown rendering
- Markdown image link の inline rendering
- browser で選んだ画像を Codex `localImage` input として送信
- local repository image artifact を token-protected file route から表示
- status/tool log の折りたたみ表示
- simple / cyberpunk / botanical のカラーテーマを browser local storage に保存

安全境界は変えていません。Codex app-server は `127.0.0.1` のまま、browser 操作は token-protected bridge を通り、terminal 操作 UI も認証なしの任意 shell 実行口を追加しません。

公式 mobile 体験との位置づけは [公式 Codex Mobile との違い](docs/ja/guide/official-codex-mobile-comparison.md) を参照してください。

### モバイル terminal compact layout

スマホ幅の terminal view では、Codex / Terminal 切替を header 内の小さな segmented control にまとめ、terminal command 入力と実行結果を優先表示します。chat composer は terminal view では隠し、chat の状態ログは terminal 本文へ流さず、手動で実行した command の出力だけを表示します。空の terminal と実行後の末尾には `user@host cwd %` 形式の現在地 prompt を出します。通常の Safari tab でも terminal 表示領域を優先し、`Focus` / `Max` では pathbar、artifact panel などを隠してさらに広く使えます。

terminal toolbar は普段は `Filter / All / Search / Auto / ...` の 1 行だけを表示します。`...` から filter、search、wrap、auto-scroll、表示クリア、表示コピー、文字サイズ、Max、QuickBar pin を開けます。`Clear visible` はこの端末の表示だけを消し、server history は削除しません。`Copy visible` は既存の token masking を通した表示出力だけをコピーします。

`Text` / `Keys` は入力欄左下の小さなボタンに統合されています。QuickBar は terminal view で入力欄 focus 中、Keys mode 中、または QuickBar pin 中だけ表示されます。`Ctrl+C` は確認付きで、`$` は raw shell 実行ではなく安全な実行依頼テンプレートを挿入します。

`?debugViewport=1` を付けると、terminal body、visual viewport、composer、header、pathbar、toolbar、display mode、manifest/token 状態を小さく表示できます。

### PWA / ホーム画面に追加

`site.webmanifest`、touch icon、standalone detection に対応しています。PWA は表示領域を増やす補助であり、通常 Safari tab でも compact layout は有効です。環境により LAN HTTP では PWA 化が制限されることがあります。

manifest の `start_url` には token を入れません。そのため root URL をそのままホーム画面に追加すると、standalone 起動時に token を持たない状態になります。standalone と token を両立させたい場合は `/install?token=...` を Safari で開いてから「ホーム画面に追加」してください。このページは manifest を出さず standalone meta だけを残すので、iOS は manifest の `start_url` ではなくアドレスバーの URL をそのまま起動 URL に採用します。UI 側の「ホーム画面に追加」ヒントの `追加用` ボタンも同じ URL を開きます。`/install?token=...&provider=codex` のように `provider` を付けると、その AI 用のアイコン画像と名前（例: `Codex mini`）でホーム画面に追加でき、起動時もその AI で開きます。Claude 既定の bridge でも Codex 用アイコンを作れ、`追加用` ボタンは今開いているチャットの AI を自動で付けます。`/bookmark` は standalone にせず Safari tab で開く従来のブックマーク用です。token が見つからない場合は、private な起動通知の URL で開き直すか、token 入力欄から local の `.phone-token` / `PHONE_TOKEN` を保存してください。token 付き URL は公開 issue、共有チャット、スクリーンショット、配信に載せないでください。

Service Worker は secure context または localhost で app shell のみを cache します。`/api/*`、WebSocket、token 付き URL、raw file、uploads、artifacts、terminal history、approval payload は cache しません。LAN HTTP ではブラウザ制約により登録できない場合があります。

## 🖼️ UI Evidence

Desktop-like layout:

![Desktop-like UI desktop screenshot](docs/assets/desktop-like-ui-desktop.png)

Compact chat typography with image-link preview:

![Compact chat font with image preview screenshot](docs/assets/chat-font-image-preview.png)

Theme comparison:

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/assets/theme-simple-desktop.png" alt="Simple theme desktop screenshot" width="280"><br>
      <sub>シンプル desktop</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/theme-cyberpunk-desktop.png" alt="Cyberpunk theme desktop screenshot" width="280"><br>
      <sub>サイバーパンク desktop</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/theme-botanical-desktop.png" alt="Botanical theme desktop screenshot" width="280"><br>
      <sub>ボタニカル desktop</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="docs/assets/theme-simple-mobile-settings.png" alt="Simple theme mobile settings screenshot" width="180"><br>
      <sub>シンプル設定</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/theme-cyberpunk-mobile-settings.png" alt="Cyberpunk theme mobile settings screenshot" width="180"><br>
      <sub>サイバーパンク設定</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/theme-botanical-mobile-settings.png" alt="Botanical theme mobile settings screenshot" width="180"><br>
      <sub>ボタニカル設定</sub>
    </td>
  </tr>
</table>

Mobile flow:

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/assets/desktop-like-ui-mobile.png" alt="Desktop-like UI mobile screenshot" width="220"><br>
      <sub>モバイル全体</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/mobile-responsive-chat.png" alt="Mobile responsive chat screenshot" width="220"><br>
      <sub>チャット表示</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/mobile-responsive-drawer.png" alt="Mobile responsive drawer screenshot" width="220"><br>
      <sub>スレッド drawer</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="docs/assets/theme-cyberpunk-mobile-settings.png" alt="Cyberpunk theme settings screenshot" width="220"><br>
      <sub>テーマ設定</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/mobile-desktop-like-controls.png" alt="Mobile desktop-like controls screenshot" width="220"><br>
      <sub>composer 操作</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/assets/mobile-model-menu.png" alt="Mobile model menu screenshot" width="220"><br>
      <sub>モデル menu</sub>
    </td>
  </tr>
</table>

追加スクリーンショットは `docs/assets/` と bridge UI の artifact panel から確認できます。

## 🔐 Safety Notes

- Codex app-server は `127.0.0.1` に保ちます。
- 認証なしの Codex app-server を LAN や public interface に直接 bind しないでください。
- `?token=...` 付きの起動 URL は local access key として扱い、公開 issue、共有チャット、スクリーンショット、配信には載せないでください。
- bridge は `Ctrl+C` で停止します。terminal を閉じた場合や PC を再起動した後は、もう一度 `npm run phone` を実行します。
- trusted LAN 外から使う場合は SSH forwarding、VPN、mesh network を優先してください。
- 認証なしの public tunnel や raw port forwarding で bridge を公開しないでください。
- shared network で demo した後は `.phone-token` を削除するか `PHONE_TOKEN` を変更してください。

公開安全 checklist は [SECURITY.md](SECURITY.md) にあります。

## 📚 Documentation

- [English docs](https://sunwood-ai-labs.github.io/codex-remote-control-lab/)
- [日本語ドキュメント](https://sunwood-ai-labs.github.io/codex-remote-control-lab/ja/)
- [v0.2.0 リリースノート](https://sunwood-ai-labs.github.io/codex-remote-control-lab/ja/guide/releases/v0.2.0)
- [Phone bridge guide](docs/ja/guide/phone-bridge.md)
- [Protocol notes](docs/ja/guide/protocol.md)
- [Security model](docs/ja/guide/security.md)
- [コントリビュートと上流PR](docs/ja/guide/contributing.md)

## 🗂️ Repository Layout

```text
public/              Phone bridge が配信する browser UI
scripts/             Codex app-server probe と bridge launcher
docs/                VitePress docs と screenshot assets
docs/assets/         UI verification screenshots
docs/public/         docs/README 用 identity assets
.github/workflows/   CI と GitHub Pages deployment
```

## 📄 License

ISC. See [LICENSE](LICENSE).
