# tests/ — live smoke harness

自動で回る実機スモークテスト置き場。手動で拡張を触らずに、実際にロードした拡張の挙動を検証する。

## smoke_duration_videoid_gate.py — duration の videoId ゲート（PENDING id:8v48 / v1.42.4）

### 何を守るテストか

`getCurrentVideoDurationSec()` は現在動画の長さを `ytInitialPlayerResponse`（`document.scripts` を走査）から取る。YouTube の SPA 遷移後、**前動画の `ytInitialPlayerResponse` script が `document.scripts` に残る**ことがあり、videoId 照合が無いと現在動画に**前動画の長さ**を保存してしまう（長さ分布・長さ別嗜好が静かに汚染）。v1.42.4 で `getInitialPlayerResponseDurationSec(expectedVideoId)` に videoId ゲートを追加し、`videoDetails.videoId` が一致する player response だけ採用するようにした。

### やり方（決定論・自己検証・teeth 付き）

Playwright で **アンパック拡張をロードした Chromium** を起動し、実際の非ライブ watch ページ(B)で以下を再現する：

1. **domAgrees ゲートを確定**：`ytd-watch-metadata` の先頭に自己 `/watch?v=B` リンクを挿入（自然なゲートは「説明欄に他動画リンクが先頭に来る」ページで不安定なため。B にいるのは事実なので faithful）。
2. **stale 罠を注入**：前動画相当の `ytInitialPlayerResponse`（`lengthSeconds=9999`）を `document.scripts` の**先頭**に挿入（SPA 残留を模擬。YT は Trusted Types を強制するので `createTextNode`+`appendChild` で回避。拡張は textContent を**読む**だけ）。
3. **合成 `ended` を dispatch** → 出荷版 `recordCurrentVideo()` → `getCurrentVideoDurationSec(B)` が走る → 拡張所有の IndexedDB（offscreen origin・history.html 経由）から保存値を読む。

2ケースで「videoId 一致/不一致で結果が正確に反転する」ことまで確認する：

- **distinct 罠**（罠の videoId ≠ B）：ゲートが罠を**skip** → 保存値 = B の実長（≠9999）。**これが回帰ガード**（旧コードは先頭の罠を拾い 9999 を返す）。
- **match 罠**（罠の videoId = B）：ゲートが罠を**受理** → 保存値 = 9999。罠が本当に観測可能＝ハーネスに teeth がある証明（旧・新コードとも同じ挙動）。

罠は常に `document.scripts` の idx0、B の実 script は後方（例: idx30）＝**旧コードなら必ず罠を先に拾う配置**。それでも distinct で B の実長になれば videoId ゲートが効いている決定的証拠。

### 実行

```bash
python3 projects/youtube-watched-hider/tests/smoke_duration_videoid_gate.py
#   --headed    可視ウィンドウを強制（既定は headless=new を試し、拡張がロードできなければ headed に自動フォールバック）
#   --video ID  テスト動画を差し替え（非ライブ・有限長であること）
```

終了コード: `0`=PASS / `2`=FAIL（回帰・汚染検出）/ `1`=ハーネスエラー・inconclusive。

### 前提・制約

- **Playwright(python) + Chromium バイナリ**が必要（`pip install playwright` → `playwright install chromium`）。本PCは導入済み（playwright 1.58 / chromium-1208）。
- 現状 **headless では拡張がロードできず headed 実行**になる（自動フォールバック）。全自動で起動→検証→終了するが、実行中に Chromium ウィンドウが一瞬出る。
- fresh profile（毎回 tempdir）で起動するため、既存の視聴履歴には触れない。
- SPA を実クリックで踏むのではなく stale script を**注入して**ハザードを決定論的に再現している（実 YT が実際に stale script を残すことは確認済み。注入は faithful かつ regression 検出力が高い）。

### 関連

- 修正コミット/挙動: `content.js` `getInitialPlayerResponseDurationSec` / `getCurrentVideoDurationSec` / `recordCurrentVideo`、`CHANGELOG.md` v1.42.4
- 合成ユニット検証（関数抽出・8ケース）は別途 v1.42.4 で実施済み。本ハーネスは実ブラウザ統合＋アドバーサリアル層。
