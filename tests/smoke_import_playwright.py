#!/usr/bin/env python3
"""Playwright smoke test for tolerant backup restore (2gkw)."""

import json
import os
import shutil
import sys
import time
import uuid

from playwright.sync_api import sync_playwright

EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE_PREFIX = f".smoke_import_profile_{os.getpid()}_"
TIMEOUT_MS = 30_000


def runtime_message(page, message):
    return page.evaluate(
        """(message) => new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          });
        })""",
        message,
    )


def import_through_popup(page, backup):
    page.locator("#fileInput").set_input_files({
        "name": "smoke-backup.json",
        "mimeType": "application/json",
        "buffer": json.dumps(backup).encode("utf-8"),
    })
    page.locator("#importModePanel").wait_for(state="visible", timeout=TIMEOUT_MS)
    preview = page.locator("#importDiffSummary").inner_text()
    page.locator("#importBackupMergeBtn").click()
    page.wait_for_function(
        """() => {
          const text = document.querySelector('#status')?.textContent || '';
          return text && text !== '統合中...';
        }""",
        timeout=TIMEOUT_MS,
    )
    return preview, page.locator("#status").inner_text()


def exported_data(page):
    data = runtime_message(page, {"type": "EXPORT_DATA", "source": "manual"})
    if not isinstance(data, dict) or data.get("__error"):
        raise RuntimeError(f"EXPORT_DATA failed: {data}")
    return data


def evaluate_in_offscreen(context, popup, expression):
    """Evaluate JavaScript in an MV3 offscreen document via a CDP target."""
    for candidate in context.pages:
        if candidate.url.endswith("/offscreen.html"):
            return candidate.evaluate(expression)

    cdp = context.new_cdp_session(popup)
    attached = None
    try:
        targets = cdp.send("Target.getTargets").get("targetInfos", [])
        target = next(
            (item for item in targets if item.get("url", "").endswith("/offscreen.html")),
            None,
        )
        if not target:
            raise RuntimeError("offscreen target was not visible to Playwright")
        attached = cdp.send(
            "Target.attachToTarget",
            {"targetId": target["targetId"], "flatten": False},
        )["sessionId"]
        replies = {}

        def receive(event):
            if event.get("sessionId") == attached:
                payload = json.loads(event.get("message", "{}"))
                if payload.get("id") == 1:
                    replies[1] = payload

        cdp.on("Target.receivedMessageFromTarget", receive)
        command = {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }
        cdp.send("Target.sendMessageToTarget", {
            "sessionId": attached,
            "message": json.dumps(command),
        })
        deadline = time.monotonic() + 10
        while 1 not in replies and time.monotonic() < deadline:
            popup.wait_for_timeout(50)
        if 1 not in replies:
            raise RuntimeError("timed out evaluating in offscreen target")
        reply = replies[1]
        if "error" in reply:
            raise RuntimeError(reply["error"].get("message", str(reply["error"])))
        result = reply.get("result", {})
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"].get("text", "offscreen evaluation failed"))
        return result.get("result", {}).get("value")
    finally:
        if attached:
            try:
                cdp.send("Target.detachFromTarget", {"sessionId": attached})
            except Exception:
                pass
        cdp.detach()


def record(results, smoke_id, state, reason):
    results[smoke_id] = (state, " ".join(str(reason).splitlines()))


