# Phone Bridge

Phone bridge は Codex app-server をローカルで起動し、`/readyz` を待ってから LAN 用の小さな HTTP/WebSocket bridge を立ち上げます。

一番の役割は、スマホをデスクトップ Codex セッションのリモコンにすることです。Codex app-server 本体は Mac の localhost に閉じたまま、phone browser と desktop browser が同じ bridge-managed thread を共有できます。

## 起動

```bash
npm ci
npm run phone
```

UI の再起動ボタン（sidebar 下部の `設定` の隣、および設定 panel 内）を使う場合は、監視付きの entry point で起動します。再起動は exit code 42 で終了して supervisor に再投入させる仕組みなので、supervisor がいないと停止したまま復帰できません。どちらのボタンも実行前に確認ダイアログを出します。

```bash
npm run phone:loop          # Codex
npm run phone:loop:claude   # Claude
```

監視なしで起動した bridge は、再起動要求を実行せずに理由を返します。手元に PC がない状態で bridge を落とさないためです。

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
CODEX_MODEL=gpt-5.6-sol npm run phone
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
PHONE_NOTIFY_EXCERPT_CHARS=200 npm run phone
PHONE_APPROVAL_TIMEOUT_MS=1200000 npm run phone
PHONE_CLAUDE_STALL_WARN_MS=90000 npm run phone
PHONE_CLAUDE_STALL_KILL_MS=300000 npm run phone
```

複数ポート運用では、各 `PHONE_UI_PORT` を固定 workspace slot として扱い、`PHONE_WORKDIR` で slot の worktree を指定します。`CODEX_APP_SERVER_PORT` を指定しない場合、各 slot の Codex app-server は `PHONE_UI_PORT - 1` を使います。たとえば `45224 -> 45223` になり、`45214 -> 45213` の既定 app-server を複数 slot が誤って共有しません。Codex / Claude は browser UI から切り替えられ、`PHONE_AGENT_PROVIDER` は再起動後に最初に開く既定 provider だけを決めます。

Bridge Fleet / Worktree Switchboard を使うと、その複数 slot を 1 つの browser tab で管理できます。bridge を別 port で起動し、1 つ目の bridge を開いてから、bridge/worktree pill で残りの protected startup URL または base URL と token を貼り付けます。保存する host profile は base URL と metadata を token store から分けます。active bridge は既存の chat、terminal、thread、artifact、model、approval UI をそのまま駆動し、inactive bridge は token-protected API で稼働状態、error、terminal tail、approval request を監視します。

各 bridge は fleet metadata 用に token-protected `GET /api/bridge/info` を公開します。返すのは label、group、port、cwd、repo root、branch、short HEAD、dirty summary、model、capabilities です。この endpoint は UI の auth header / cookie 経由で token を要求し、phone token、app-server secret、webhook URL、任意 shell 実行口は返しません。

まとめて起動したい場合は local 専用の `.phone-fleet.local.json` を作り、`npm run phone:fleet` を実行します。entry ごとに `provider` へ `codex` または `claude` を指定すると、fleet 起動時にその slot の既定 provider を固定します。launcher は bridge process に shared/scoped の `PHONE_AGENT_PROVIDER` を渡します。fleet launcher から起動した bridge では、browser UI から保存した workdir / model / provider も対応する fleet entry へ反映され、次回の fleet 再起動後も維持されます。`.phone-fleet.local.json`、`.phone-bridges.local.json`、port ごとの registry backup `.phone-bridges.<port>.local.json`、`.phone-registry-key` は Git に入れないでください。private な worktree path、registry 情報、backup した bridge token を保護する鍵を含み得ます。

起動通知は任意です。`PHONE_NTFY_TOPIC` を設定すると ready URL を ntfy topic へ投稿します。`PHONE_PUSHOVER_TOKEN` と `PHONE_PUSHOVER_USER` を設定すると同じ URL を Pushover へ送ります。`PHONE_DISCORD_WEBHOOK_URL` を設定すると Discord へ投稿します。起動通知は 1 件で、Mac 名（`PHONE_MACHINE_LABEL`、未設定なら hostname）とフォルダ名を載せ、`tailscale serve` がその bridge を HTTPS で公開していればその公開アドレスを先頭に置きます。`npm run phone` は local `.env` を読んでから環境変数を参照します。これらは fleet の `.env` と同じ slot 付きの形（例 `PHONE_DISCORD_WEBHOOK_URL_45214`）でも指定できます。1 つの `.env` を共有する 2 つの bridge で通知先を分けたり、片方だけ通知させたりできます。slot なしのキーは全 slot に効きます。`PHONE_NTFY_SERVER` は既定で `https://ntfy.sh`、HTTPS 必須です。通知 request は `PHONE_NOTIFY_TIMEOUT_MS` で timeout し、既定は 5000 ms です。起動通知は既定で token を含みません。インストール済みのホーム画面アプリは自分の token を既に持っていて、bridge が上がったことが分かれば足りる一方、channel に残る token 付き URL は bridge が registry backup を配信する以上 fleet 全体の鍵になるためです。初回セットアップで token 付き URL が要るときだけ `PHONE_NOTIFY_STARTUP_TOKEN_URLS=1` を設定し、private/protected な topic、account、channel で使ってください。通知用 credential は Git に入れないでください。

