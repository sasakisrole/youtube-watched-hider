#!/usr/bin/env python3
"""Live, signed-out Chromium smoke checks for checklist items 5 through 10.

Run: python3 tests/smoke_ui_checklist.py [--only 5] [--headed] [--video ID]
Requires the already installed Playwright package and Chromium browser.
--only accepts multiple numbers; item 7 also runs and reports 5 and 6 as prerequisites.
Only executed items enter the summary: 0 = all PASS, 1 = any FAIL, 2 = SKIP without FAIL.
Each browser uses a fresh tempfile.mkdtemp profile, never an existing account.
"""

import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from urllib.parse import quote_plus, urlparse


EXT = Path(__file__).resolve().parent.parent
DEFAULT_VIDEO = "aqz-KE-bpKQ"
TIMEOUT_MS = 30_000
OBSERVE_MS = 4_000
MIN_TILES = 3
ITEMS = {
    5: "ended records watched video (with no-ended control)",
    6: "only seeded search tile is hidden",
    7: "no extension console errors during 5 and 6",
    8: "both backup filenames include time",
    9: "second backup preserves first backup",
    10: "visible popup version matches manifest",
}
BACKUP_NAME = re.compile(r"yt-watched-backup-\d{4}-\d{2}-\d{2}-\d{6}\.json", re.ASCII)


class SkipCheck(Exception):
    pass


def one_line(value):
    return " ".join(str(value).splitlines())


def check(condition, reason):
    if not condition:
        raise AssertionError(reason)


def get_ext_id(ctx, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for worker in ctx.service_workers:
            if worker.url.startswith("chrome-extension://"):
                return worker.url.split("/")[2]
        try:
            ctx.wait_for_event("serviceworker", timeout=1_000)
        except Exception as exc:
            if type(exc).__name__ != "TimeoutError":
                raise
    return None


@contextmanager
def browser_session(pw, headless):
    try:
        profile = Path(tempfile.mkdtemp(prefix="yt_smoke_ui_"))
    except OSError as exc:
        raise SkipCheck(f"disposable profile could not be created: {one_line(exc)}") from exc
    profile_parent = profile.resolve().parent
    ctx = None
    try:
        try:
            ctx = pw.chromium.launch_persistent_context(
                str(profile), headless=headless,
                args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                      "--no-first-run", "--mute-audio"],
                accept_downloads=True,
                downloads_path=str(profile / "downloads"),
                timeout=TIMEOUT_MS,
            )
            ext_id = get_ext_id(ctx)
            if not ext_id:
                raise SkipCheck("extension service worker not detected")
        except Exception as exc:
            raise SkipCheck(f"browser/extension could not start: {one_line(exc)}") from exc
        ctx.set_default_timeout(TIMEOUT_MS)
        yield ctx, ext_id, profile
    finally:
        try:
            if ctx:
                ctx.close()
        finally:
            # Never recursively remove anything except this invocation's owned temp directory.
            if (profile.resolve().parent == profile_parent
                    and profile.name.startswith("yt_smoke_ui_") and not profile.is_symlink()):
                try:
                    shutil.rmtree(profile)
                except OSError as exc:
                    print(f"NOTE temporary profile retained: {profile}: {one_line(exc)}", flush=True)


def launch_ok(pw, headless):
    try:
        with browser_session(pw, headless):
            return True
    except SkipCheck as exc:
        print(f"NOTE headless probe: {one_line(exc)}; falling back to headed", flush=True)
        return False


def history_page(ctx, ext_id):
    page = ctx.new_page()
    page.goto(f"chrome-extension://{ext_id}/history.html", wait_until="domcontentloaded")
    # history.html uses the offscreen DB client, so let the extension create its own schema first.
    stats = runtime_message(page, {"type": "GET_STATS"})
    check(isinstance(stats, dict) and not stats.get("__error"), f"DB initialization failed: {stats}")
    return page


def watched_db(page, operation, value=None):
    return page.evaluate(
        """async ({operation, value}) => {
          const db = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('IndexedDB open timed out')), 5000);
            const q = indexedDB.open('YouTubeWatchedDB');
            q.onsuccess = () => { clearTimeout(timer); resolve(q.result); };
            q.onerror = () => { clearTimeout(timer); reject(q.error); };
          });
          try {
            if (!db.objectStoreNames.contains('watchedVideos') ||
                !db.objectStoreNames.contains('likedVideos')) throw Error('missing DB stores');
            return await new Promise((resolve, reject) => {
              const tx = db.transaction('watchedVideos', operation === 'seed' ? 'readwrite' : 'readonly');
              const store = tx.objectStore('watchedVideos');
              if (store.keyPath !== 'videoId') throw Error('unexpected watchedVideos keyPath');
              let result = null;
              if (operation === 'seed') {
                for (const row of value) store.put(row);
              } else {
                const q = store.get(value);
                q.onsuccess = () => { result = q.result || null; };
              }
              tx.oncomplete = () => resolve(result);
              tx.onabort = tx.onerror = () => reject(tx.error || Error('DB transaction aborted'));
            });
          } finally { db.close(); }
        }""",
        {"operation": operation, "value": value},
    )


