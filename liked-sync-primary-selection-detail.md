# 高評価同期 primary container 選定の構造アンカー化 詳細

最終更新: 2026-07-11
親PENDING: id:zn5r（PENDING.md「高評価同期: 『どれが本物のリストか』の判定を推測でなく構造で固定する」）
指摘元: Codex 2026-07-10 wrapup-review_8 H1・M2 ＋ 2026-07-11 独立レビュー(R)
対象コード: `projects/youtube-watched-hider/background.js` の `extractItemsAndContinuation` / `syncLikedPlaylist`
テスト: `projects/youtube-watched-hider/tests/verify_liked_sync_robustness.js`（`node` で実行・75 passed）

## 現在地（v1.42.9・2026-07-11）

安全な絞り込みを実装済（新しいアンカーパスの当て推量は入れていない＝v1.42.6 scope-fallback 偽陽性の轍を回避）。

- **② 汎用 envelope を優先材料から除外**: `LL_ITEM_CONTAINERS` を `LL_PRIMARY_RENDERERS`（`playlistVideoListRenderer` / `richGridRenderer`＝プレイリスト固有レンダラ・LL由来の実証拠）と `LL_CONTINUATION_ENVELOPES`（汎用 `appendContinuationItemsAction` / `reloadContinuationItemsCommand`・優先材料から除外）に分割。固有レンダラ配下は件数に関わらず primary を取る＝**構造アンカー**。素の件数比較は最後の fallback に降格。
- **③ 不確実なら partial**: アンカー無しの件数 fallback が**同点**（複数無名配列が最多で並ぶ＝本体を証明不能）のとき `primaryUncertain` を立て、token を信頼せず（`continuationScoped=false`）、caller が `init-browse: primary-uncertain` / `page-N: primary-uncertain` を積んで partial にする。本体が唯一の最多配列＝strict max なら従来どおり確定（通常応答に誤発火しない）。
- **named フラッド遮断（Codex R 指摘）**: `named` を固有レンダラの**直下アイテム配列だけ**に限定。ネストオブジェクトへ降りると継承 named を落とし、そのキー自身が固有レンダラのときだけ再付与。`richGridRenderer.header.shelfRenderer.contents` のような深いネスト棚が named を継承して本体を内側から奪う H1 再侵入を遮断。
- **④ M2 負け筋テスト**: 固有レンダラ本体2件 vs 汎用 envelope 兄弟3件でアンカー勝ち／無名2配列同点で uncertain＋token拒否／Scenario G（end-to-end で大きい兄弟の token を fetch しない）／深いネスト棚3件が本体2件を奪わない。**旧実装／flood版でこれら該当アサーションが RED**（退行検出力を別スクリプトで確認済）。**61 → 75 passed**。

変更は `background.js` のみ（DBスキーマ据え置き＝移行なし）。manifest 1.42.9・CHANGELOG v1.42.9。

## N1 実機スモーク結果（2026-07-11・現物確認済＝推測でなく実応答）

ログイン済みChromeで `https://www.youtube.com/playlist?list=LL` の `ytInitialData`（＝web client の VLLL browse 応答）を診断スニペット（`tests/capture_ll_structure.js`）で構造だけ抽出（PII非送出）。結果:

- **`anyUnderPrimary: false` / `primaryRendererFound: false`**。高評価本体は固有レンダラ配下に**来ない**。
- 実経路（唯一の item-array・len 101・`lockupViewModel`）:
  ```
  contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
    .sectionListRenderer.contents[0].itemSectionRenderer.contents
  ```
  応答中に `playlistVideoListRenderer` / `richGridRenderer` は**一切存在しない**。envelope は `sectionListRenderer` / `itemSectionRenderer`（いずれも汎用）。

### 含意（コードは触らず確定できた事実）

- **`LL_PRIMARY_RENDERERS` アンカーは実応答に一切マッチせず、現行YouTubeでは事実上デッドコード**。選定は常に件数 fallback を通る。
- ただし**現コードは実応答上は安全**: 本体が唯一の item-array ＝ strict max → `primaryUncertain=false`・primary 確定・token scoped。誤選定なし（`node tests/` の新規 `N1 real-structure` 3件で回帰固定・2026-07-11）。
- **最難負け筋は「現状トリガーされない」**（LLページは itemSection が1個）。安全性は「セクションが1個」という現実に依存し、**構造的保証ではない**。tie なら既存 `ambiguousTie` ガードで partial（安全）。strict larger sibling のみ理論上の穴。
- 「初回応答から object path family を学習」する別解は、continuation 応答が別トップ構造（`appendContinuationItemsAction`）のため init の path を直接転用できず、単一サンプルからの位置アンカー（`contents[0]`）焼き込みは **v1.42.6 の偽陽性再生産リスク**＝当て推量禁止に抵触。

## 次回やること（N1完了・残は設計判断）

- ~~N1. 実LL応答の構造を現物確認~~ ✅ **完了（2026-07-11）**: 本体は汎用 envelope 配下・アンカー不発火・現コードは strict-max で安全。
- ~~N2. 実応答 fixture をテストに追加~~ ✅ **一部完了**: `N1 real-structure` fixture（sectionListRenderer > itemSectionRenderer > lockupViewModel[]）を追加し現挙動を固定（103 passed）。最難負け筋の fixture は下の設計判断に依存＝保留。
- **N-decide. 最難負け筋の扱い（設計フォーク・ユーザー判断待ち）**:
  - **B（推奨）**: 現状維持＋本fixture＋本ドキュメント。strict-max は実構造で安全・tie は既存ガードで partial。strict-larger-sibling は YouTube が現状生成しない遠い仮説で、保守的ガードを足すと正常syncを partial 化する偽陽性（当て推量禁止の趣旨に反する）。
  - **A（代替）**: 「無named かつ item-array が2個以上」で strict max でも `primaryUncertain` を立て partial に倒す保守ガード。単一セクション（実構造）は無回帰だが、小さな副次item-arrayが混じる正常応答まで partial 化しうる偽陽性リスク。
  - **C（却下）**: `tabs[selected].content...contents[0]` の位置アンカー焼き込み。単一サンプルからの当て推量＝v1.42.6 の轍。
- **N3. 公開**: 上記決定後、問題なければ `publish-release`（外部・不可逆＝ユーザー判断）。

## 既知の低優先（Codex R Low・様子見）

- drift guard の `extractFn('syncLikedPlaylist')` は次のトップレベル `function` が無く実質ファイル末尾まで検索するため理論上 false positive の余地。実検出力は body-mock（`extractBracedFn`）側にあるため実害は小さい。harness の slice 仕様を触ると他抽出に波及するため据え置き。

## 経緯メモ

- v1.42.7: コンテナ名を「証明→tie-breaker」に降格したつもりだったが、`LL_ITEM_CONTAINERS` に汎用 envelope が残り `walk()` が named をフラッド伝播。兄弟推薦棚が同じ envelope 配下で本体より多い lockup を持つと primary を誤選定し、別セクション動画で高評価DB・推薦・エクスポートを汚染＋token 追従で pagination も逸れる残存穴（H1）。
- v1.42.9（本対応）: 上記②③＋named フラッド遮断で安全な範囲を絞り込み。Codex R が固有レンダラ配下の深いネスト棚という子孫経路を追加指摘→同セッションで修正・テスト追加。
