# 後で見る（Watch Later）一括整理 — Round A/B 実装メモ

- 起点: ChatGPT引き継ぎ `claude-code-handoff-20260807-230154-youtube-watch-later-cleanup.md`（I-001〜I-102）
- 実装日: 2026-08-07
- 状態: **非破壊スキャンまで完了。削除は未実装**（Round C以降）

## これは何をするものか

「後で見る」に溜まった動画のうち、Watched Hider が視聴済みとして持っている動画を
まとめて消すための機能。今回はその**前半だけ**を作った。

いま押せる `照合` ボタンがやること:

1. 後で見るを全ページ取得する
2. 視聴済みデータベースと videoId で突き合わせる
3. 「後で見る N件 / 視聴済み一致 N件 / 未視聴 N件」と件数を出す

**この段階では1件も削除しない。** 後で見るにも視聴済みDBにも一切書き込まない。

## 引き継ぎ時点の前提のうち、実測して違っていたもの

| 項目 | 引き継ぎMD | 実測(2026-08-07) |
|---|---|---|
| manifest版 | v1.42.14 (I-017) | v1.43.11 |
| ブランチ/HEAD | `recovery/...` `ffec313` (I-018) | `main` / `6a63017` / 差分なし |
| `w2mp §8.1` アカウント固定 (I-095) | 未実装か要確認 | **実装済み**（高評価同期で稼働中） |

I-032（`X-Goog-AuthUser` 決め打ちを避け `SESSION_INDEX` を基準にする）も既存実装が
すでにその設計。今回はそれを流用しただけで、新規に作っていない。

## 追加・変更したファイル

| ファイル | 変更 |
|---|---|
| `watch_later_core.js` | **新規**。削除可否の判断だけを持つ純粋ロジック（chrome API・通信・DBに触れない） |
| `background.js` | `importScripts` 追加／共有抽出器が `setVideoId` も拾うように／`scanWatchLater()` と `SCAN_WATCH_LATER` メッセージを追加 |
| `history.html` / `history.js` | メンテナンス行に `後で見る > 照合` ボタンと結果表示 |
| `tests/verify_watch_later_core.js` | **新規**。43チェック |
| `tests/fixtures/watch_later_browse.json` | **新規**。合成VLWLレスポンス |
| `tests/verify_liked_sync_robustness.js` | 抽出器のスライス位置に新関数が挟まったため追随 |
| `scripts/build_dist.py` | `importScripts()` の参照を辿るように（後述） |

## 埋め込んだ安全ルール（テストで固定済み）

- **削除の宛先は `videoId` ではなく `setVideoId`**（その動画の「その行」のID）。同じ動画を
  2回入れていれば行は2つあり、`videoId` で潰すと片方だけ消えて両方消えたように見える。
- **DBが答えられなかった動画は候補に入れない**。`true`/`false`/`undefined` の三値で扱い、
  DBエラーを「未視聴」に変換しない（既存 §8.3 の方針を踏襲）。DB照合そのものが失敗したら
  件数を出さずに中止する（「一致0件」と「DBが読めなかった」を混同させない）。
- **おすすめ棚を混ぜない**。同じレスポンスに同居する推薦動画は `loose` として捨て、
  ページ送りのトークンも後で見る本体のコンテナ由来のものしか辿らない（既存の高評価同期と同じ防御）。
- **アカウント固定**。開始時のタブID・`SESSION_INDEX`・アカウントIDを固定し、取得後にもう一度
  照合する。途中で変わっていたら結果ごと破棄する。
- **`setVideoId` が取れなかった行は候補外**。宛先が作れない行を videoId で推測しない。
- **再特定は一意のときだけ**（`findUniqueRowByVideoId`）。同じ videoId の行が複数あるときは
  `ambiguous` を返して呼び出し側に判断させる（Round Dで使う）。

## build_dist.py を直した理由（release-blocker だった）

`watch_later_core.js` は background.js の `importScripts()` からしか読まれない。
dist のホワイトリストは manifest とHTMLの参照しか辿っていなかったため、**このファイルが
zipから落ちて、パッケージ版だけ service worker が起動時に丸ごと落ちる**状態だった
（開発版=フォルダ読み込みでは再現しない）。`importScripts()` を辿るようにして解消。
dry-run のホワイトリストは 28件 → 29件。

## まだ確定していないこと（Round Cの前に必要）

1. **fixtureは合成**。2026年の実 `VLWL` レスポンスの renderer 構造・`setVideoId` の実際の
   位置は未確認（I-093）。実機で1回キャプチャして `tests/fixtures/watch_later_browse.json`
   を差し替えるまで、テストが守っているのは「決めたルール」であって「実レスポンスとの整合」ではない。
2. **`/youtubei/v1/browse/edit_playlist` の実ヘッダ・payload 未確認**（I-094）。外部スクリプトの
   決め打ちを採用せず、実通信を見てから確定する。
3. **UIの置き場**。いまは history.html のメンテナンス行に最小構成で置いた。削除対象一覧を
   出す画面（I-044）は未着手。

## 次の手順

1. **実機スモーク（非破壊）**: 後で見るに3〜5本入れた状態で `照合` を押し、件数が実際と
   合うか確認する。ここで数が合わなければ fixture を実レスポンスで差し替える。
2. Round C: 1件削除（`setVideoId` 指定）。**破壊操作なので着手前にけんとの承認が必要**。
3. Round D: 削除直前の再照合・古い `setVideoId` の再取得・曖昧時停止。
4. Round E/F: 中止・通信失敗・他端末変更、実機スモークとprivacy説明の更新。

## テスト

```bash
node projects/youtube-watched-hider/tests/verify_watch_later_core.js
```

2026-08-07時点で `tests/verify_*.js` 全24本 PASS（新規43チェックを含む）。
