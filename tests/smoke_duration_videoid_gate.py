#!/usr/bin/env python3
"""Hands-off live smoke test for the duration videoId-gate fix (PENDING id:8v48,
shipped in v1.42.4).

Background
----------
`getCurrentVideoDurationSec()` reads the current video's length from
`ytInitialPlayerResponse`, scanning `document.scripts`. After a YouTube SPA
navigation a *stale* `ytInitialPlayerResponse` script from the PREVIOUS video can
linger in `document.scripts`; without a videoId check the extension could save the
previous video's length onto the current record (silently polluting the
length distribution / length-based taste). v1.42.4 added a videoId gate:
`getInitialPlayerResponseDurationSec(expectedVideoId)` only trusts a player
response whose `videoDetails.videoId` matches; unattributable/mismatched responses
are skipped (caller then falls back to meta / <video>).

What this harness does (deterministic, self-validating)
-------------------------------------------------------
It launches Chromium with the UNPACKED extension loaded, opens a real non-live
watch page (B), and reproduces the exact hazard deterministically:

  1. Forces the extension's `watchMetadataMatches` gate (domAgrees) true by inserting
     a self `/watch?v=B` link as the first watch-link inside `ytd-watch-metadata`.
     (The natural gate is flaky: many pages carry a description link to ANOTHER
     video first. We ARE on B, so asserting domAgrees is faithful.)
  2. Injects a STALE prior-video `ytInitialPlayerResponse` as the FIRST <script> in
     the DOM, carrying lengthSeconds=9999 (a distinctive trap) — simulating the SPA
     leftover in `document.scripts`.
  3. Dispatches a synthetic `ended` event so the SHIPPED `recordCurrentVideo()` ->
     `getCurrentVideoDurationSec(B)` runs, then reads the stored record from the
     extension-owned IndexedDB (offscreen origin, via history.html).

Two cases prove the gate discriminates by videoId EXACTLY (teeth):
  * DISTINCT trap videoId (!= B): the gate must SKIP the trap -> stored == B's real
    length (NOT 9999). This is the regression guard: pre-fix code returns 9999.
  * MATCH trap videoId (== B):    the gate ACCEPTS the trap -> stored == 9999. This
    proves the injected trap is genuinely observable (so the DISTINCT pass is real,
    not a fluke). Both old and new code behave identically here.

Overall PASS iff DISTINCT -> B_real AND MATCH -> 9999, with the trap proven to sit
BEFORE B's real script in document.scripts.

Run
---
    python3 projects/youtube-watched-hider/tests/smoke_duration_videoid_gate.py
    #   --headed   force a visible window (default: try headless=new, fall back to headed)
    #   --video ID override the test video (must be non-live with a finite length)

Exit code 0 = PASS, 2 = FAIL/regression, 1 = harness error/inconclusive.
"""
import argparse
import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

# Extension dir = parent of this tests/ dir (works across PCs / Dropbox roots).
EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VIDEO = "aqz-KE-bpKQ"   # Big Buck Bunny (~635s, non-live, always available)
TRAP_DUR = 9999                 # distinctive trap length (seconds)
DISTINCT_TRAP_ID = "STALEvid0001"


