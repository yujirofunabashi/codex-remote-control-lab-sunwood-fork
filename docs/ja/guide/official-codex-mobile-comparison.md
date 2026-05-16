# 公式 Codex Mobile との違い

この repository は公式モバイルクライアントの代替ではありません。Codex CLI の remote-control / app-server ワークフローを local-first に扱うための LAN bridge 実験です。

## 目的

Codex Remote Control Lab は Codex app-server を `localhost` / `127.0.0.1` に閉じたまま、trusted browser 向けに token-protected phone bridge だけを公開します。CLI / headless / worktree 運用、LAN / VPN / mesh 経由の確認、スマホからの監視・承認・レビュー・方向転換に向いています。

## 主な違い

| 項目 | 公式 Codex mobile 風の体験 | この repository |
| --- | --- | --- |
| 信頼境界 | account-managed な接続と managed relay | self-hosted local bridge と local access token |
| ネットワーク | managed service path | LAN / SSH forwarding / VPN / mesh network |
| app-server | 利用者が直接公開しない | Codex app-server は localhost 固定、LAN に出すのは bridge のみ |
| UI | 公式 mobile app 体験 | thread 状態、承認、Review Center、health、通知を持つ browser/PWA work inbox |
| device authorization | account / device managed | token 管理は利用者責任 |

## 使い分け

account-managed な設定、managed security boundary、製品として支援される mobile 体験が必要なら公式を使ってください。

local Codex CLI / app-server の実験、headless worktree のスマホ監視、LAN / VPN / mesh 前提の remote control、または reusable な local-first bridge 実装が必要なら、この repository が向いています。

## 安全な使い方

- Codex app-server は `localhost` / `127.0.0.1` に閉じる。
- LAN に出すのは token-protected phone bridge だけにする。
- 完全な `?token=...` 起動 URL は local access key として扱う。
- 認証なし public tunnel や raw port forward は使わない。
- trusted LAN の外では SSH forwarding、VPN、device-authenticated mesh network を使う。
- `.phone-token`、uploads、session database、logs、private screenshots、webhook URL、local config は Git に入れない。

## 実装済み機能

- thread resume
- approval
- Summary / Diff / Tests / Terminal / Artifacts / Actions を持つ Review Center
- private な ntfy / Pushover / Discord 設定を使った event notification
- health panel
- token / API response を cache しない PWA app shell

## 既知の制限

これは完全な secure relay ではなく、account-managed device authorization でもありません。安全性は LAN、VPN、SSH forwarding、mesh network の信頼境界に依存します。token の保存、共有範囲、rotation は利用者責任です。