def seed_rows(page, ids):
    now = int(time.time() * 1000)
    watched_db(page, "seed", [
        {"videoId": vid, "title": f"Smoke {vid}", "channel": "Smoke fixture",
         "watchedAt": now, "firstWatchedAt": now, "playCount": 1,
         "source": "self", "durationSec": 120}
        for vid in ids
    ])
    for vid in ids:
        check(watched_db(page, "get", vid) is not None, f"seed was not committed: {vid}")


class ConsoleLog:
    def __init__(self):
        self.errors = []
        self.seen = set()

    def attach(self, ctx, ext_id, number):
        origin = f"chrome-extension://{ext_id}/"

        def console(message):
            location = message.location
            url = location.get("url", "")
            # Exclude YouTube/ad/telemetry sources; retain our origin and source-less extension-tagged logs.
            owned = url.startswith(origin) or (not url and message.text.startswith("[YT-Watched-Hider]"))
            if owned:
                if message.page and urlparse(message.page.url).hostname == "www.youtube.com":
                    self.seen.add(number)
                if message.type == "error":
                    self.errors.append(f"item {number}: {url}:{location.get('lineNumber', 0) + 1}: {message.text}")

        def page_error(error):
            stack = error.stack or str(error)
            if origin in stack:
                self.errors.append(f"item {number}: {stack}")

        ctx.on("console", console)
        ctx.on("page", lambda page: page.on("pageerror", page_error))
        for page in ctx.pages:
            page.on("pageerror", page_error)


def navigate_youtube(page, url=None):
    try:
        if url is None:
            response = page.reload(wait_until="domcontentloaded", timeout=TIMEOUT_MS)
        else:
            response = page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
    except Exception as exc:
        raise SkipCheck(f"YouTube navigation unavailable: {one_line(exc)}") from exc
    if response and response.status >= 400:
        raise SkipCheck(f"YouTube returned HTTP {response.status}")
    assert_youtube_access(page)


def assert_youtube_access(page):
    host = urlparse(page.url).hostname or ""
    if host in {"consent.youtube.com", "consent.google.com", "accounts.google.com"}:
        raise SkipCheck(f"YouTube consent/sign-in screen: {host}")
    if host != "www.youtube.com":
        raise SkipCheck(f"YouTube redirected away: {page.url}")
    consent = page.locator('form[action*="consent"], ytd-consent-bump-v2-lightbox')
    if any(consent.nth(i).is_visible() for i in range(consent.count())):
        raise SkipCheck("YouTube consent screen; no consent or login is automated")


def watch_ready(page, vid):
    deadline = time.monotonic() + TIMEOUT_MS / 1000
    last = None
    while time.monotonic() < deadline:
        assert_youtube_access(page)
        last = page.evaluate(
            """vid => {
              const video = document.querySelector('video');
              if (video) { video.muted = true; video.pause(); }
              return {sameId: new URLSearchParams(location.search).get('v') === vid,
                metadata: !!document.querySelector('ytd-watch-metadata'),
                duration: video && Number.isFinite(video.duration) ? video.duration : null,
                mediaReady: !!video && video.readyState >= 1,
                ad: !!document.querySelector('.ad-showing'),
                error: document.querySelector('.ytp-error-content-wrap-reason')?.textContent || ''};
            }""", vid)
        if (last["sameId"] and last["metadata"] and last["mediaReady"]
                and (last["duration"] or 0) > 30 and not last["ad"] and not last["error"]):
            return
        page.wait_for_timeout(250)
    raise SkipCheck(f"real watch video/metadata not ready: {last}")