def get_ext_id(ctx, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        for sw in list(ctx.service_workers):
            if sw.url.startswith("chrome-extension://"):
                return sw.url.split("/")[2]
        for bp in list(ctx.background_pages):
            if bp.url.startswith("chrome-extension://"):
                return bp.url.split("/")[2]
        try:
            ctx.wait_for_event("serviceworker", timeout=2000)
        except Exception:
            pass
    return None


def wait_ready(page, vid, timeout=30):
    """Wait for a finite-duration <video> + ytd-watch-metadata present."""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        st = page.evaluate(
            """(vid) => {
              const v = document.querySelector('video');
              if (v) { v.muted = true; if (v.paused) v.play().catch(()=>{}); }
              const root = document.querySelector('ytd-watch-metadata');
              return {cur: new URLSearchParams(location.search).get('v'),
                      hasRoot: !!root,
                      dur: v && isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null};
            }""",
            vid,
        )
        last = st
        if st["cur"] == vid and st["hasRoot"] and st["dur"]:
            return st
        time.sleep(1)
    return last


def setup_hazard(page, vid, trap_id, trap_dur):
    """Force the domAgrees gate, inject the stale-A trap as the first <script>,
    and report where the trap sits relative to B's real player-response script."""
    return page.evaluate(
        """(args) => {
          const {vid, trapId, trapDur} = args;
          // (1) force domAgrees: self watch-link as the FIRST watch-link in metadata
          const root = document.querySelector('ytd-watch-metadata');
          const a = document.createElement('a');
          a.href = '/watch?v=' + vid; a.textContent = ' '; a.style.display = 'none';
          root.insertBefore(a, root.firstChild);
          const firstLink = root.querySelector('a[href*="/watch?v="]');
          let gate = false;
          try { gate = new URL(firstLink.href, location.origin).searchParams.get('v') === vid; } catch(e) {}
          // (2) stale trap as the first <script>. YT enforces Trusted Types, which
          //     blocks string .textContent on scripts; appending a Text node is not
          //     intercepted (the extension only READS .textContent).
          const s = document.createElement('script');
          s.type = 'text/x-stale-test';  // non-executing; still enumerated in document.scripts
          s.appendChild(document.createTextNode(
            'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"' + trapId + '","lengthSeconds":"' + trapDur + '"}};'));
          document.head.insertBefore(s, document.head.firstChild);
          // report ordering: trap vs a real ytInitialPlayerResponse script matching current vid
          let trapIdx = -1, realIdx = -1; const scripts = [...document.scripts];
          for (let i = 0; i < scripts.length; i++) {
            const t = scripts[i].textContent || '';
            if (trapIdx < 0 && t.includes('"' + trapId + '"') && t.includes('ytInitialPlayerResponse')) trapIdx = i;
            if (realIdx < 0 && t.includes('ytInitialPlayerResponse') && t.includes('"' + vid + '"')) realIdx = i;
          }
          return {gate_forced: gate, trapIdx, realIdx};
        }""",
        {"vid": vid, "trapId": trap_id, "trapDur": trap_dur},
    )


def read_duration(ctx, ext_id, vid):
    p = ctx.new_page()
    p.goto(f"chrome-extension://{ext_id}/history.html", wait_until="domcontentloaded")
    rec = p.evaluate(
        """async (vid) => {
          const db = await new Promise((r,j)=>{const q=indexedDB.open('YouTubeWatchedDB');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
          return await new Promise((r,j)=>{const t=db.transaction('watchedVideos','readonly').objectStore('watchedVideos').get(vid);t.onsuccess=()=>r(t.result);t.onerror=()=>j(t.error)});
        }""",
        vid,
    )
    p.close()
    return (rec or {}).get("durationSec")


def run_case(pw, vid, trap_id, headless):
    """One isolated browser session: load B, plant the hazard, dispatch `ended`,
    return {stored, b_real, setup}."""
    ud = tempfile.mkdtemp(prefix="yt_smoke_")
    ctx = pw.chromium.launch_persistent_context(
        ud, headless=headless,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-first-run", "--mute-audio"],
    )
    try:
        ext_id = get_ext_id(ctx)
        if not ext_id:
            return {"error": "extension id not detected (service worker not found)"}
        page = ctx.new_page()
        page.goto(f"https://www.youtube.com/watch?v={vid}", wait_until="domcontentloaded")
        ready = wait_ready(page, vid)
        if not (ready and ready.get("dur")):
            return {"error": f"video/metadata not ready: {ready}"}
        b_real = ready["dur"]
        setup = setup_hazard(page, vid, trap_id, TRAP_DUR)
        page.evaluate("""() => { const v=document.querySelector('video'); if(v) v.dispatchEvent(new Event('ended')); }""")
        time.sleep(2.5)
        stored = read_duration(ctx, ext_id, vid)
        return {"stored": stored, "b_real": b_real, "setup": setup, "ext_id": ext_id}
    finally:
        ctx.close()


def launch_ok(pw, headless):
    """Quick probe: can the extension load in the requested headless mode?"""
    ud = tempfile.mkdtemp(prefix="yt_probe_")
    ctx = pw.chromium.launch_persistent_context(
        ud, headless=headless,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-first-run"],
    )
    try:
        return get_ext_id(ctx, timeout=12) is not None
    finally:
        ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true", help="force a visible window")
    ap.add_argument("--video", default=DEFAULT_VIDEO, help="test video id (non-live, finite length)")
    args = ap.parse_args()

    report = {"video": args.video, "cases": {}}
    with sync_playwright() as pw:
        # prefer headless (hands-off); fall back to headed if the extension won't load headless
        if args.headed:
            headless = False
        else:
            headless = launch_ok(pw, headless=True)
            if not headless:
                report["note"] = "headless could not load the extension; using headed"
        report["headless"] = headless

        distinct = run_case(pw, args.video, DISTINCT_TRAP_ID, headless)
        report["cases"]["distinct_trap"] = distinct
        match = run_case(pw, args.video, args.video, headless)  # trap videoId == B
        report["cases"]["match_trap"] = match

    # ---- verdict ----
    verdict, code = "PASS", 0
    d, m = report["cases"]["distinct_trap"], report["cases"]["match_trap"]
    if "error" in d or "error" in m:
        verdict, code = f"HARNESS-ERROR: distinct={d.get('error')} match={m.get('error')}", 1
    else:
        d_stored, b_real = d["stored"], d["b_real"]
        m_stored = m["stored"]
        trap_before = (d["setup"]["trapIdx"] >= 0 and
                       (d["setup"]["realIdx"] == -1 or d["setup"]["trapIdx"] < d["setup"]["realIdx"]))
        report["teeth_trap_before_real"] = trap_before
        distinct_ok = d_stored is not None and abs(d_stored - b_real) <= 2 and d_stored != TRAP_DUR
        match_ok = m_stored == TRAP_DUR
        if not d["setup"]["gate_forced"] or not m["setup"]["gate_forced"]:
            verdict, code = "HARNESS-ERROR: could not force domAgrees gate", 1
        elif d_stored == TRAP_DUR:
            verdict, code = "FAIL: videoId gate did NOT skip the stale trap (contamination / regression)", 2
        elif not distinct_ok:
            verdict, code = (f"INCONCLUSIVE: distinct-trap stored={d_stored} (expected B_real={b_real}); "
                             "duration path may not have run", 1)
        elif not match_ok:
            verdict, code = (f"INCONCLUSIVE: match-trap stored={m_stored} (expected {TRAP_DUR}); "
                             "trap not observable — teeth unproven", 1)
        elif not trap_before:
            verdict, code = "WARN-PASS: gate skipped trap but trap was not before real script (weak teeth)", 0
        else:
            verdict, code = (f"PASS: distinct trap skipped (stored={d_stored}==B_real), "
                             f"match trap observed (stored={m_stored}==trap); videoId gate works", 0)
    report["verdict"] = verdict

    print(json.dumps(report, indent=2, ensure_ascii=False))
    print("\n" + verdict)
    return code


if __name__ == "__main__":
    sys.exit(main())
