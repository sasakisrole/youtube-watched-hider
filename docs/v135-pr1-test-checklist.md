# v1.35.0 PR1 実機テストチェックリスト

Codex実装完了後に実施する。

## 事前準備

- [ ] v1.34.4 の状態で watched 100件以上・liked 10件以上あることを確認
- [ ] Chromeのデベロッパーモード拡張で v1.35.0 をロード（既存の v1.34.4 と差し替え）
- [ ] DevTools Console を開いておく（background SW とoffscreen のエラー監視）

---

## 1. 既存データ移行

- [ ] v1.35.0 ロード直後、YouTubeを開かずに popup を開く
  - → 「一度YouTubeを開いてください」バナーが表示される
- [ ] YouTubeタブを開く
  - → Console に移行ログが出る（エラーなし）
  - → popup の件数が旧DB と一致する
- [ ] watched 全件数・liked 全件数が移行前後で一致すること（DevTools IndexedDB で確認）
- [ ] `chrome.storage.local.migrationV135Done === true` になっていること
- [ ] 再度 YouTubeを開き直しても重複インポートされないこと

---

## 2. YouTubeタブなしで動く機能

- [ ] YouTube タブを**全て閉じた状態**で popup を開く → 件数・最終バックアップ日時が表示される
- [ ] YouTube タブなしで History Viewer（history.html）を開く → 視聴履歴一覧が表示される
- [ ] YouTube タブなしで手動 Export → JSON ファイルがダウンロードされる
- [ ] YouTube タブなしで Auto Backup（alarmトリガー or Backup Now）→ ファイルが作成される

---

## 3. YouTubeタブありで動く機能（既存動作の維持確認）

- [ ] YouTube を開いて動画を再生 → watched に記録される
- [ ] ホーム・検索・関連動画から視聴済み動画が非表示になる
- [ ] Liked Sync（高評価プレイリスト同期）が実行できる
- [ ] Fix Credits が実行できる
- [ ] Analyzer が高評価タブを表示できる

---

## 4. offscreen document の動作

- [ ] DevTools → chrome://extensions → SW inspect で `ensureOffscreenDocument()` が1回だけ呼ばれること
- [ ] offscreen.html が chrome://extensions の "Active Views" に表示される
- [ ] 複数のpopup操作を連続しても offscreen が2個以上作られないこと

---

## 5. エラーハンドリング

- [ ] 移行中にネットワークエラーが起きた場合（シミュレート）→ `migrationV135Done` が false のまま次回 YouTube 訪問時に再試行できる
- [ ] DB upgrade blocked のメッセージが UI に表示されること（古いタブを残したまま拡張更新をシミュレート）

---

## 確認環境

- Chrome バージョン: ___________
- OS: Windows 11
- 実施日: ___________
- 実施者: ___________