def smoke_watched(pw, headless, vid, logs):
    with browser_session(pw, headless) as (ctx, ext_id, _):
        logs.attach(ctx, ext_id, 5)
        history = history_page(ctx, ext_id)
        page = ctx.new_page()
        navigate_youtube(page, f"https://www.youtube.com/watch?v={vid}")
        watch_ready(page, vid)
        check(watched_db(history, "get", vid) is None, "video was recorded before the no-ended control")
        # Pause prevents a real completion from invalidating the negative control.
        page.evaluate("""() => {
          const video = document.querySelector('video');
          window.__smokeVideo = video;
          window.__smokeEnded = 0;
          video.addEventListener('ended', () => window.__smokeEnded++);
          video.addEventListener('play', () => video.pause());
          video.pause();
        }""")
        page.wait_for_timeout(10_000)
        check(page.evaluate("() => window.__smokeEnded === 0"), "ended occurred during the control")
        check(watched_db(history, "get", vid) is None, "no-ended control unexpectedly created a watched record")
        fired = page.evaluate("""() => {
          const video = document.querySelector('video');
          if (video !== window.__smokeVideo) return false;
          video.dispatchEvent(new Event('ended'));
          return window.__smokeEnded === 1;
        }""")
        if not fired:
            raise SkipCheck("YouTube replaced the video element; ended stimulus could not be verified")
        deadline = time.monotonic() + 10
        record = None
        while time.monotonic() < deadline:
            record = watched_db(history, "get", vid)
            if record:
                break
            page.wait_for_timeout(250)
        check(record and record.get("videoId") == vid,
              f"verified ended event produced no watchedVideos record for {vid}")
        check(record.get("source") == "self" and record.get("playCount", 0) >= 1,
              f"record did not come from playback completion: {record}")
        page.wait_for_timeout(OBSERVE_MS)
        return f"{vid}: no-ended absent; ended stored (source=self)"


def search_tiles(page):
    return page.evaluate("""() => {
      const root = document.querySelector('ytd-search');
      if (!root) return [];
      return [...root.querySelectorAll('ytd-video-renderer, yt-lockup-view-model')].flatMap(card => {
        const link = card.querySelector('a[href*="/watch?v="]');
        if (!link) return [];
        const url = new URL(link.href, location.origin);
        const id = url.searchParams.get('v');
        if (!id || url.searchParams.has('list')) return [];
        const rect = card.getBoundingClientRect();
        let visible = rect.width > 0 && rect.height > 0;
        for (let el = card; el; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' ||
              style.visibility === 'collapse' || Number(style.opacity) === 0) visible = false;
        }
        return [{id, visible, hidden: card.dataset.watchedHidden === 'true'}];
      });
    }""")


def wait_search_tiles(page, required_ids=()):
    deadline = time.monotonic() + TIMEOUT_MS / 1000
    tiles = []
    while time.monotonic() < deadline:
        assert_youtube_access(page)
        tiles = search_tiles(page)
        ids = {tile["id"] for tile in tiles}
        if len(ids) >= MIN_TILES and set(required_ids) <= ids:
            return tiles
        page.wait_for_timeout(250)
    raise SkipCheck(f"search tiles not rendered: {len({t['id'] for t in tiles})}/{MIN_TILES}; "
                    f"missing comparison IDs={sorted(set(required_ids) - {t['id'] for t in tiles})}")


def smoke_hidden(pw, headless, query, logs):
    with browser_session(pw, headless) as (ctx, ext_id, _):
        logs.attach(ctx, ext_id, 6)
        history = history_page(ctx, ext_id)
        page = ctx.new_page()
        url = f"https://www.youtube.com/results?search_query={quote_plus(query)}"
        navigate_youtube(page, url)
        wait_search_tiles(page)
        page.wait_for_timeout(OBSERVE_MS)
        before = search_tiles(page)
        check(all(tile["visible"] and not tile["hidden"] for tile in before),
              f"unseeded search tiles already hidden: {before}")
        ids = list(dict.fromkeys(tile["id"] for tile in before))[:MIN_TILES]
        if len(ids) < MIN_TILES:
            raise SkipCheck(f"fewer than {MIN_TILES} stable search tiles before seed")
        for vid in ids:
            check(watched_db(history, "get", vid) is None, f"unseeded tile already recorded: {vid}")
        target = ids[0]
        seed_rows(history, [target])
        navigate_youtube(page)  # Full document reload discards the content script's negative cache.
        wait_search_tiles(page, ids)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            tiles = search_tiles(page)
            seeded = [tile for tile in tiles if tile["id"] == target]
            if seeded and all(tile["hidden"] and not tile["visible"] for tile in seeded):
                break
            page.wait_for_timeout(250)
        page.wait_for_timeout(OBSERVE_MS)
        tiles = wait_search_tiles(page, ids)
        seeded = [tile for tile in tiles if tile["id"] == target]
        others = [tile for tile in tiles if tile["id"] != target]
        check(seeded and all(tile["hidden"] and not tile["visible"] for tile in seeded),
              f"seeded tile is not hidden: {seeded}")
        check(len({tile["id"] for tile in others}) >= MIN_TILES - 1
              and all(tile["visible"] and not tile["hidden"] for tile in others),
              f"unseeded control tiles disappeared or became hidden: {others}")
        for vid in ids[1:]:
            check(watched_db(history, "get", vid) is None, f"unseeded control became watched: {vid}")
        return f"only {target} hidden; {len({t['id'] for t in others})} unseeded IDs visible"


