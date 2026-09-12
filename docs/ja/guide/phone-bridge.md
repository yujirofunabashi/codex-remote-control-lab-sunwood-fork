# Phone Bridge

Phone bridge は Codex app-server をローカルで起動し、`/readyz` を待ってから LAN 用の小さな HTTP/WebSocket bridge を立ち上げます。

一番の役割は、スマホをデスクトップ Codex セッションのリモコンにすることです。Codex app-server 本体は Mac の localhost に閉じたまま、phone browser と desktop browser が同じ bridge-managed thread を共有できます。

## 起動

```bash
npm ci
npm run phone
```

このアプリのCodex依存版は0.154.0に固定しています。`npm run version:codex`（=アプリ内に導入したCodexの版を確認する命令）は、このアプリの実体だけを使い、見つからない場合に端末全体の別の版へ切り替えません。`CODEX_BIN`（=起動するCodexを別途指定する設定）を使う場合と、すでに動いているCodexの版は、導入版とは別に確認します。

```bash
npm run version:codex
npm run version:codex:server -- ws://127.0.0.1:45213
```

後者は、指定した実行元へ `initialize`（=接続時の初期確認）だけを送り、稼働中の版を取得します。会話の作成・再開・AI実行・サービス起動は行いません。例の接続先は、対象の入口が返す `/api/info`（=接続先設定を読む場所）の `codexUrl`（=Codexの接続先）と照合して置き換えます。同じ端末内の接続先と明示したポート番号だけを受け付け、接続できない場合や版が読めない場合は未確認として終了します。依存の更新や導入版の確認だけで、動作中の版が変わったとは判断しません。再起動は下記の更新手順に従います。

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

## 複数のMacでの更新

