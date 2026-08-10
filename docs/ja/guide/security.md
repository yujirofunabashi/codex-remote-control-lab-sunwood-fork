# Security Model

この project は local-first を前提にしています。

## 公開安全の既定値

- Codex app-server の例は `127.0.0.1` に bind します。
- LAN に出る server は phone bridge だけです。
- page、API、WebSocket bridge request は同じ token を要求します。
- `.phone-token`、`.uploads/`、`.codex-home*/`、log、session database は Git に入れません。
- `.phone-fleet.local.json`、`.phone-bridges.local.json`、`.phone-bridges.<port>.local.json`、`.phone-registry-key`、browser bridge registry state は local-only として扱います。
- 起動通知の credential と token 付き URL の通知先は、private/protected な account、topic、channel に限定してください。

## 避けること

認証なしの Codex app-server を LAN や public interface に直接 bind しないでください。

信頼済み local network 外から使う場合は、次を優先します。

- SSH port forwarding
- VPN
- device-level authentication 付き mesh network

## Token Handling

`PHONE_TOKEN` が未指定の場合、bridge は mode `0600` の `.phone-token` を作ります。token を rotate するときは `.phone-token` を削除します。

bridge は、phone が持つ接続先一覧の控えを `.phone-bridges.<port>.local.json` にも保存します。ホーム画面のアプリを入れ直したときに復元するためのものです。この file の中の bridge token は `.phone-registry-key` を鍵として AES-256-GCM で暗号化します。鍵 file は同じ場所に mode `0600` で生成されます。base URL や label など、それ以外の項目はそのまま読めます。phone 側で「記憶しない」を選んだ token は backup に送りません。暗号化は、backup の巻き込みや file の貼り付けなど、JSON だけが手元を離れた場合に token を守るためのもので、すでに account を握っている相手への対策ではありません。backup を破棄するときは 2 つの file を一緒に削除します。鍵だけを削除すると registry は fail-closed になり、削除するまで同期が止まります。

## 初心者向けの運用メモ

- 表示された `?token=...` 付き URL は local access key として扱います。開ける人は、その実行中の bridge を操作できます。
- token 付き URL を公開 issue、共有チャット、スクリーンショット、配信に貼らないでください。
- bridge は `npm run phone` を実行している terminal で `Ctrl+C` を押すと停止します。
- terminal を閉じた場合や PC を再起動した場合、bridge は止まります。使うときはもう一度 `npm run phone` を実行します。
- bridge は root/admin shell ではなく、通常のユーザー権限で実行します。
- 認証なしの public tunnel や raw port forwarding で bridge を公開しないでください。SSH forwarding、VPN、device authentication 付き mesh network などの trusted access を前に置いてください。
- fleet UI を任意 URL へ到達できる open proxy にしないでください。cross-bridge の読み取りや approval 操作は token protected で、登録済み/private bridge URL に限定します。
