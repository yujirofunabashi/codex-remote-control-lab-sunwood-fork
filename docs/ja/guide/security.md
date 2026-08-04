# Security Model

この project は local-first を前提にしています。

## 公開安全の既定値

- Codex app-server の例は `127.0.0.1` に bind します。
- LAN に出る server は phone bridge だけです。
- page、API、WebSocket bridge request は同じ token を要求します。
- `.phone-token`、`.uploads/`、`.codex-home*/`、log、session database は Git に入れません。
- 起動通知の credential と token 付き URL の通知先は、private/protected な account、topic、channel に限定してください。

## 避けること

認証なしの Codex app-server を LAN や public interface に直接 bind しないでください。

信頼済み local network 外から使う場合は、次を優先します。

- SSH port forwarding
- VPN
- device-level authentication 付き mesh network

## LAN 外のスマホへ URL を渡す

mesh VPN や VPN でこのマシンに到達できる状態なら、bridge 側の変更は不要です。token mode では `0.0.0.0` に bind し、非 internal な IPv4 address をすべて列挙するため、Tailscale の `100.64.0.0/10` address も LAN address と並んで表示されます。

`npm run url:remote` はその URL を組み立て、token を画面に出さずに渡します。

```bash
npm run url:remote            # mesh address を優先、token は伏字
npm run url:remote -- --qr    # スマホで読み取る (qrencode が必要)
npm run url:remote -- --copy  # clipboard へ直接、画面には出さない
```

`PHONE_TOKEN` または `.phone-token` を読み、`tailscale` が PATH にあれば MagicDNS 名を使います。`--reveal` を付けない限り token は伏字です。`--qr` か `--copy` を使ってください。伏字の URL は画面に残しても安全ですが、表示した URL はそのまま access key です。

端末間で移すために、token 付き URL を chat、issue、スクリーンショットへ貼らないでください。clipboard、QR、または [Phone Bridge](/ja/guide/phone-bridge) の private な通知チャネルを使ってください。

## Token Handling

`PHONE_TOKEN` が未指定の場合、bridge は mode `0600` の `.phone-token` を作ります。token を rotate するときは `.phone-token` を削除します。

`PHONE_DEBUG_NO_TOKEN=1` は token なしデバッグ用の switch です。単独では bridge を `127.0.0.1` に bind し、token を作成・要求しません。

`PHONE_DEBUG_BIND=lan` は token なし LAN デバッグを明示的に有効化する bind 設定です。`PHONE_DEBUG_NO_TOKEN=1` と一緒に、自分が管理する信頼済み private network でだけ使い、public tunnel や raw port forward では使わないでください。

## 初心者向けの運用メモ

- 表示された `?token=...` 付き URL は local access key として扱います。開ける人は、その実行中の bridge を操作できます。
- token 付き URL を公開 issue、共有チャット、スクリーンショット、配信に貼らないでください。
- token なしデバッグ URL を host machine の外へ公開しないでください。
- bridge は `npm run phone` を実行している terminal で `Ctrl+C` を押すと停止します。
- terminal を閉じた場合や PC を再起動した場合、bridge は止まります。使うときはもう一度 `npm run phone` を実行します。
- bridge は root/admin shell ではなく、通常のユーザー権限で実行します。
- 認証なしの public tunnel や raw port forwarding で bridge を公開しないでください。SSH forwarding、VPN、device authentication 付き mesh network などの trusted access を前に置いてください。
