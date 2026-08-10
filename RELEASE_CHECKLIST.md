# リリースゲート（Chrome Web Store 提出の手順）

提出物の再現性を、勘でなく機械判定で確定させるための手順。守るのは1点だけ——**tag が指すコミットの中身と、`dist/` と提出 ZIP が同じ bytes であること**。

順番には意味がある（末尾の「順番を入れ替えない理由」参照）。途中で NG が出たら、その先へ進まず作り直す。

作業ディレクトリはリポジトリ直下（`projects/youtube-watched-hider/`）。

---

## Step 0. 前提の確認

```bash
git rev-parse --abbrev-ref HEAD   # main であること
git status --short                # 空であること（未コミットの変更を抱えたまま版を切らない）
git describe --tags               # 直前の tag と、そこから何コミット進んでいるか
git branch --no-merged main       # 未統合ブランチの棚卸し
```

- **版番号は「未統合ブランチが既に使った番号」を飛ばす**。作業ブランチ側で `1.43.12` を消費済みだったため、main の次版は `1.44.0` にした（2026-08-10）。
- **`scripts/` は `.gitignore` 済み＝Git 管理外**。ブランチを切り替えても中身が付いてこないので、`build_dist.py` / `verify_dist_hashes.py` は常に「今ローカルにある版」が動く。切り替え直後は挙動を疑う。
- `dist/` と `*.zip` も `.gitignore` 済み。Step 5 以降でビルドしても作業ツリーは汚れない。

## Step 1. 版を上げる

- `manifest.json` の `version`
- `CHANGELOG.md` の先頭に `## vX.Y.Z (YYYY-MM-DD)` を追加（何が変わったか・テスト結果・提出前の確認観点）

この2つが正本。ほかの場所に版番号を手書きしない。

## Step 2. 更新情報画面を再生成する

```bash
python3 tools/build_whatsnew.py
python3 tools/build_whatsnew.py --check
```

`whatsnew_data.js` は CHANGELOG からの生成物。`--check` が非ゼロなら再生成し忘れ（`tests/verify_whatsnew.js` からも同じ検査が走る）。

## Step 3. 全テストを通す

```bash
fail=0; n=0
for f in tests/verify_*.js; do n=$((n+1)); node "$f" >/dev/null 2>&1 || { echo "FAIL: $f"; fail=$((fail+1)); }; done
echo "harness=$n failed=$fail"
```

**`failed=0` でなければ先へ進まない**。件数（現在 29 本）は版とともに増える。減っていたらファイルの取りこぼしを疑う。

Playwright を使う `tests/smoke_*.py` はこのループに含まれない（実ブラウザが要る別枠）。

## Step 4. commit する

ソースをここで確定させる。以降の手順は「このコミットの中身」を配布物へ写す作業なので、**commit 後にソースを触ったら Step 3 からやり直す**。

## Step 5. dist と ZIP を再生成する

```bash
python3 scripts/build_dist.py --dry-run   # 何を入れて何を外すかの確認（書かない）
python3 scripts/build_dist.py             # dist/ を作り直し、ZIP を作る
```

- 参照ファイルの実在チェック・重要ファイルの同梱チェック・`dist/manifest.json` の版一致まではここで落ちる。
- 「ホワイトリスト外のトップレベル *.html」の警告が出たら、実行時に開くエントリポイントなら `EXTRA_HTML_ENTRYPOINTS` へ追記してから作り直す。

## Step 6. SHA-256 で検算する（ゲート本体）

```bash
python3 scripts/verify_dist_hashes.py
```

root / `dist/` / ZIP の全ファイルについて SHA-256 を照合し、ZIP の余剰エントリも見る。**終了コードが 0 以外なら、tag も提出もしない**。検出する取り違えは次の4つ。

| 症状 | 意味 |
|---|---|
| root と dist が不一致 | dist が古い（作り直さずに原本を直した） |
| dist と zip が不一致 | ZIP が古い（前の版の ZIP が残っている） |
| 原本が root に無い | dist だけに残った残骸 |
| 余剰エントリ | dist に無いものが ZIP に入っている |

## Step 7. tag を打つ

```bash
git tag vX.Y.Z
git describe --tags   # vX.Y.Z（HEAD ちょうど）になること
```

## Step 8. 記録する

`PENDING_DETAIL.md` の該当項目に、commit hash / tag / ZIP 名・バイト数・ファイル数 / テスト結果を残す。次に「公開版はどれか」を調べるときの一次情報になる。

## Step 9. 提出する（けんと）

- ストアへ ZIP をアップロードする。**同じフォルダに旧版の ZIP が並んでいる**ので、ファイル名の版を必ず確認する。
- `origin/main` への push は提出とは別の判断（このリポジトリは push 前提で運用していない）。
- 実機の目視確認は CHANGELOG の「確認観点」と `private-audit/SMOKE_CHECKLIST_2026-07-17.md` に従う。

---

## 止める条件

- Step 3 が `failed=0` でない
- Step 5 が ERROR で終わる
- Step 6 が非ゼロ
- Step 0 で作業ツリーが汚れている、またはブランチが main でない

いずれも「直してから最初からやり直す」であって、先へ進んで後で直すのではない。

## 順番を入れ替えない理由

- **テストと commit を dist 生成より先にする**: 後からソースを直すと、その修正が入っていない dist を提出することになる。原本と配布物が食い違う事故はここから起きる。
- **tag を検算より後にする**: 先に tag を打つと、検算に通らなかった成果物へ版番号が固定される。tag は「この中身で出す」という宣言なので、確定してから打つ。