task 完了/中断通知は、設定済み provider へ常に送ります。その他の作業 event 通知も使う場合は `PHONE_NOTIFY_EVENTS=1` を設定します。対応 event は `approval_required`、`approval_expired`、`question_required`、`test_failed`、`connection_lost`、`history_sync_failed`、`long_running` です。起動は起動通知 1 件にまとめ、別の `bridge_started` event は送りません。文面は人が読む日本語です。見出しはどの Mac の誰が何をしたか（例 `✅ mini の Claude の作業が終わりました`、`🔔 Air の Codex が承認を待っています`）で、続けてフォルダ名、依頼文の冒頭、完了なら返答の冒頭（既定 200 文字。`PHONE_NOTIFY_EXCERPT_CHARS` で変更、`0` で省略）、承認待ちなら実行したいコマンドや変更するファイル、質問ならその質問文、失敗なら原因、次に何をすればよいか、最後に token なしの bridge URL を 1 つ載せます。Discord へは見出しを本文、残りを embed として送り、送り主名を `Claude mini` / `Codex Air` のように Mac ごとに変え、embed の帯をその Mac の色（mini は琥珀色、Air は青、それ以外は名前から決めた固定色。`PHONE_BRIDGE_COLOR` で上書き可）にします。2 台の Mac が同じ channel に投稿しても、どちらの通知か読む前に分かります。thread ID、turn ID、model 名、event type の生の値、UTC の時刻は載せません。質問で終わった turn は `question_required` だけを送り、完了通知を重ねません。turn 中に接続が切れた場合は `test_failed` 1 件に原因を含めます。リンクは `tailscale serve` の HTTPS 公開アドレスがあればそれを使います。生の IP は別 origin になり、ホーム画面アプリが保存した token が使えないためです。同じ thread / event type の短時間連投は `PHONE_NOTIFY_EVENT_DEDUPE_MS` で抑制します。event 通知には full token を含めません。

レート制限表示は local の非公式 provider 別 snapshot に対応しています。Codex では `PHONE_CODEX_RATE_LIMIT_REFRESH_COMMAND="node scripts/read-desktop-rate-limits.js"` を設定すると、bridge は Codex auth file `~/.codex/auth.json` を読み、Codex Desktop が使う usage endpoint を呼び、表示に必要な残量 percentage/reset だけを正規化して `.phone-rate-limits.json` に cache します。従来の `PHONE_RATE_LIMIT_REFRESH_COMMAND` も Codex 用としてだけ維持しているため、Claude mode で Codex の制限値が混ざることは避けます。token や raw API response は cache しません。失敗時は前回の provider cache か `unavailable` に fallback します。Codex app UI の macOS Accessibility fallback を明示的に使う場合だけ `PHONE_RATE_LIMIT_SOURCE=desktop` を設定します。

