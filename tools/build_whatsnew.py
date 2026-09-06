#!/usr/bin/env python3
"""CHANGELOG.md から拡張内「更新情報」画面のデータ（whatsnew_data.js）を生成する。

なぜ生成するのか:
  更新履歴を CHANGELOG.md と画面用テキストの2箇所で手書きすると、必ず片方が古くなる。
  正本は CHANGELOG.md ただ1つにして、画面用データはここから機械生成する。

なぜ実行時パースにしないのか:
  拡張から CHANGELOG.md を fetch すると、配布物への同梱漏れ・Markdown パーサの
  持ち込み・CSP の各リスクを runtime に持ち込むことになる。生成済み JS を
  同梱するほうが失敗する余地が小さい。

画面へ出さない行:
  `- Test:` と `- 注意:` で始まる項目は開発の記録なので、生成物には含めない
  （CHANGELOG.md 側には残す）。詳細は DEV_ONLY_PREFIXES のコメント。

使い方:
    python3 tools/build_whatsnew.py            # whatsnew_data.js を書き出す
    python3 tools/build_whatsnew.py --check    # 生成物が最新かだけ検査（書かない・非ゼロで不一致）

--check は tests/verify_whatsnew.js から呼ばれ、「CHANGELOG を更新したのに
再生成し忘れた」を機械で落とす。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
OUTPUT = REPO_ROOT / "whatsnew_data.js"

VERSION_RE = re.compile(r"^## v(?P<version>[\w.]+)\s*(?:\((?P<date>[^)]*)\))?\s*$")
# 強調（**...**）・インラインコード（`...`）・リンク（[表示](url)）を素のテキストへ落とす。
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
CODE_RE = re.compile(r"`([^`]+)`")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
WARN_MARK = "⚠️"
DONE_MARK = "✅"
# CHANGELOG は開発の記録も兼ねているが、この生成物は拡張の「更新情報」画面＝利用者が
# 読む面。テスト本数・感応性・実機スモークの確認観点は、読んでも利用者の行動が変わらず、
# 「未検証です」と伝えるだけで対処のしようもないので画面へは出さない。CHANGELOG 側には
# 残すので記録は失われない。
# 「Test:」だけでなく「Test(M2・負け筋を固定):」のような添字付きも同じ扱い。
TEST_RE = re.compile(r"^Test\s*[(（:：]")
SMOKE_PREFIX = "実機スモーク"
CAUTION_PREFIXES = ("注意:", "注意：", WARN_MARK, WARN_MARK[0])
# 注意書きは開発メモと利用者向け警告が混ざっている（「登録し直しが必要」のような
# 本物の警告もある）ので、頭だけでは切り分けられない。開発メモ側にだけ出る語で判定する。
# 逆に「注記: v1.42.1 を含めて一括公開」のような、たまたま同じ語を含むだけの
# 利用者向けの行は落とさない（頭が注意書きでなければ判定に入らない）。
DEV_NOTE_RE = re.compile(r"実機スモーク|確認観点")


def is_dev_only(body: str) -> bool:
    """開発の記録であって、利用者向けの更新情報ではない行か。"""
    text = body.replace("*", "").lstrip()
    if TEST_RE.match(text) or text.startswith(SMOKE_PREFIX):
        return True
    return text.startswith(CAUTION_PREFIXES) and bool(DEV_NOTE_RE.search(text))


def to_plain(text: str) -> str:
    text = LINK_RE.sub(r"\1", text)
    text = BOLD_RE.sub(r"\1", text)
    text = CODE_RE.sub(r"\1", text)
    # UI に絵文字を出さない方針（AGENTS.md / html-creation ルール）。CHANGELOG が
    # 強調記号として使っている警告・完了マークは、文頭なら言葉へ、途中なら落とす。
    text = text.strip()
    for mark, label in ((WARN_MARK, "注意: "), (DONE_MARK, "")):
        if text.startswith(mark):
            text = label + text[len(mark):]
    text = text.replace(WARN_MARK, "").replace(DONE_MARK, "")
    # 異体字セレクタ無しの裸の警告記号（旧エントリが引用しているUI文言に混じる）も落とす。
    text = text.replace(WARN_MARK[0], "")
    return " ".join(text.split())


def parse_changelog(markdown: str) -> list[dict]:
    entries: list[dict] = []
    current: dict | None = None
    for raw_line in markdown.splitlines():
        heading = VERSION_RE.match(raw_line.strip())
        if heading:
            current = {
                "version": heading.group("version"),
                "date": (heading.group("date") or "").strip(),
                "summary": "",
                "points": [],
            }
            entries.append(current)
            continue
        if current is None:
            continue
        line = raw_line.strip()
        if not line or line.startswith(">"):
            continue
        if line.startswith("- "):
            if is_dev_only(line[2:]):
                continue
            current["points"].append(to_plain(line[2:]))
        elif not current["summary"]:
            current["summary"] = to_plain(line)
    return entries


def render(entries: list[dict]) -> str:
    payload = json.dumps(entries, ensure_ascii=False, indent=2)
    return (
        "// 自動生成ファイル。手で編集しないこと。\n"
        "// 正本は CHANGELOG.md。更新したら `python3 tools/build_whatsnew.py` を実行する。\n"
        "// 生成物が古いままだと tests/verify_whatsnew.js が落ちる。\n"
        "globalThis.YWH_WHATSNEW = " + payload + ";\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="生成し直さず、既存の生成物が最新かだけ検査する")
    args = parser.parse_args()

    if not CHANGELOG.is_file():
        print(f"[build_whatsnew] CHANGELOG.md が見つかりません: {CHANGELOG}", file=sys.stderr)
        return 2

    entries = parse_changelog(CHANGELOG.read_text(encoding="utf-8"))
    if not entries:
        print("[build_whatsnew] CHANGELOG.md からバージョン見出しを1件も読めませんでした", file=sys.stderr)
        return 2
    expected = render(entries)

    if args.check:
        actual = OUTPUT.read_text(encoding="utf-8") if OUTPUT.is_file() else ""
        if actual == expected:
            print(f"[build_whatsnew] 最新です（{len(entries)} 版）")
            return 0
        print("[build_whatsnew] whatsnew_data.js が CHANGELOG.md と一致しません。"
              " `python3 tools/build_whatsnew.py` で再生成してください。", file=sys.stderr)
        return 1

    # 改行は LF 固定（Windows で write_text が CRLF へ変換するのを避ける）。
    OUTPUT.write_bytes(expected.encode("utf-8"))
    print(f"[build_whatsnew] {OUTPUT.name} を生成（{len(entries)} 版・最新 v{entries[0]['version']}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
