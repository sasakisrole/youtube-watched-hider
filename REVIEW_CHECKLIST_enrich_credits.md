# REVIEW CHECKLIST: Enrich Credits UI v1.40.0

委託: `projects/youtube-watched-hider/codex/CODEX_PROMPTS.md` (Enrich Credits UI セクション)
設計書: `projects/youtube-watched-hider/DESIGN_enrich_credits.md`
納品レポート: `codex-reports/ad-hoc/yt-watched-hider-enrich-credits_2026-05-16.md`

## 完成判定（14項目・全pass必須）

- [ ] **1. manifest.json**: version="1.40.0" / host_permissions に `https://www.uta-net.com/*` `https://musicbrainz.org/*` 追加
- [ ] **2. composer_rules.json**: 拡張ルート存在・fripSide-Topic / Nobuo Uematsu-Topic の2ルール含む
- [ ] **3. Case 1 (rule適用)**: fripSide-Topic 候補に source="rule" / sim=null / selected=true
- [ ] **4. Case 2 (uta-net高精度)**: sim>=0.95 → selected=true / 行背景緑
- [ ] **5. Case 3 (uta-net要目視)**: sim 0.85-0.95 → selected=false / 行背景黄 / タイトルクリックで youtu.be/{videoId}
- [ ] **6. Case 4 (マッチ失敗)**: sim<0.85 は候補テーブル非表示
- [ ] **7. Case 5 (レート制限)**: SW側で uta-net 1req/秒制御
- [ ] **8. Case 6 (冪等性)**: composer既存値あり → 候補抽出時にスキップ
- [ ] **9. Case 7 (全ソース0件)**: 候補ゼロのチャンネルはタブ非表示
- [ ] **10. Case 8 (rule優先)**: rule該当チャンネルは uta-net 検索スキップ
- [ ] **11. 書き戻し動線**: 確認ダイアログ → 既存値が空のみ上書き → 完了トースト → モーダル閉じる
- [ ] **12. デザイン**: 絵文字なし・Lucide SVG・ネイビー基調・ダークモード対応
- [ ] **13. CHANGELOG.md**: v1.40.0 エントリ先頭追加
- [ ] **14. 既存機能の回帰なし**: az クレジットタブ・fixCreditsForRange・履歴同期が破壊されていない

## 重要な照合データ

### 期待される rule 適用件数（リファレンス: credits-enrich/enrichment_step1.json）
- fripSide - Topic: **123件** (composer=Satoshi Yaginuma)
- Nobuo Uematsu - Topic: **97件** (composer=Nobuo Uematsu)
- 合計: **220件**

### 期待される uta-net マッチ件数（リファレンス: credits-enrich/enrichment_step2_utanet.json）
- HIMEHINA: 43/46 件
- SILENT SIREN: 27/30 件
- DECO*27: 7/7 件
- 合計: **77件**（マッチ精度93%）

### uta-net 検索URLサンプル（手動検証可能）
- fripSide: https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=fripSide
- DECO*27: https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=DECO%2A27
- HIMEHINA: https://www.uta-net.com/search/?Aselect=1&Bselect=4&Keyword=HIMEHINA

## レビュー観点

### 既存ファイル整合
- [ ] history.html の既存ヘッダーレイアウトが崩れていない
- [ ] history.js 既存関数（特に `fixCreditsForRange` history.js:412〜）が温存されている
- [ ] background.js の既存 message handler が壊れていない（既存 case の前後に追加されているか）
- [ ] db.js 変更されていない（grep で diff 確認）
- [ ] content.js / popup.js / analyzer.js 変更されていない

### Chrome MV3 制約遵守
- [ ] content script から直接 uta-net / MB へ fetch していない
- [ ] background SW の message handler 経由でリレー
- [ ] DOMParser を使う場合は offscreen document 経由（既存 offscreen.html / offscreen.js 活用 or 新規追加）
- [ ] レート制御は SW グローバル状態（最終fetch時刻保持・setTimeout待機）

### デザインシステム（AGENTS.md準拠）
- [ ] 絵文字なし（UI要素・コメント問わず確認）
- [ ] アイコンは Lucide SVG inline
- [ ] ネイビー基調（#1e3a5f / #1a5276 / #2980b9 系）
- [ ] ダークモード `prefers-color-scheme: dark` 対応
- [ ] 既存CSS変数（`--text-muted` 等）を流用

### マッチングロジック整合（リファレンス credits-enrich/match.py）
- [ ] タイトル正規化（全半角・記号除去・小文字化）
- [ ] sim計算は difflib.SequenceMatcher 同等（JSは類似ライブラリ or 自作）
- [ ] sim閾値: 0.95 / 0.85 が定数で明示されている

### ロールバック手段（設計書HIDDEN ASSUMPTION対策）
- [ ] 書き戻し前に確定対象 JSON をダウンロードできるボタンがフッターにある
- [ ] ダウンロードJSONには {videoId, composer, lyricist, arranger, source, sim} が含まれる

## 動作確認手順（実機・**未実施・ここから再開**）

リリース済（[v1.40.0](https://github.com/sasakisrole/youtube-watched-hider/releases/tag/v1.40.0)）。実機での動作確認は別タイミングで実施。**再開時は手順1から進める**。

1. `chrome://extensions/` で「パッケージ化されていない拡張機能を読み込む」→ `projects/youtube-watched-hider/` 選択
2. 既存ユーザーは「更新」ボタンで再読み込み
3. version が 1.40.0 になっていることをポップアップで確認
4. history.html を開く（拡張アイコン → 履歴）
5. 「Enrich Credits」ボタンの存在確認
6. ボタン押下 → モーダル開く → 「候補生成」押下
7. 進捗表示・タブ切替・候補テーブルの確認
8. sim≥0.95行が緑、0.85-0.95行が黄になっているか目視
9. ダウンロードボタンで確定対象JSON取得・内容確認
10. 「選択を確定して書き戻し」→ 確認ダイアログ → 完了トースト
11. az タブ（作曲・作詞・編曲）で件数増加を確認
12. 既存機能（履歴同期・概要欄fetch）に回帰がないか確認

## 納品後の追加作業（Claude実施）

Codex納品物の `composer_rules.json` に以下2ルールを追記する（事前調査で確定済・追加14件補完）:

```json
{
  "channel": "YOASOBI - Topic",
  "composer": "Ayase",
  "evidence": "creditsRaw 7曲全件にAyase出現・公知（YOASOBI作詞作曲編曲担当）"
},
{
  "channel": "Berlinist - Topic",
  "composer": "Marco Albano, Luigi Gervasi",
  "evidence": "creditsRaw 7曲全件に両名出現・Italian music duo（GRIS等のサウンドトラック）"
}
```

合計 fripSide(123) + Nobuo(97) + YOASOBI(7) + Berlinist(7) = **234件のrule補完** が初版で可能になる。

## トラブル想定

- **CORS エラー**: host_permissions に追加漏れ。manifest.json 再確認
- **DOMParser エラー**: offscreen document の有無確認。なければ正規表現パースに切替
- **uta-net 検索結果が空**: URL生成のエンコード確認（記号・スペース・日本語）
- **レート制限ヒット（uta-net側）**: SW側の待機ロジック確認・並列実行で1req/秒超えていないか
- **書き戻し後 az タブに反映されない**: 既存 az タブの再集計トリガー確認（手動リロード必要か）