Codex Desktop ではなく Chrome 上の ChatGPT を使う場合は、`PHONE_RATE_LIMIT_SOURCE=chrome` を設定し、`chatgpt.com` tab を開いて Chrome の `表示 > デベロッパー > Apple Events からの JavaScript を許可` を有効にします。Chrome provider は account/profile menu を開いた後の `document.body.innerText` だけを読みます。cookie、local storage、request header は読みません。

Claude の subscription limit は Anthropic API の rate-limit header とは別物です。Claude mode では、headless の `claude --output-format stream-json` 実行から流れる Claude Code の `rate_limit_event` を bridge が監視し、5時間 / 7日 の subscription window を `.phone-rate-limits.claude.json` に正規化 cache します。interactive な Claude Code session では、status line command として `node /absolute/path/to/scripts/capture-claude-rate-limits.js` を設定すると、Claude Code の `rate_limits` status-line JSON を読み、同じ cache に残量 percentage/reset だけを書きます。

background の thread 一覧 polling は、同じ error の連続表示を抑えます。app-server の短い再起動や token mismatch が起きても、同じ `/api/threads` failure が chat log に増え続けることは避けます。

permission mode がどれであっても、run 側には必ず確認手段を渡します。Claude Code は bridge ごとの Unix socket に紐づく permission-prompt tool 付きで起動するため、止まった tool 呼び出しはスマホ側の承認カードになります。フルアクセス（`bypassPermissions`）も同じです。このモードでは通常の tool 呼び出しは prompt tool を通さず素通りしますが、`PreToolUse` hook が `ask` を返せば止まります。確認先が無い run は permission denial を記録したまま待ち続けます。開いた承認は答えるまで bridge が保持するので、再読み込みや再接続をしても同じ質問が戻り、止まったまま進まない run にはなりません。スマホが接続していないときも同じです。通知先（Discord など）が設定されていれば、質問はその場で拒否せず保持して通知し、あとから開いたアプリに `ready` でカードを渡します。この通知は `PHONE_NOTIFY_EVENTS` の設定に関係なく送ります。接続中の端末も通知先もない場合だけ、その場で拒否します。答えが無いまま `PHONE_APPROVAL_TIMEOUT_MS`（既定 1200000 ms = 20 分）が経つと拒否として進み、`approval_expired` 通知で時間切れを知らせます。Claude Code は無応答の stdio MCP 呼び出しを 30 分で打ち切るので、この値はそれより短くしてください。Codex の承認も `ready` の run 状態に保持中の承認を載せるため、再接続後にカードが戻ります。保持は質問した側が終わるまでです。答えを受け取らないまま turn が終了した場合は bridge も質問を取り下げるので、どの決定も届かないカードが残り続けることはありません。

turn が終わるのは Claude Code process の終了時だけなので、出力を止めたまま終了しない process はスマホに「処理中」を出し続けます。これは進行中の作業と見分けが付かず、画面が答えるべき唯一の問いに答えられなくなります。bridge は turn ごとに最後の出力時刻を持ち、`PHONE_CLAUDE_STALL_WARN_MS`（既定 90000 ms）沈黙したら作業ログに一度だけ無応答の可能性を書き、`PHONE_CLAUDE_STALL_KILL_MS`（既定 300000 ms）沈黙したら応答が停止したとみなして process を終了し、turn を「応答なし」として閉じ、`failed` の run 通知を送ります。SIGTERM を無視する process があるため、`PHONE_CLAUDE_STALL_KILL_GRACE_MS`（既定 2000 ms）後に SIGKILL へ上げます。判断材料は時間だけではありません。実行中の tool 呼び出しが残っている turn は、長い build や test で沈黙するのが正常なので、待ち時間をログに書くだけで終了させません。終了対象になるのは tool 結果を受け取った後、つまり出力を返すべき状態で黙った turn だけです。どちらの閾値も `0` で無効化でき、片方だけ止めることもできます。既に届いた途中までの応答は履歴に残します。

