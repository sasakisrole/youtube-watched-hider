# v1.38.0 実機テスト手順書

Codex 委託（V138_PROMPT.md）完了後、この手順で動作確認する。

## 前提

- Chrome 拡張は開発者モードで `projects/youtube-watched-hider/` を読み込んでいる
- 現行 DB に watched ~23,590 件・liked ~数千件
- **テスト前に必ず Backup Now を1回押す**（拡張 popup → Settings → Backup Now）→ ロールバック先確保

## Section 1: DB v4 → v5 マイグレーション

1. `chrome://extensions/` で拡張をリロード（マイグレーション発火）
2. DevTools → Application → IndexedDB → `YouTubeWatchedDB`
   - **確認**: バージョンが `5` になっている
   - **確認**: `watchedVideos` レコードの1件をクリックし `durationSec` フィールドが存在し `null` になっている
3. Console で以下を実行して全件 null 化を確認:
   ```js
   indexedDB.open('YouTubeWatchedDB').onsuccess = (e) => {
     const tx = e.target.result.transaction('watchedVideos', 'readonly');
     const req = tx.objectStore('watchedVideos').getAll();
     req.onsuccess = () => {
       const all = req.result;
       const withDuration = all.filter(r => r.durationSec !== null && r.durationSec !== undefined);
       console.log(`total=${all.length}, with durationSec=${withDuration.length}, null=${all.length - withDuration.length}`);
     };
   };
   ```
   - **期待**: `total=23590, with durationSec=0, null=23590`（マイグレ直後）

**ロールバック手順**（マイグレ失敗時）:
- `chrome://extensions/` で拡張を削除 → 再インストール
- popup から手動 Export した v2 envelope を Import

## Section 2: 新規視聴時の durationSec 記録

1. YouTube で任意の動画を1本再生（途中まででOK）
2. Section 1 の Console スクリプトを再実行
   - **期待**: `with durationSec=1` 以上
3. seekbar 検出経由のテスト:
   - 別の動画を開いてシークバーをドラッグ
   - Console で `with durationSec` が更に増えることを確認
4. ライブ配信 / プレミア公開動画を再生
   - **期待**: `durationSec = -1` でマークされる（Console で `r.durationSec === -1` のレコードを確認）

## Section 3: FIX_DURATIONS バックフィル

1. analyzer タブを開く（拡張アイコン → Analyze）
2. Fix Durations ボタンを押す（Codex 実装に依存・popup または analyzer のどこかに配置されるはず）
3. **100件サンプル** で先に走らせる（DEFAULT が全件なら abort で止める）
4. 進捗 UI で以下を確認:
   - `processed / total` がカウントアップする
   - `updated` が増える
   - `fetchFailed` がほぼゼロ（>10% なら異常・sorry-redirect 多発の疑い）
5. abort してから再開し、重複処理されないことを確認
6. 問題なければ全件（~11,500件）走らせる
   - 想定時間: 約2-3時間（CONCURRENCY=2, DELAY_MS=500）
   - bot 判定で auto-stop した場合、しばらく待ってから再開

## Section 4: Analyzer 累計時間表示

1. analyzer → チャンネル別タブ
   - **確認**: 「合計時間」列が表示される
   - **確認**: 上位チャンネルで `12時間34分` 等の形式で表示
   - **確認**: null 混入時 `（うち N件 不明）` 併記
2. analyzer → クレジット別タブ（作曲・作詞・編曲・未割当の各タブ）
   - **確認**: 同様に「合計時間」列が表示される
3. ソート切替（再生数 ↔ 合計時間）が動く
4. ツールチップで「実視聴時間ではない」旨が表示される

## Section 5: リグレッション確認

- popup の件数表示が崩れていない
- Auto Backup が引き続き動く（v1.36.0 で導入の Blob URL 経路）
- v2 envelope の Export が `durationSec` フィールドを含む（手動 Export → JSON 確認）
- v1 raw array / v1 envelope の Import が引き続き成功する
- Fix Credits が引き続き動く（FIX_DURATIONS と同じバッチ基盤を流用しているはず）

## Section 6: パフォーマンス確認

- 新規視聴時の `durationSec` 取得で watch ページの表示が遅延しない
- Analyzer の合計時間集計で UI が固まらない（23,590 件で <1秒目標）

## NG 時の対処

| 症状 | 対処 |
|---|---|
| マイグレ失敗（DB が開けない） | 拡張削除 → 再インストール → Backup Now の JSON を Import |
| FIX_DURATIONS で sorry-redirect 多発 | 1時間待ってから再開・並列度をさらに下げる（Codex に再委託） |
| 合計時間の表示が崩れる | analyzer.js の formatter ロジックを Codex 完了レポートで確認 |
| null/未取得が多すぎる | バックフィルが終わっていないだけ。Section 3 を完走させる |