画面や動作の変更は、どちらのMacからでも同じ手順で共有します。まずアプリの保管場所で `feature/*`（=変更専用の作業枝）を作り、検証して `develop`（=変更を集める共有用の枝）へ統合し、`origin`（=共同の保存先）へ送ります。動いているMacに未保存の編集だけを残しても、相手には届きません。詳しくは[貢献手順](../../guide/contributing.md#normal-repository-work)を参照してください。

受け取るMacでは、このアプリの `develop` に未保存の変更がないことを確かめて実行します。

```bash
npm run bridge:check  # 共有先を取得して比較。作業ファイルは更新しない
npm run bridge:pull   # 変更を失わずに進められる場合だけ取り込む
```

片方だけの編集・未送信の保存版・両側で別々に保存した変更・途中の履歴操作がある場合は、更新を止めて理由を表示します。自動的に変更を捨てたり、退避したり、上書きしたりはしません。両側の変更を作業枝で確認して統合してから再実行してください。認証情報、接続先一覧の控え、会話履歴は各Macに残し、相互コピーしません。

取り込み後は両方の接続カードにある「アプリ」の版を確認します。「作業場所」の枝や「変更なし」は会話対象のフォルダーの情報で、アプリの更新完了を意味しません。版の不一致、未共有の編集、再起動待ちは接続欄を折りたたんでも表示されます。相手が切断中・旧版で判定情報がない場合は「確認できません」と表示し、一致扱いにはしません。

版の照合にはファイル内容を使い、更新時刻やMacごとの設定は使いません。共有先との比較は最後に取得した時点の情報なので、最新確認には `npm run bridge:check` を使います。画面の「再確認」は接続先の状態を読み直すだけで、変更の取り込みは行いません。画面の変更は、作業・入力・添付がない時に開いている画面にも反映します。裏側の処理を変えた場合は「再起動待ち」になるため、進行中の作業を保存してから許可を得て対象の中継を再起動し、表示が消えたことを確認します。依存する部品を変更した場合は先に `npm ci`（=指定済みの部品を入れ直す操作）も実行します。

## 構成

```text
phone browser
  -> token-protected bridge on 0.0.0.0:45214
  -> Codex app-server on ws://127.0.0.1:45213
```

複数ブラウザで同じ bridge thread を共有できます。既存 thread を指定するときは `thread=<thread_id>` を URL に足します。これが PC/スマホ同期の経路で、端末ごとに別セッションを作るのではなく、同じ Codex 会話を両方から操作します。

trusted LAN の外から使う場合、認証なしの public tunnel や raw port forwarding で bridge を公開しないでください。SSH forwarding、VPN、device authentication 付き mesh network などの trusted access を前に置いてください。

Codex Desktop（パソコンの公式アプリ）の通常の会話画面と、この bridge（スマホ操作の中継）は、同じ保存履歴が見えても別の実行元を使います。本プロジェクトで確認済みなのは、ブラウザとターミナル（文字で操作する画面）を同じ app-server（会話を動かす本体）につなぐ方法です。公式アプリには [SSH接続による遠隔作業](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)がありますが、それだけでこの中継の実行元を共有できるとは言えません。公式アプリとの共有は未検証です。[Codexと公式アプリの引継ぎ](#codex-desktop-handoff)も参照してください。

通常の Desktop（パソコン側のアプリ）への履歴同期では、OCdex は turn（1回の依頼と応答）の完了後に `thread/read`（会話情報の読み出し）を `includeTurns: false`（本文を含めない指定）で呼び、保存記録を確認する `thread/list`（会話一覧の取得）も行います。本文を全部取り寄せず、app-server（Codexの会話を実行する常駐処理）の一覧情報を更新します。これはパソコン側の会話一覧や開き直した際の表示を更新するもので、開いたままの本文を同時更新する仕組みではありません。

既存の control socket を OCdex と共有する例:

```bash
CODEX_APP_SERVER_SOCK=/Users/admin/.codex/app-server-control/app-server-control.sock \
PHONE_WORKDIR=/Users/admin/Prj/demo \
PHONE_TOKEN=demo-test-token \
npm run phone
```

このモードでは OCdex は新しい app-server を起動せず、指定した socket（同じMac内の接続口）の実行元を使います。使用前に、その接続口が目的の会話を担当する実行元につながることを照合してください。この指定だけで、公式アプリの通常画面が中継と同じ本体につながるわけではありません。

### Windows内の隔離された実験室（フォルダ閲覧を実機確認済み） {#windows-lab}

Windows（=実験用パソコン）内の仮想PC（=分離した作業環境）を、Air（=手元のMacBook Air）・mini（=Mac mini）と同じ一覧へ追加するための専用接続処理があります。通常のWindowsフォルダ全体やデスクトップ画面を操作する機能ではありません。

`scripts/start-lab-bridge.js`（=Airなどで動かす専用中継）、`scripts/lab_host.py`（=Windows側の接続処理）、`scripts/lab_guest.py`（=実験室内の限定操作処理）の3つで構成します。Windows側から中継へ依頼を取りに行き、仮想PCとは既存のシリアル接続（=通信網を使わない管理用の経路）でやり取りします。実験室へTailscale（=自分の機器を結ぶ専用通信網）の接続キー、他のパソコンの認証情報、共有フォルダを持ち込みません。

表示と操作の範囲:

- 接続先に「Windows実験室」を表示し、起動・停止を明示的に依頼する。
- 新規セッション（=新しいAIとの会話）では、専用の作業フォルダ内だけを選ぶ。
- 「ファイル」を開くと一覧を取り直す。接続キーを入力した直後も画面の再読み込みは不要。取得待ちの間に別の表示へ移った場合、その表示を奪わず取得結果だけを保持する。
- AI（=指示を受けて作業する人工知能）に文章で実装・検査を依頼し、会話と結果を保持する。手動の任意コマンド実行、添付、モデル変更、公開・実際の支出は許可しない。
- 停止・接続未確認のときは取得済みのフォルダとファイルだけを表示し、取得日時と「保存済みの表示」を明記する。保存していないファイルの内容は表示できない。
- 会話の上に「Windows実験室の進捗」を表示する。現在の接続状態と最後の成果を常に見せ、タップすると案件・最後の担当・停止理由・AIの次の作業・本人の操作要否を開く。Windowsから15秒以上応答がない場合や画面用の接続が切れた場合は、過去の結果があっても現在の稼働を未確認と表示する。

任意の `progressFile`（=管理側が確認した成果要約の保存先）を中継設定へ追加すると、既存の認証付き状態取得と5秒間隔の画面通知で読み直す。絶対パスの通常ファイルで、所有者のみ読み書きでき、24,000バイト以内であることが必要。`scripts/lab-progress.js`（=表示項目を限定して読む処理）は、リンク・破損・不正形式・未来の確認日時を拒否する。要約を用意しない既存接続は、その欄を「取得できていません」と表示する。要約ファイルを画面の公開フォルダやGit（=コードを共有する履歴管理）へ置かない。

要約の形式は `schema: 1`、`status`（=完了、修正上限、時間上限、利用枠の確認待ち・回復待ちの区分）、`verifiedAt`（=管理側の記録確認日時。1970年からのミリ秒）、`sourceSha256`（=検証済み原本の内容照合値）、`aiInvocations`（=記録で確認したAIへの依頼回数）と、文字列の `project`・`department`・`result`・`stopReason`・`nextAction`・`ownerAction`（=案件・担当・成果・停止理由・次の作業・本人の操作）である。文字列は各1,500文字以内。状態の値は順に `completed`・`revision_limit`・`total_time_limit`・`waiting_usage_observation`・`waiting_subscription_capacity` を使う。管理側の既存の結果検証が成功した後に、必要な表示項目だけを一時ファイルから置き換える。生の会話・記憶・資格情報は入れない。

成果要約を更新しても、Windowsの実行時刻や現在の接続確認時刻は更新しない。別の部門実行処理がこの観察接続へ状況を送っていない場合、接続中でも部門の現在状態は未確認とする。アプリからの実行中表示は、この接続が把握する依頼だけが対象。要約の更新は新しいAI依頼・定期実行・起動操作を追加しない。

起動には、各機器の管理者が確認した専用設定が必要です。通常の `npm run phone`（=既存画面の起動）に自動追加されません。

1. 中継用の `.phone-lab.local.json`（=その機器だけに保存する非公開の設定）を用意する。必須項目は `id`、`targetHost`、`host`、`port`、`workRoot`、`model`、`effort`、`stateFile`、`phoneToken`、`workerToken`、`allowedOrigins`。画面用とWindows用の接続キーは別々の十分長い乱数とし、設定を所有者以外が読めないようにする。作業ルートは `/home/<実験ユーザー>/work` に固定する。
2. `npm run phone:lab -- /絶対パス/.phone-lab.local.json` で手動起動する。待受先は `127.0.0.1`（=その機器内だけの通信先）か、その中継機器のTailscaleアドレスに限定する。暗号化された画面から接続する場合は、専用通信網内のHTTPS（=暗号化通信）中継も必要。公開用トンネルは使わない。`allowedOrigins`（=画面の接続を認めるアドレス一覧）には既存のAir・mini画面の正確なアドレスを設定する。
3. 実験室が停止・通信切断済みで、別の実験が動いていないことを確認する。実験自体の完了は必要ないが、休止中の成果、実行記録、再開用の起動媒体を保持し、現在の媒体を `previousSeed`（=直前の起動媒体）へ正確に指定する。既存のWindows/実験室の防御処理、起動媒体、実行ソフトの版を照合する。`scripts/build_lab_seed.py`（=通信なしの導入媒体の材料を作る処理）へ、確認済みの実験室設定と通信設定を渡す。出力は `user-data`・`meta-data`・`network-config`（=導入内容・実験室の識別・通信設定の3ファイル）で、媒体へのまとめ方は既存の実験室の導入手順に従う。既存ディスクや本人ログインを作り直す処理ではない。
4. 導入媒体と2つのPythonファイル（=Windowsと実験室の処理ファイル）を専用のWindows作業場所へ持ち込む。Windows側の非公開設定には `relayUrl`、`workerToken`、`stateFile`、`guardHelper`、`guardSha256`、`seed`、`seedSha256`、`previousSeed`、`guestSha256` を設定する。ハッシュ（=内容の一致を確かめる値）は実物から算出する。別の実験の媒体で稼働中なら起動処理は拒否する。
5. Windows側で `python -B lab_host.py --config <非公開設定>` を管理者として手動起動する。既存画面の接続先一覧に専用中継のアドレスと画面用キーを登録する。Windows側キーは一覧に登録しない。

Airで導入セットをまとめる場合は `scripts/lab_connection_setup.py`（=接続用ファイルの準備と一度限りの受け渡し処理）を使います。非公開の計画設定には `instanceId`、`relay`、`guest`、`network`、`windows`、`transfer`（=導入識別、画面中継、実験室、通信、Windows、受け渡しの設定）を指定します。Windows設定は `directory`、`guardHelper`、`guardSha256`、`previousSeed`、`previousSeedSha256`（=新しい専用の置き場、防御処理と照合値、直前の媒体と照合値）だけです。`prepare --plan <計画設定> --output <新しい非公開フォルダ>` は接続キーをAir内で新しく作り、導入媒体とWindows専用の接続キーを `connection.zip`（=まとめた導入ファイル）へ格納します。画面用キーはその中に入れません。`serve --directory <同じ非公開フォルダ>` は指定したWindowsからの受信だけを許し、一度の受け渡しまたは最大30分で終了します。

起動命令を渡す直前に配布処理を起動し、待ち受けの応答を確認して、利用者の現地時刻と時間帯を付けた受付期限を一緒に伝えます。受信前に `ConnectionRefusedError`（=接続先が受付をしていないというエラー）が出た場合、Windowsへの導入はまだ始まっていません。Air側の配布処理と受付期限を確認し、期限切れなら同じ非公開フォルダを指定して `serve` を手動で再開します。配布ファイルのハッシュが案内済みの値と一致することと待ち受けの応答を確認してから、同じ命令の再実行を案内します。受信後の導入エラーでは、この再配布手順をそのまま使わず、Windows側の最後の表示と作成済みファイルの状態を確認します。既存の導入先を削除・上書きしたり、受付を自動で延長し続けたりしません。

表示された起動命令は、受信した内容の照合後に `scripts/lab_install_host.py`（=Windows側の初回準備）を実行します。停止・通信切断・元の媒体を再確認し、新しい `phone-bridge-*`（=今回専用の置き場）だけを作成して接続係を手動起動します。既存ファイルの上書き、媒体の入れ替え、実験室やAIの起動は行いません。接続キーを含むファイルの閲覧権限は、その新しい置き場だけで管理者とWindows本体に限定します。画面に `Relay connected`（=中継との接続成功）と出たら、その文字画面は開いたままにします。Windowsの再起動後などは、保存された `lab_host.py` と `host.json`（=接続処理とその非公開設定）で手動起動が再び必要です。最初の接続成功と、専用フォルダの実機確認や既存画面への反映は別の確認段階です。

生成する導入設定は `aiExecutionVerified: false`（=この接続からのAI実行は無効）です。フォルダの閲覧ができても、指示の送信、AIの起動、そのための通信接続は認めません。画面は「AI作業は準備中」と表示し、入力の下書きは残します。過去の実験で1回だけ承認された特別な実行許可は、この接続で繰り返し使える許可ではありません。AI実行を有効にする前に、現在の実験室に対応する制限処理を統合し、本人確認用の情報をAIの道具から読めないこと、過去の成果を書き換えられないことを実機で検証してください。特別な実行許可が必要なら、使う対象・期間・解除方法についてオーナーの承認も必要です。この値を変えるだけで承認や検証を済ませたことにはなりません。

AI実行処理の試作は、通常ユーザーのCodex CLI（=文字の指示でAIを動かすソフト）を使い、OS（=プログラムの動作を管理する基本ソフト）による1回600秒の制限と、Windows側の660秒の通信切断処理を設けています。AIの道具による通信は許可せず、AI提供元への通信は既存の防御処理を維持します。実験室の管理待機も30分で終了します。管理処理の起動前に、実際に入っている媒体と起動時の識別記録を照合し、別の実験の媒体なら接続も停止処理も始めません。自動のAI依頼や機器起動時のWindows接続処理は登録しません。

自動検査には `npm run test:lab`（=限定操作・切断・再送の検査）と `npm run smoke:lab`（=2種類の実ブラウザを使う画面検査）があり、Windowsの相手役には代替処理を使います。初回の接続キー入力から「ファイル」を押して内容を開く操作も、画面の再読み込みなしで検査します。

2026-09-08の対象実機では、Windows中継の接続、Hyper-V（=Windowsの仮想PC機能）での起動、専用フォルダの選択、既存の報告書表示、前回保存した成果3ファイルとの内容一致、通常停止を確認しました。この確認ではAI依頼を実行しておらず、実際のAIによる変更・検査は未確認です。既存のAir・mini画面へ反映するときは、接続先一覧へ画面用キーだけを追加し、元の接続情報を保持します。再起動の承認後も、すべての会話が待機状態になり、返答が保存されてから接続処理だけを再起動します。再起動待ちの登録は完了ではありません。機器ごとに起動時刻の更新、稼働中の版、配信画面、履歴と接続情報の保持を確認します。別の機器への導入ではその実機で再確認し、これらの成功を公開・支出の承認として扱わないでください。

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

task 完了/中断通知は、設定済み provider へ常に送ります。その他の作業 event 通知も使う場合は `PHONE_NOTIFY_EVENTS=1` を設定します。対応 event は `approval_required`、`approval_expired`、`question_required`、`test_failed`、`connection_lost`、`history_sync_failed`、`long_running` です。起動は起動通知 1 件にまとめ、別の `bridge_started` event は送りません。文面は人が読む日本語です。見出しはどの Mac の誰が何をしたか（例 `✅ mini の Claude の作業が終わりました`、`🔔 Air の Codex が承認を待っています`）で、続けてフォルダ名、依頼文の冒頭、完了なら返答の冒頭（既定 200 文字。`PHONE_NOTIFY_EXCERPT_CHARS` で変更、`0` で省略）、承認待ちなら実行したいコマンドや変更するファイル、質問ならその質問文、失敗なら原因、次に何をすればよいか、最後に token なしの bridge URL を 1 つ載せます。Discord へは見出しを本文、残りを embed として送り、送り主名を `Claude mini` / `Codex Air` のように Mac ごとに変え、embed の帯をその Mac の色（mini は琥珀色、Air は青、それ以外は名前から決めた固定色。`PHONE_BRIDGE_COLOR` で上書き可）にします。2 台の Mac が同じ channel に投稿しても、どちらの通知か読む前に分かります。thread ID、turn ID、model 名、event type の生の値、UTC の時刻は載せません。質問で終わった turn は `question_required` だけを送り、完了通知を重ねません。turn 中に接続が切れた場合は `test_failed` 1 件に原因を含めます。`connection_lost` は予期しない切断だけに送ります。フォルダの切り替え、放置後の後片付け、再起動で bridge が自分で接続を閉じたときは送りません。Codex の認証切れは生の 401 ではなく、`codex login` を促す 1 行にして送ります。リンクは `tailscale serve` の HTTPS 公開アドレスがあればそれを使います。生の IP は別 origin になり、ホーム画面アプリが保存した token が使えないためです。同じ thread / event type の短時間連投は `PHONE_NOTIFY_EVENT_DEDUPE_MS` で抑制します。event 通知には full token を含めません。

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

一覧の上の「新規セッション」（＝新しい会話を始めるボタン）から、履歴のないフォルダも選べます。使用するMacとAIを選び、「ホーム」（＝そのMacの利用者用フォルダ）や「↑ 上の階層」でフォルダをたどって、「このフォルダで開始」を押してください。フォルダの場所を直接入力し、「開く」で確認することもできます。対象はホーム配下の既存フォルダで、開発用の管理情報がない普通のフォルダも選べます。

フォルダを探している間は元の会話を保持し、キャンセルしても会話や下書きは変わりません。開始すると選んだMac・AI・フォルダで新しい会話が開き、元の会話は一覧から戻れます。読み込み中・通信失敗時・入力変更後は、フォルダを確認するまで開始できません。フォルダの新設や起動時の既定フォルダ変更は行いません。`node scripts/new-session-smoke.js` と `node scripts/new-session-smoke.js --webkit`（＝2種類のブラウザで新規セッションの操作を確認する命令）は、模擬接続を使い、外部AIに依頼を送りません。

新しい会話の識別番号が届く前に通信が切れても、画面は新規作成の要求と選んだフォルダを保持します。Mac側にその要求の処理が残っていれば、会話の作成が済んでいる場合も同じ会話に接続し直します。同じフォルダの古い会話に戻ることはありません。識別番号が届いた後は、その番号で再接続します。開始前にフォルダが使えなくなった場合は、エラーを表示してフォルダの選び直しを案内します。

Codex（AI作業ツール）の 0.153.4 では、新規作成の会話番号が届いても、最初の送信前は保存ファイルがまだない場合があります。中継ソフトは新規作成時にCodexへ履歴の読み出しを要求し、Codex自身が書いた基本情報の会話番号を照合してから送信可能にします。この確認で仮の依頼や回答は作りません。未送信の会話も、再起動後に同じ番号と元のフォルダで開けます。保存を確認できない場合は、送信可能と表示せずに理由を案内します。

保存済みの空の会話を開き直す際に `list_turns is not supported yet`（会話を読む処理の未対応エラー）が出た場合は、元の保存ファイルを確認します。会話番号が一致する基本情報だけで本文がない場合に限り、保存された元のフォルダで新しい入力画面を開きます。元のファイルは残し、画面にも理由を表示します。本文がある会話、処理中の会話、読み取れない会話は自動で置き換えません。

既存のCodexの会話を開く際は、保存記録を全部送らず、直近80回分までの依頼と応答を取り寄せます。画面には従来どおり最新80件までの履歴を古い順に表示し、大きな画像データや作業結果の全文を通信に含めません。保存済みの記録はそのまま残ります。実装では `thread/resume`（会話の再開）に `excludeTurns: true`（全履歴を含めない指定）と `initialTurnsPage`（直近の履歴を同時に受け取る指定）を付け、`itemsView: "summary"`（表示向けの情報だけを取得する指定）を使います。表示だけの場合は基本情報を読み、`thread/turns/list`（履歴を分けて読む処理）を呼びます。Codex 0.153.4 が対応する試験提供中の通信項目を有効にして利用します。

`already has an active writer`（別の実行元が会話を使用中）と表示された場合は、別に起動したCodexやパソコン側のアプリが同じ会話を開いています。そちらの作業を完了・保存して会話を閉じてから、スマホの「同じ会話に再接続」を試します。画面を閉じたり回答が終わったりしても、使用権（会話を実行・保存する権利）がすぐに解放されるとは限りません。[公式仕様でも接続解除後に会話を保持する猶予があります](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)。直らない場合は再接続を繰り返さず、元の画面で続けてください。中継ソフトは相手の作業を強制終了せず、選択したMac・AI・会話・フォルダ・下書きを保持して保存済み履歴を読みます。依頼の自動再送や別のAIへの切替も行いません。エラー欄の「公式アプリと切り替えるには」を開くと違いを確認できます。この案内を開くだけでは、アプリを起動したり接続先を変更したりしません。

それ以外の接続失敗でも、「同じ会話に再接続」で履歴と下書きを残したまま開き直せます。以前の会話の保存履歴を確認できない場合は、失敗画面の「履歴を探す」から一覧を開けます。「同じフォルダで新しく開く」は、元の会話と下書きを残したまま、同じMac・AI・フォルダで履歴のない会話を始める操作です。元の履歴を復元する操作ではありません。フォルダが分からない場合は、フォルダ選択画面から指定します。会話が開くまでは、後から届く待機状態でエラー表示を消しません。

履歴の表示だけで会話を再開したり、作業フォルダ・AIの種類・操作権限を書き換えたりしません。通常の再開でも元の実行設定を保ちます。Macを切り替えた後に遅れて届いた古い会話一覧は反映しません。また、保存された会話名を優先し、「続けて」などの短い追加依頼で一覧の名前が変わることを防ぎます。

### ターミナルで同じ会話を続ける {#terminal-handoff}

各行の右端の `>_`（再開命令のコピーボタン）は、Codex・Claude（どちらも AI 作業ツール）の両方に出ます。コピーしたコマンド（操作命令）は、Air・mini（会話を保存する Mac）のどちらでも、Macの「ターミナル」アプリ（文字でMacを操作するアプリ）に貼り付けます。Codexの会話入力欄には貼り付けません。**メッセージが保存された会話を、保存先の Mac・作業フォルダ・会話番号を指定して再開します。** 未送信の空のCodex会話では、先にスマホから最初のメッセージを送ってください。記録を別の Mac に移す機能ではありません。

保存先の Mac に貼った場合はその場で起動します。もう一方に貼った場合は SSH（別のパソコンへ安全に接続する仕組み）を使います。前提として、mini 側の接続名 `air` が Air の会話所有者へ、Air 側の接続名 `mini` が mini の会話所有者へ接続できる設定が必要です。それ以外の機種は実機名を接続先として使います。接続後は実機名をもう一度照合し、一致しなければ中止します。接続失敗時に別の Mac で会話を始めることはありません。

Codex の再開部分は `codex resume <会話ID> --remote <接続先>`（スマホと同じ実行元へ、指定した会話番号で接続する命令）です。接続先には、その会話を担当する bridge（スマホ操作の中継ソフト）が使っている app-server（Codex の会話を実行する常駐処理）を指定します。同じ Mac 内の複数の接続口も区別するため、別の実行元と会話の使用権が衝突しません。ターミナルを閉じても共有の実行元は動き続けます。スマホで同じ会話を開けば続きを操作でき、パソコンからの依頼文、実行中の作業、中断、承認への回答も反映されます。

別に起動したCodexが使用中の会話は、その作業を終え、使用権が解放されてから共有の実行元で再開します。ターミナルだけを閉じても、常駐する実行元が残る場合があります。今後パソコンから先に始める場合は、作業フォルダ内で `codex --remote <接続先>`（既存の実行元につなぐ起動命令）を使います。Claude は従来の `claude --resume <会話ID>` と記録の監視を使います。Codex の共有接続は Claude の実行方式を変更しません。

実際にコピーされる文字列には、実機名の照合・元のフォルダへの移動・必要な接続も含まれます。接続先では `zsh -lic`（普段のターミナル設定を読み込む実行方法）を使い、起動するツールを見つけます。保存先の実機名・作業フォルダ・有効な会話番号がそろうまではボタンを出しません。Codex は同じ Mac 内の接続先も確認できる必要があります。貼り付け先は Mac のターミナルであり、スマホ内の単発コマンド実行欄ではありません。app-server は localhost（その Mac の中だけから接続できるアドレス）で動かし、別の Mac からは SSH 経由で利用します。[公式の接続仕様](https://developers.openai.com/codex/app-server)も参照できます。

`npm run smoke:handoff`（引き継ぎの自動確認命令）で、実際の Codex と両ブラウザの動作を確認できます。`codex` と `tmux`（独立した端末画面を用意するソフト）が実行できる環境が必要です。検証専用の保存場所と端末を作り、Mac 内の模擬応答を使うため、普段の認証情報や外部 AI への送信は使いません。待機中の会話の接続を外しても使用権がすぐには解放されないことと、テスト用の実行元だけを終了した後に同じ会話番号・フォルダ・履歴でターミナルから続けられることも確認します。公式アプリや `/app` の動作を検証するテストではありません。

bridge は HTTP で配信されるため、ブラウザによっては `navigator.clipboard` が使えません。その場合は `execCommand` にフォールバックし、それも駄目なら入力欄にコマンドを表示するので、手で選択してコピーできます。

別の workdir の session を開くと、その session は**始まったディレクトリで動きます**。そうしないと続きが別のプロジェクト配下に記録され、元の session が放置されたように見えてしまいます。何かが移動するわけでも、状態が溜まるわけでもありません。bridge は session ごとに作られ、ディレクトリは生成時に一度決まるだけで、設定した作業場所は変わりません（新規チャットは今までどおりそこで始まります）。

外付けボリュームなど**ホーム配下でない場所**でも開きます。`validateWorkdir` のホーム縛りは、スマホがネットワーク越しに要求できる範囲を制限するためのもので、transcript に記録された cwd はそれとは別物です（ローカルの `claude` が実際に走った場所）。ここでフォールバックしてしまうと、`git remote -v` が開いた行とは別のリポジトリを答える、という形で実害が出ます。

ヘッダーの作業場所表示も、そのセッションが実際に動くフォルダになります。

各プロジェクトは既定で 6 件（日時順は 30 件）まで表示し、残りは **もっと表示する (残りN件)** で開きます。もう一度押すと **表示を減らす** で畳めます。展開状態は端末ごとに保存されます。

### Codexと公式アプリの引継ぎ {#codex-desktop-handoff}

公式の [`/app`（同じ会話を公式アプリで開く命令）](https://learn.chatgpt.com/docs/developer-commands#continue-in-the-desktop-app-with-app)は、**ターミナル内で動くCodexの入力欄**に入れます。Macの通常の命令欄やスマホの会話入力欄には入れません。`codex app <フォルダ>` は作業場所を公式アプリで開く別の命令で、同じ会話を再開できた証拠にはなりません。

本プロジェクトでは、公式アプリとの往復や実行元の共有は**未検証**です。手動で確認するときは、実作業とは別のテスト会話を使います。

1. ターミナル側の作業が終わってから、会話番号・作業フォルダ・最後の回答を控え、Codexの入力欄に `/app` を入れます。
2. 公式アプリに同じ会話と最後の回答が表示されるか確認します。アプリが開いたことや、同じ作業フォルダが見えることだけでは成功としません。
3. 公式アプリ側の作業を完了・保存し、使用権が解放された後、元のMac・作業フォルダで `codex resume <会話ID>`（指定した会話番号から再開する命令）を使います。元の履歴とフォルダを確認してから続きの依頼を送ります。スマホと同じ実行元に戻る場合は、一覧の `>_` でコピーした命令、または「同じ会話に再接続」を使います。

使用中のエラーが残る場合は切替を中止し、元の画面で続けてください。使用権の管理ファイルの削除、会話の複製、利用者のアプリの強制終了で解決しようとしません。公式に `/app` があっても、使用権の解放や往復の成功まで確認できたことにはなりません。公式アプリの画面操作が安全上の制限で拒否される環境では、別の操作経路で迂回せず、オーナーによる画面確認が必要です。

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
- ヘッダー下で、登録済み Mac の Codex・Claude の会話を横断して確認・移動できます。上段には返信待ち・許可待ち・エラー・接続確認・未確認完了・中断・処理中のうち、存在する状態の件数を文字と色で表示します。狭い画面では折り返すため、会話を横スクロールしても件数は隠れません。件数を押すと会話名と状態の一覧が開き、返信・許可待ち、エラー・接続確認、未確認完了、中断、処理中の順に並びます。下段の高さ 48px の会話ボタンは、`Codex mini①` のように担当・機体・会話番号を表示し、位置を保ったまま横スクロールできます。処理中は文字を囲む枠の一部が周回します。完了は緑の `✓`、返信待ち・許可待ちは琥珀色の `?`、エラーは赤の `!`、接続・状態未確認は灰色の `!`、中断は灰色の `−` を枠に重ねます。完了は会話を開いて確認すると消えます。完了・エラーには横並びの会話ボタンと状態一覧の両方に `×` があり、今の会話や下書きを保ったまま表示を片づけられます。会話と履歴は通常の一覧に残ります。片づけた同じ通知は再読み込みや定期更新でも復活せず、その後の新しい完了・エラーは再び表示します。質問・許可待ち・処理中・接続確認には `×` を出しません。確認済み・片づけ済みの通知と通常の待機だけになれば表示は隠れます。未確認情報はこのブラウザ内に保存され、機体から状態を取得できないときは実行中と断定しません。端末の動きを減らす設定では周回を止め、青い部分枠で処理中を示します
- thread status badge と `要対応 / 実行中 / 最近` inbox filter
- 「返信待ち」は本文中の `?` や「確認してください」の有無だけでは決めません。実際に保持している回答・許可の要求を優先し、通常の返答は最後の本文・質問リストに明確な問いかけや返信依頼がある場合に限って判定します。コード、引用、表、例示、用語メモは判定対象から除き、記号を説明した完了報告は完了として扱います。Codex・Claude の処理終了と履歴からの復元に同じ判定を使い、前の処理の質問を次の完了へ持ち越しません。文章の意味を AI に再判定させる仕組みではなく、曖昧な表現をすべて認識する保証はありません
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

### 操作元の名札 {#operation-context}

ヘッダー（=画面上部）の接続先の隣に、小さな「操作元 ?」を表示します。押して「Airで直接」「miniで直接」「Airからminiの画面」などを選ぶと、「操作 Air」「操作 Air·共有」のような名札になります。選択はこのブラウザ内だけに保存され、会話やAI、接続先のMacを切り替えても手元の設定を勝手に変更しません。実行先は接続先のMacが自分の情報を添えます。

名札は対応済みの接続先でだけ表示します。起動時に設定を求める画面を開かず、通知も出しません。選択しなくても依頼を送れます。MacのブラウザからAirとminiや手元の利用者を自動で見分けることはできないため、未設定では手元を未確認として扱います。選択した操作元と画面共有の情報も実測値ではなく、選択から12時間経つと未確認に戻ります。操作方法を変えた場合は名札を押して選び直してください。

自作アプリからの発言ごとに、手元・表示している画面・接続方法・入口・実行先・受信時刻を短い補足としてAIへ渡します。入力した文章、会話名、表示履歴には混ぜず、通常の返答で復唱しないようAIへ伝えます。順番待ちの依頼も発言ごとの操作元と受信時刻を保持します。送信元の指定は固定の選択肢だけを受け取り、命令文や実行先の自己申告は受け取りません。

対象はこのアプリから送るCodex・Claudeへの依頼です。Codexは `additionalContext`（=会話本文と別に渡すアプリの補足情報）に対応するapp-server（=Codexとの通信を受け持つプログラム）が必要で、開発時は0.153.4の生成仕様を確認しています。Claudeは `--append-system-prompt`（=通常の指示に補足を足す起動指定）で渡します。公式アプリやターミナルから直接送った発言、Windows実験室への依頼には、この仕組みから現在の操作元を付与しません。過去の名札を別の入口の現在情報として引き継がないよう、補足の有効範囲も明示しています。

## PWA 注意

通常公開する `site.webmanifest` は token を含まず、`display: standalone` を使います。有効な protected `/install?token=...` page だけが no-store の install manifest を参照し、その `start_url` は credential を URL fragment で渡します。以前の protected access により Safari に credential が残っていれば、短い `/install` URL を開くだけで、ホーム画面へ追加する前に protected install page へ自動再読込します。Safari とホーム画面 Web App は storage が別であるため、この受け渡しが必要です。初回起動時に Web App 自身の local storage へ保存し、fragment は即時削除します。fragment は bridge へ送信されず、無効または token なしの install-manifest request が credential 付き `start_url` を受け取ることもありません。`/install?token=...&provider=codex` のように `provider` を付けると、install page・アイコン・manifest はその provider の画像と名前（例: `Codex mini`）になり、`start_url` にも `provider` が残るため、そのアイコンはその provider で開きます。Claude 既定の bridge でも Codex 用アイコンを作れます。

secure context または localhost では `service-worker.js` を登録し、app shell だけを cache します。通常 manifest、API response、WebSocket、token 付き URL と install manifest、upload、raw file route、terminal history、approval payload は cache しません。LAN HTTP ではブラウザ制約で Service Worker 登録ができないことがありますが、通常の browser UI はそのまま使えます。

ホーム画面に追加した後も、保存された token はその端末の private state として扱ってください。token がない、または rotation した場合は、ホーム画面 Web App の復旧フォームへ local の `.phone-token` / `PHONE_TOKEN` を入力します。または、その Web App を削除し、現在の protected `/install?token=...` URL から追加し直します。Safari で URL を開くだけでは、既にインストール済みの Web App へ Safari の storage はコピーされません。

Web App を削除すると接続先の一覧も一緒に消えるため、各 bridge は最後に同期された一覧の控えを持ちます。入れ直した Web App に有効な token が入ると、インストール元の bridge から控えを読み戻し、他の Mac が手作業の再登録なしで戻ります。控えは最後の同期時点のものです。この機能を配備したあとに一度だけ接続先を登録すれば、以後の追加と削除は自動で backup されます。削除は「一覧から消える」ではなく削除記録として残るため、削除時に閉じていた端末も次の同期でその接続先を落とします。押し戻すことはありません。削除後に登録し直した接続先はそのまま残ります。削除記録の保持は 90 日、最大 256 件です。それより長く offline だった端末は削除済みの接続先を持ち帰り得るので、その場合は登録し直すか、その端末でも削除してください。復元が成功するまで push は行わないため、入れ直した直後の空の一覧が、これから復元する backup を上書きすることはありません。同じ理由で、backup を読めない bridge は上書きせずに同期を止めます。file の場所と token の保護方法は [Security Model](./security.md) を参照してください。