def main():
    started = time.monotonic()
    results = {}
    # tempfile.mkdtemp uses mode 0o700; on some Windows sandbox/Dropbox
    # combinations that can create a directory the process cannot later reopen.
    # A UUID plus PID is equally collision-safe and keeps normal inherited ACLs.
    profile = os.path.join(EXT, f"{PROFILE_PREFIX}{uuid.uuid4().hex}")
    os.mkdir(profile)
    context = None
    cleanup_error = None

    try:
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(
                profile,
                headless=False,
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--no-first-run",
                ],
                timeout=60_000,
            )
            worker = (
                context.service_workers[0]
                if context.service_workers
                else context.wait_for_event("serviceworker", timeout=15_000)
            )
            extension_id = worker.url.split("/")[2]
            popup = context.new_page()
            popup.goto(
                f"chrome-extension://{extension_id}/popup.html",
                wait_until="domcontentloaded",
                timeout=TIMEOUT_MS,
            )

            tolerant_backup = {
                "schemaVersion": 2,
                "exportedAt": "2026-08-07T00:00:00.000Z",
                "appVersion": "smoke",
                "source": "manual",
                "watchedVideos": [
                    {"videoId": "smoke-normal", "title": "synthetic normal row", "watchedAt": 1},
                    {
                        "videoId": "smoke-odd-optional-types",
                        "title": 12345,
                        "watchedAt": "not-a-number",
                        "credits": ["not", "an", "object"],
                    },
                    {"title": "synthetic missing videoId", "watchedAt": 2},
                ],
                "likedVideos": {"broken": "not-an-array"},
                "likedSyncMeta": None,
            }

            try:
                preview, status = import_through_popup(popup, tolerant_backup)
                watched_ids = {
                    row.get("videoId")
                    for row in exported_data(popup).get("watchedVideos", [])
                    if isinstance(row, dict)
                }
                expected = {"smoke-normal", "smoke-odd-optional-types"}
                missing = sorted(expected - watched_ids)
                if missing:
                    record(results, "S-1", "FAIL", f"正常/許容対象の行が復元されない: {missing}")
                else:
                    record(results, "S-1", "PASS", "正常行と任意フィールド型不正行をともに保持")

                if None not in watched_ids and "1件スキップ" in status:
                    record(results, "S-2", "PASS", "videoId 欠落行を除外し、1件スキップを表示")
                else:
                    record(results, "S-2", "FAIL", f"videoId 欠落行の除外/表示を確認できない (status={status!r})")

                structural_warning = "高評価データ形式不正" in status
                preview_warning = "高評価データの形式が不正" in preview
                if structural_warning and preview_warning and expected.issubset(watched_ids):
                    record(results, "S-3", "PASS", "高評価の構造不正を警告し、視聴履歴の復元は成功")
                else:
                    record(
                        results,
                        "S-3",
                        "FAIL",
                        f"警告または視聴履歴の成功を確認できない (preview={preview!r}, status={status!r})",
                    )
            except Exception as error:
                reason = f"通常復元フローの実行エラー: {error}"
                for smoke_id in ("S-1", "S-2", "S-3"):
                    record(results, smoke_id, "FAIL", reason)

            inject_expression = """(() => {
              if (typeof WatchedDB === 'undefined' || typeof WatchedDB.importLikedData !== 'function') {
                return {ok: false, reason: 'WatchedDB.importLikedData is unavailable'};
              }
              globalThis.__smokeOriginalImportLikedData = WatchedDB.importLikedData;
              WatchedDB.importLikedData = async () => {
                throw new Error('smoke injected liked import failure');
              };
              return {ok: true};
            })()"""
            restore_expression = """(() => {
              if (typeof WatchedDB !== 'undefined' &&
                  typeof globalThis.__smokeOriginalImportLikedData === 'function') {
                WatchedDB.importLikedData = globalThis.__smokeOriginalImportLikedData;
                delete globalThis.__smokeOriginalImportLikedData;
                return true;
              }
              return false;
            })()"""

            injected = False
            try:
                injection = evaluate_in_offscreen(context, popup, inject_expression)
                if not isinstance(injection, dict) or not injection.get("ok"):
                    reason = injection.get("reason", str(injection)) if isinstance(injection, dict) else str(injection)
                    raise RuntimeError(reason)
                injected = True
            except Exception as error:
                record(results, "S-4", "SKIP", f"offscreen への失敗注入を自動化できない: {error}")

            if injected:
                partial_backup = {
                    "schemaVersion": 2,
                    "exportedAt": "2026-08-07T00:00:00.000Z",
                    "appVersion": "smoke",
                    "source": "manual",
                    "watchedVideos": [
                        {"videoId": "smoke-partial-watched", "title": "synthetic partial", "watchedAt": 3}
                    ],
                    "likedVideos": [
                        {
                            "videoId": "smoke-partial-liked",
                            "title": "synthetic liked",
                            "channel": "synthetic",
                            "accountId": "smoke-account",
                            "likedAt": 4,
                            "syncedAt": 4,
                            "playlistIndex": 0,
                        }
                    ],
                    "likedSyncMeta": None,
                }
                try:
                    _preview, status = import_through_popup(popup, partial_backup)
                    exported = exported_data(popup)
                    watched_ids = {row.get("videoId") for row in exported.get("watchedVideos", [])}
                    liked_ids = {row.get("videoId") for row in exported.get("likedVideos", [])}
                    visible_partial = "一部成功" in status and "高評価の復元に失敗" in status
                    watched_only = "smoke-partial-watched" in watched_ids and "smoke-partial-liked" not in liked_ids
                    if visible_partial and watched_only:
                        record(results, "S-4", "PASS", "高評価失敗時に視聴履歴だけ復元し「一部成功」を表示")
                    else:
                        record(
                            results,
                            "S-4",
                            "FAIL",
                            f"一部成功表示/保存結果が不一致 (status={status!r}, watched_only={watched_only})",
                        )
                except Exception as error:
                    record(results, "S-4", "FAIL", f"失敗注入後の復元フローでエラー: {error}")
                finally:
                    try:
                        evaluate_in_offscreen(context, popup, restore_expression)
                    except Exception:
                        pass
    except Exception as error:
        for smoke_id in ("S-1", "S-2", "S-3"):
            if smoke_id not in results:
                record(results, smoke_id, "FAIL", f"スモーク基盤エラー: {error}")
        if "S-4" not in results:
            record(results, "S-4", "SKIP", f"スモーク基盤エラーのため失敗注入未実施: {error}")
    finally:
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        # Chromium が Cache_Data を掴んだまま終了することがあり、直後の rmtree は
        # WinError 32（使用中）で落ちる。ブラウザ終了を待って数回リトライする
        # （.claude/skills/codex-pending-drain/SKILL.md の一時領域リトライ方針と同じ）。
        for attempt in range(6):
            try:
                shutil.rmtree(profile)
                cleanup_error = None
                break
            except OSError as error:
                if getattr(error, "winerror", None) not in (5, 32) and attempt == 5:
                    cleanup_error = str(error)
                    break
                cleanup_error = str(error)
                time.sleep(0.5 * (attempt + 1))
            except Exception as error:
                cleanup_error = str(error)
                break

    profile_removed = not os.path.exists(profile)
    if not profile_removed:
        cleanup_error = cleanup_error or "profile directory still exists"

    for smoke_id in ("S-1", "S-2", "S-3", "S-4"):
        state, reason = results[smoke_id]
        print(f"{smoke_id} {state}: {reason}")

    elapsed = time.monotonic() - started
    print(f"ELAPSED={elapsed:.1f}s")
    if profile_removed:
        print("PROFILE_CLEANUP PASS: 使い捨てプロファイルは残っていません")
    else:
        print(f"PROFILE_CLEANUP FAIL: {cleanup_error}")

    counts = {
        state: sum(1 for state_i, _ in results.values() if state_i == state)
        for state in ("PASS", "FAIL", "SKIP")
    }
    print(f"PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']}")
    return 1 if counts["FAIL"] or not profile_removed else 0


if __name__ == "__main__":
    sys.exit(main())