def runtime_message(page, message):
    return page.evaluate("""message => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('runtime message timed out')), 30000);
      chrome.runtime.sendMessage(message, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    })""", message)


def downloads_search(page):
    return page.evaluate("""() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('downloads.search timed out')), 10000);
      chrome.downloads.search({}, items => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
        else resolve(items);
      });
    })""")


def backup_pair(ctx, history, profile):
    seed_rows(history, ["smokeui0001", "smokeui0002", "smokeui0003"])
    # CDP's allow mode retains suggested filenames, unlike Playwright's GUID download artifacts.
    cdp = ctx.new_cdp_session(history)
    disk_check = False
    download_dir = profile / "downloads"
    try:
        cdp.send("Browser.setDownloadBehavior", {
            "behavior": "allow", "downloadPath": str(download_dir), "eventsEnabled": True,
        })
        disk_check = True
    except Exception as exc:
        print(f"NOTE download destination not controllable; use downloads.search: {one_line(exc)}", flush=True)
    finally:
        cdp.detach()
    previous = {item["id"] for item in downloads_search(history)}
    replies = []
    for index in range(2):
        if index:
            history.wait_for_timeout(1_100)
        replies.append(runtime_message(history, {"type": "BACKUP_NOW"}))
    items = downloads_search(history)
    return replies, items, previous, download_dir, disk_check


def cleanup_downloads(pair):
    """ハーネスが作ったバックアップファイルを消す。

    保存先を制御できないため、放置すると本人のダウンロードに
    本物と区別がつかない名前のダミーが残る。削除はハーネスが今回作った
    id の分だけに限る。
    """
    try:
        replies, items, previous, _, _ = pair
    except Exception:
        return
    fresh = {r.get("downloadId") for r in replies if isinstance(r, dict)} - set(previous)
    for item in items:
        if item.get("id") not in fresh:
            continue
        name = item.get("filename") or ""
        if not BACKUP_NAME.fullmatch(re.split(r"[/\\]", name)[-1]):
            continue
        try:
            Path(name).unlink(missing_ok=True)
        except OSError as exc:
            print(f"NOTE could not remove {name}: {one_line(exc)}", flush=True)


def backup_items(pair):
    replies, items, previous, _, _ = pair
    check(len(replies) == 2 and all(isinstance(r, dict) and r.get("success") is True for r in replies),
          f"BACKUP_NOW responses: {replies}")
    ids = [reply.get("downloadId") for reply in replies]
    check(all(isinstance(i, int) and i not in previous for i in ids) and ids[0] != ids[1],
          f"two fresh download IDs were not returned: {replies}")
    by_id = {item["id"]: item for item in items}
    check(all(i in by_id for i in ids), f"backup missing from downloads.search: IDs={ids}, items={items}")
    return [by_id[i] for i in ids]


def smoke_backup_names(pair):
    items = backup_items(pair)
    names = [re.split(r"[/\\]", item.get("filename", ""))[-1] for item in items]
    check(all(BACKUP_NAME.fullmatch(name) for name in names), f"filenames lack expected timestamp: {names}")
    return ", ".join(names)


def smoke_backup_preserved(pair):
    items = backup_items(pair)
    names = [re.split(r"[/\\]", item.get("filename", ""))[-1] for item in items]
    check(names[0] != names[1], f"backup filenames collide: {names}")
    check(all(item.get("state") == "complete" and item.get("exists") is True for item in items),
          f"backups not retained/complete: {items}")
    _, _, _, download_dir, disk_check = pair
    # Browser.setDownloadBehavior は拡張発の chrome.downloads.download には効かず、
    # 実際の保存先はブラウザの既定ダウンロード先になり得る。
    # 場所ではなく「2本とも実在する」を見る（上書きされていないことが本題）。
    for item in items:
        path = Path(item["filename"])
        check(path.is_file(), f"backup file missing on disk: {path}")
    outside = sorted({str(Path(i["filename"]).parent) for i in items
                      if Path(i["filename"]).resolve().parent != download_dir.resolve()})
    if outside:
        print(f"NOTE downloads landed outside the temp profile: {outside[0]}", flush=True)
    return "distinct filenames; both complete and still on disk after the second run"


