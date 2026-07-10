# Sunwood upstreamを参考にしたUI/UXブラッシュアップ

## 対象

phone bridgeのデスクトップ表示を1280 x 720、モバイル表示を390 x 844で確認した。比較元は公開されている[Sunwood upstream repository](https://github.com/Sunwood-ai-labs/codex-remote-control-lab)、特に[PR #43](https://github.com/Sunwood-ai-labs/codex-remote-control-lab/pull/43)とした。

## 今回採用した改善

- stream出力中も読者のチャット位置を維持する。読者が末尾から72px以内にいた場合だけ最新出力を自動追従する。
- `viewport-fit=cover`を有効化し、既存のsafe-area CSSをiPhoneのstandalone／full-screen表示でも機能させる。
- 設定、自動処理、モデル、接続状態などのutility panelではReview Center tabを隠す。
- PWA shell cacheを更新し、ホーム画面へ追加済みのクライアントにも新しいUI assetを配信する。

## 次回以降に有望なupstream案

- directory、session名、path、run state、swipe方向を整理したsession switcherの視覚階層。
- 高さ30px程度に抑え、競合するmetadataを減らしたworkspace strip。
- 新しい状態管理を増やさず、既存run stateを再利用した控えめなlive indicator。

## 取り込み方針

upstreamとこのforkは大きく分岐し、現在のUI source構造も異なる。このforkではstaticな`public/index.html`、`public/main.js`、`public/style.css`構成を維持する。UI branch全体のmergeやcherry-pickは避け、再利用できるinteractionだけを小さなテスト付き変更として手移植する。

## 検証

- JavaScript syntax check
- Node test 99件
- mobile smoke check 48件
- VitePress documentation build
- desktop／mobile screenshot比較