## sidebar は全 workdir を横断する

session は workdir ごとに分けて保存されます。sidebar が現在の workdir だけを読んでいた頃は、**作業場所を変えた瞬間に過去の session が全部消えたように見えていました**。消えていたのは表示だけで、記録はどこにも失われていません。

sidebar は `~/.claude/projects` 配下の全 workdir を読みます。並び順は 2 通りから選べます。

- **プロジェクト別**（既定）— フォルダごとの見出しでまとめる。従来の表示
- **日時順** — 見出しを畳んで、全フォルダを更新時刻の新しい順に 1 本のリストで並べる。各行に `cwd:` が出るのでどのフォルダの作業かは分かります

選択は端末ごとに保存されます。

各行の右端の `>_`（再開命令のコピーボタン）は、Codex・Claude（どちらも AI 作業ツール）の両方に出ます。コピーしたコマンド（操作命令）は、Air・mini（会話を保存する Mac）のどちらのターミナル（文字で操作する画面）にも貼れます。**会話が保存されている Mac で、元の作業フォルダと会話番号を指定して再開します。** 記録を別の Mac に移す機能ではありません。

保存先の Mac に貼った場合はその場で起動します。もう一方に貼った場合は SSH（別のパソコンへ安全に接続する仕組み）を使います。前提として、mini 側の接続名 `air` が Air の会話所有者へ、Air 側の接続名 `mini` が mini の会話所有者へ接続できる設定が必要です。それ以外の機種は実機名を接続先として使います。接続後は実機名をもう一度照合し、一致しなければ中止します。接続失敗時に別の Mac で会話を始めることはありません。

再開部分は `codex resume <会話ID>` または `claude --resume <会話ID>`（指定した会話番号の続きから起動する命令）です。実際にコピーされる文字列には、実機名の照合・元のフォルダへの移動・必要な接続も含まれます。接続先では `zsh -lic`（普段のターミナル設定を読み込む実行方法）を使い、起動するツールを見つけます。保存先の実機名・作業フォルダ・有効な会話番号がそろうまではボタンを出しません。貼り付け先は Mac のターミナルであり、スマホ内の単発コマンド実行欄ではありません。

bridge は HTTP で配信されるため、ブラウザによっては `navigator.clipboard` が使えません。その場合は `execCommand` にフォールバックし、それも駄目なら入力欄にコマンドを表示するので、手で選択してコピーできます。

別の workdir の session を開くと、その session は**始まったディレクトリで動きます**。そうしないと続きが別のプロジェクト配下に記録され、元の session が放置されたように見えてしまいます。何かが移動するわけでも、状態が溜まるわけでもありません。bridge は session ごとに作られ、ディレクトリは生成時に一度決まるだけで、設定した作業場所は変わりません（新規チャットは今までどおりそこで始まります）。

外付けボリュームなど**ホーム配下でない場所**でも開きます。`validateWorkdir` のホーム縛りは、スマホがネットワーク越しに要求できる範囲を制限するためのもので、transcript に記録された cwd はそれとは別物です（ローカルの `claude` が実際に走った場所）。ここでフォールバックしてしまうと、`git remote -v` が開いた行とは別のリポジトリを答える、という形で実害が出ます。

ヘッダーの作業場所表示も、そのセッションが実際に動くフォルダになります。

各プロジェクトは既定で 6 件（日時順は 30 件）まで表示し、残りは **もっと表示する (残りN件)** で開きます。もう一度押すと **表示を減らす** で畳めます。展開状態は端末ごとに保存されます。

### プロジェクトを一覧から隠す