def smoke_version(ctx, ext_id):
    expected = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
    page = ctx.new_page()
    try:
        page.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
        page.locator("#settingsBtn").click()
        page.locator("#aboutBtn").click()
        label = page.locator("#aboutVersion")
        label.wait_for(state="visible")
        actual = label.inner_text().strip()
        check(actual == f"v{expected}", f"visible version={actual!r}; manifest version={expected!r}")
        return f"visible {actual} == manifest {expected}"
    finally:
        page.close()


def capture(results, number, action):
    try:
        results[number] = ("PASS", action())
    except SkipCheck as exc:
        results[number] = ("SKIP", one_line(exc))
    except Exception as exc:
        results[number] = ("FAIL", f"{type(exc).__name__}: {one_line(exc)}")


def report(results, selected):
    for number in sorted(selected):
        state, reason = results[number]
        print(f"{number} {state} {ITEMS[number]}: {one_line(reason)}", flush=True)
    counts = {state: sum(results[n][0] == state for n in selected) for state in ("PASS", "FAIL", "SKIP")}
    code = 1 if counts["FAIL"] else 2 if counts["SKIP"] else 0
    print(f"SUMMARY PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']} EXIT={code}", flush=True)
    print("このハーネスの対象外: 高評価同期のタブ固定 / authUser切替 / 元タブ閉鎖", flush=True)
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=int, choices=sorted(ITEMS), nargs="+", help="checklist number(s)")
    parser.add_argument("--headed", action="store_true", help="force a visible browser")
    parser.add_argument("--video", default=DEFAULT_VIDEO, help="non-live watch video ID")
    parser.add_argument("--query", default="Big Buck Bunny Blender", help="YouTube search query")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", args.video):
        parser.error("--video must be an 11-character YouTube video ID")
    selected = set(args.only or ITEMS)
    if 7 in selected:
        selected.update((5, 6))
    results = {}
    logs = ConsoleLog()
    try:
        from playwright.sync_api import sync_playwright
        manager = sync_playwright()
        pw = manager.start()
    except Exception as exc:
        reason = f"Playwright unavailable before any check: {type(exc).__name__}: {one_line(exc)}"
        return report({n: ("SKIP", reason) for n in selected}, selected)
    try:
        headless = not args.headed and launch_ok(pw, headless=True)
        for number, action in (
            (5, lambda: smoke_watched(pw, headless, args.video, logs)),
            (6, lambda: smoke_hidden(pw, headless, args.query, logs)),
        ):
            if number in selected:
                print(f"RUN {number} {ITEMS[number]}", flush=True)
                capture(results, number, action)
        if 7 in selected:
            if logs.errors:
                results[7] = ("FAIL", " | ".join(logs.errors))
            elif any(results[n][0] == "SKIP" for n in (5, 6)):
                reasons = "; ".join(f"{n}: {results[n][1]}" for n in (5, 6) if results[n][0] == "SKIP")
                results[7] = ("SKIP", f"live console observation incomplete; {reasons}")
            elif not {5, 6} <= logs.seen:
                results[7] = ("SKIP", f"no attributable extension console activity in {sorted({5, 6} - logs.seen)}")
            else:
                results[7] = ("PASS", "extension console activity observed during both 5 and 6; zero errors")
        offline = selected & {8, 9, 10}
        if offline:
            try:
                with browser_session(pw, headless) as (ctx, ext_id, profile):
                    if offline & {8, 9}:
                        try:
                            pair = backup_pair(ctx, history_page(ctx, ext_id), profile)
                        except Exception as exc:
                            for n in offline & {8, 9}:
                                results[n] = ("FAIL", f"backup setup/execution: {type(exc).__name__}: {one_line(exc)}")
                        else:
                            if 8 in offline:
                                capture(results, 8, lambda: smoke_backup_names(pair))
                            if 9 in offline:
                                capture(results, 9, lambda: smoke_backup_preserved(pair))
                            cleanup_downloads(pair)
                    if 10 in offline:
                        capture(results, 10, lambda: smoke_version(ctx, ext_id))
            except Exception as exc:
                for n in offline:
                    results.setdefault(n, ("SKIP" if isinstance(exc, SkipCheck) else "FAIL", one_line(exc)))
    finally:
        pw.stop()
    return report(results, selected)


if __name__ == "__main__":
    sys.exit(main())