session を作るのは人だけではありません。メモリ系の hook や要約処理など、最初のメッセージが system prompt になっているツールも同じ場所に書き込みます。どのフォルダがそれに当たるかはマシンごとに違い、特にホームフォルダは**人によっては本当の作業場所、人によってはツールの置き場**なので、bridge が推測するのではなく指定してもらう形にしました。プロジェクト見出しの **×** を押すと一覧から外れます。

外したものは sidebar の一番下の **非表示のプロジェクト** にまとまり、タップすれば戻ります。設定は bridge 側（workspace bookmark と同じ `.phone-workspaces.json`）に保存されるので、どの端末から見ても同じです。

これは「一覧に出すかどうか」の設定で「どこで作業してよいか」ではないため、`validateWorkdir` が弾くフォルダ（外付けボリューム、削除済みなど）も指定できます。bridge 自身が動いている workdir は隠せません — 一覧から消えると戻る手段が無くなるためです。

例外は、フォルダを明示的に指定した場合です。プロジェクト見出しの「新規チャット」ボタンはそのプロジェクトを送っており、Claude でもこれを尊重するようになりました。sidebar が 1 つの workdir しか出していなかった頃は、このボタンは bridge が既にいるフォルダしか意味し得なかったため、指定は捨てられていました。削除済みやホーム配下でないフォルダの場合は、チャットを開けなくするのではなく現在の作業場所にフォールバックします。

一覧は polling されるため、要約は file が変わるまで cache されます。1 フォルダあたりの読み込み件数は既定で新しい方から 20 件、`PHONE_CLAUDE_SESSIONS_PER_PROJECT` で変更できます。

## PC で進めていた作業をスマホで引き継ぐ

session は 1 つのファイルで、**デスクトップアプリもターミナルの `claude` もこの bridge も、同じファイルに追記します**。sidebar からそのまま開けば、そこまでの会話を読んで続きを送れます。

開いている間、bridge はそのファイルを監視します。PC 側で作業が進めば、スマホ側にも反映されます。

- **開いている session**: 約 1 秒（`PHONE_CLAUDE_WATCH_INTERVAL_MS` で変更可）。追記を検出すると WebSocket で push するので、次の polling を待ちません
- **一覧**: 10 秒ごとの polling

監視するのは、実際にスマホがその session を開いている間だけです。最後の 1 台が閉じれば止まります。自分のターンを実行している最中は、画面に届いている stream のほうが新しいので反映しません。ターンが終われば、その間に外側で書かれた分もまとめて入ります。

::: warning claude.ai のスマホアプリは対象外
ここで引き継げるのは、**その Mac のディスク上にある session** — デスクトップアプリとターミナルの `claude` です。claude.ai のスマホアプリやブラウザの会話はクラウド側にあり、Mac のファイルとして存在しないため、この方法では読めません。
:::

## スマホで進めた作業を PC から開く

bridge の turn は、Claude Code が期待する場所にそのまま記録されます。

```text
~/.claude/projects/<workdir を slug 化した名前>/<session-id>.jsonl
```

見つからない場合、記録が無いのではなく**探している場所が違う**ことがほとんどです。`claude --resume` は **起動したディレクトリに属する session だけ** を候補に出します。bridge の workdir 以外から起動すると、スマホで進めた作業は候補に現れません。

どこに何があるかは次で確認できます。

```bash
npm run sessions                       # すべての workdir を横断
npm run sessions -- --cwd /path/to/project
npm run sessions -- --json
```

session ID、タイトル、更新時刻と、そのまま貼れる resume command を workdir ごとに表示します。

session は workdir ごとに分かれて保存されるため、bridge の作業場所を変えると新しい session は別の場所へ行き、以前の session は単一 workdir しか見ない画面から消えます。消えたのではなく別のフォルダにあります。既定で全 workdir を横断するのはこのためです。

```bash
cd /Users/you/Prj/example && claude --resume 2bec35bc-1324-4b49-8a83-d550e9a9ba07
```

`claude --resume` を ID なしで実行する場合は、**必ず bridge の workdir で実行してください**。そこが候補一覧の範囲になります。

### picker に出てこないとき

`claude -c` は **picker を通さずに** そのディレクトリの最新の会話を開きます。外から見ると同じに見える2つの原因を切り分けられます。

```bash
cd "npm run sessions の ■ の行のパス"
claude -c
```

- **スマホの会話が開く** → session には到達できている。さっきはディレクトリが違ったか、picker には出ていたのに気づかなかったかのどちらか。命名機能が入る前の session は、最初のメッセージがそのままラベルになっているので「スマホのやつ」とは分かりません
- **何も見つからない** → その session が属するディレクトリにいない。`■` の行を確認し直してください

どちらの場合も `claude --resume <id>` は効きます。ID だけは読み間違えようがないので、`npm run sessions` は行ごとにコマンドをそのまま出します。

### session の名前

スマホから始めた session には、最初の prompt から作った名前が、出どころを示す marker 付きで自動で付きます。

```text
📱 レートリミットの表示を直して
```

この名前は `/resume` の picker、prompt box、terminal のタイトルに表示されます。PC で自分が始めた session と並んでも、どれがスマホからのものか一目で分かります。名前が付くのは session 作成時の一度だけなので、PC 側で付け直した名前はそのまま残り、スマホの sidebar にもその名前が反映されます。

marker を変えたいときは `PHONE_SESSION_NAME_PREFIX` を設定します。空文字にすれば marker なしになります。`--name` を受け付けない古い `claude` では、この命名は行われません。

## Claude のレート制限表示

Claude mode のレート制限は 2 つの経路から入ります。得られる情報が違います。

| 経路 | 得られるもの | 設定 |
| --- | --- | --- |
| bridge の turn が出す `rate_limit_event` | どの枠か、リセット時刻、追加利用中かどうか | 不要（自動） |
| Claude Code の statusLine payload | **残量パーセント** | 下記の設定が必要 |

`rate_limit_event` に使用率のフィールドは含まれないため、bridge の turn だけではパーセントを出せません。パーセントを出すには、対話セッションの Claude Code に statusLine hook を設定します。`~/.claude/settings.json` に次を加えます。

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/codex-remote-control-lab/scripts/capture-claude-rate-limits.js"
  }
}
```

`/path/to/...` は clone の absolute path に置き換えてください。設定すると、その端末で `claude` を対話起動するたびに `.phone-rate-limits.claude.json` が更新され、bridge がそれを読みます。

statusLine は対話セッションの機能なので、`claude -p`（bridge の turn）では発火しません。つまりパーセントは「あなたが端末で Claude を使ったとき」に更新されます。cache が古い場合、bridge は stale として扱います。

書き込み先は `PHONE_CLAUDE_RATE_LIMIT_CACHE_PATH` で変更できます。cache に入るのは正規化した表示用の値だけで、token や raw API response は保存しません。

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
- text input、terminal log、artifact preview、approval card、横スクロール領域では誤発火しない swipe navigation。画面左端から右へのスワイプは chat 切り替えではなく sidebar を開きます
- unread badge と draft / scroll 復元つきの Codex / Terminal 切り替え
- 手動 command 入力と出力に専念する phone terminal。chat composer と chat status log は terminal 面に出さず、`user@host cwd %` 形式の現在地 prompt を表示
- filter chip、client-side search、表示出力コピー、auto-scroll pause、wrap / font control、key-intent chip、CSS focus mode
- chat / terminal のどちらでも見える approval card
- 勝手に送信せず入力欄へ prompt template を挿入する quick action chip
- model、plugin、config、auth、automation の確認
- Codex・Claude（AI 作業ツール）のモデル（使用する機種）と推論の深さは、機種名と「標準」「かなり深め」「最大」などの日本語で表示します。選択肢は接続先が報告する対応範囲に従います。Fast mode（速度優先設定）は1行の切替と `⚡` で示します
- 本人が選んだ深さは、この画面のブラウザ保存領域に保持します。起動・再接続・会話や機種の切替では保存値を書き換えません。対応しない機種では、その場の表示と送信だけを対応範囲内に調整し、対応する機種へ戻れば保存した深さに戻ります。機種ごとの対応範囲は Air・mini（それぞれの Mac）を分けて保持し、途中まで届いた一覧で既知の範囲を消しません。以前の不具合ですでに失われた選択は復元できないため、一度選び直してください
- 次 turn 向けの承認・sandbox mode 切り替え
- repository artifact preview
- chat と artifact の Markdown rendering
- browser 画像添付を `localImage` input として Codex に渡す
- 設定 panel から simple / cyberpunk / botanical のカラーテーマを切り替え
- bridge-managed thread を LAN 内の複数端末で共有

terminal の key row は、認証なしの raw shell 実行口ではありません。`$` は Codex への安全なコマンド実行依頼テンプレートを挿入するだけで、bridge access は引き続き token protected、Codex app-server は localhost bind のままです。

## PWA 注意

通常公開する `site.webmanifest` は token を含まず、`display: standalone` を使います。有効な protected `/install?token=...` page だけが no-store の install manifest を参照し、その `start_url` は credential を URL fragment で渡します。以前の protected access により Safari に credential が残っていれば、短い `/install` URL を開くだけで、ホーム画面へ追加する前に protected install page へ自動再読込します。Safari とホーム画面 Web App は storage が別であるため、この受け渡しが必要です。初回起動時に Web App 自身の local storage へ保存し、fragment は即時削除します。fragment は bridge へ送信されず、無効または token なしの install-manifest request が credential 付き `start_url` を受け取ることもありません。`/install?token=...&provider=codex` のように `provider` を付けると、install page・アイコン・manifest はその provider の画像と名前（例: `Codex mini`）になり、`start_url` にも `provider` が残るため、そのアイコンはその provider で開きます。Claude 既定の bridge でも Codex 用アイコンを作れます。

secure context または localhost では `service-worker.js` を登録し、app shell だけを cache します。通常 manifest、API response、WebSocket、token 付き URL と install manifest、upload、raw file route、terminal history、approval payload は cache しません。LAN HTTP ではブラウザ制約で Service Worker 登録ができないことがありますが、通常の browser UI はそのまま使えます。

ホーム画面に追加した後も、保存された token はその端末の private state として扱ってください。token がない、または rotation した場合は、ホーム画面 Web App の復旧フォームへ local の `.phone-token` / `PHONE_TOKEN` を入力します。または、その Web App を削除し、現在の protected `/install?token=...` URL から追加し直します。Safari で URL を開くだけでは、既にインストール済みの Web App へ Safari の storage はコピーされません。

Web App を削除すると接続先の一覧も一緒に消えるため、各 bridge は最後に同期された一覧の控えを持ちます。入れ直した Web App に有効な token が入ると、インストール元の bridge から控えを読み戻し、他の Mac が手作業の再登録なしで戻ります。控えは最後の同期時点のものです。この機能を配備したあとに一度だけ接続先を登録すれば、以後の追加と削除は自動で backup されます。削除は「一覧から消える」ではなく削除記録として残るため、削除時に閉じていた端末も次の同期でその接続先を落とします。押し戻すことはありません。削除後に登録し直した接続先はそのまま残ります。削除記録の保持は 90 日、最大 256 件です。それより長く offline だった端末は削除済みの接続先を持ち帰り得るので、その場合は登録し直すか、その端末でも削除してください。復元が成功するまで push は行わないため、入れ直した直後の空の一覧が、これから復元する backup を上書きすることはありません。同じ理由で、backup を読めない bridge は上書きせずに同期を止めます。file の場所と token の保護方法は [Security Model](./security.md) を参照してください。
