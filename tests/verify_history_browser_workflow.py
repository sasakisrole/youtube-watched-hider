"""Exercise real history controls with 100k synthetic records and offline Chrome mocks."""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import unquote, urlparse

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--scenario', choices=['workflow', 'scroll'], default='workflow')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
mock = r"""() => {
  const removed = new Set(JSON.parse(sessionStorage.getItem('testRemoved') || '[]'));
  const records = Array.from({length: 100000}, (_, i) => ({
    videoId: String(i).padStart(11, '0'), title: 'Music ' + String((i * 7919) % 100000).padStart(6, '0'),
    channel: 'Channel ' + (i % 100), watchedAt: 1700000000000 + i * 1000, playCount: 1 + i % 5,
  }));
  window.testDeleteCalls = [];
  window.testFailDelete = false;
  window.testDeferDelete = false;
  window.testPendingDeleteResponses = [];
  window.chrome = {
    i18n: {getMessage: () => '', getUILanguage: () => 'ja'},
    runtime: {sendMessage: (message, callback) => {
      let data = {success: true};
      if (message.type === 'EXPORT_DATA') data = records.filter(v => !removed.has(v.videoId));
      if (message.type === 'DELETE_VIDEO') {
        testDeleteCalls.push(message.videoId);
        data = {success: !testFailDelete};
        if (!testFailDelete) {
          removed.add(message.videoId);
          sessionStorage.setItem('testRemoved', JSON.stringify([...removed]));
        }
      }
      if (message.type === 'DELETE_VIDEO' && testDeferDelete) {
        return new Promise(resolve => testPendingDeleteResponses.push(() => { callback?.(data); resolve(data); }));
      }
      callback?.(data); return Promise.resolve(data);
    }},
    storage: {local: {
      get: (_keys, callback) => { callback?.({}); return Promise.resolve({}); },
      set: (_values, callback) => { callback?.(); return Promise.resolve(); },
    }, onChanged: {addListener() {}}},
  };
}"""
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    try:
        context = browser.new_context(offline=True, viewport={'width': 1200, 'height': 900})
        def route_request(route):
            url = urlparse(route.request.url)
            path = (root / unquote(url.path).lstrip('/')).resolve()
            if url.hostname != 'ywh.test' or not path.is_relative_to(root) or not path.is_file():
                route.abort()
                return
            route.fulfill(body=path.read_bytes(), content_type='application/javascript' if path.suffix == '.js' else mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        context.route('**/*', route_request)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('(' + mock + ')()')
        page.goto('https://ywh.test/history.html')
        page.wait_for_function('allData.length === 100000 && renderedCount === 100')
        def search(text):
            page.locator('#search').fill(text)
            page.wait_for_timeout(320)
        def ids():
            return page.evaluate('sortedCache.map(v => v.videoId)')
        def first_id():
            return page.locator('.video-row:not([hidden]) .video-id').first.inner_text()
        if args.scenario == 'workflow':
            for mode in ['date-desc', 'date-asc', 'count-desc', 'channel', 'title']:
                search('music 00')
                page.locator(f'.sort-btn[data-sort="{mode}"]').click()
                before = ids()
                assert len(before) == 10000
                page.locator('.video-row:not([hidden]) .delete-btn').first.click()
                page.locator('.video-row:not([hidden]) .delete-btn').first.click()
                assert page.evaluate('allData.length') == 99998
                assert len(ids()) == 9998
                search('music 000')
                page.locator('.sort-btn[data-sort="date-asc"]').click()
                page.locator('#undoToastBtn').click()
                assert page.evaluate('allData.length') == 100000
                assert page.evaluate('testDeleteCalls.length') == 0
                search('music 00')
                page.locator(f'.sort-btn[data-sort="{mode}"]').click()
                assert ids() == before, mode
                visible = page.locator('.video-row:not([hidden]) .video-id').all_text_contents()
                assert visible == before[:len(visible)]
                assert not page.locator('#undoToast').is_visible()
                checks.append('search-sort-delete-two-change-filter-undo-' + mode)
            page.reload()
            page.wait_for_function('allData.length === 100000')
            checks.append('undo-survives-reload-with-no-storage-delete')
            search('music 000')
            doomed = first_id()
            page.locator('.video-row:not([hidden]) .delete-btn').first.click()
            page.wait_for_function('testDeleteCalls.length === 1', timeout=8000)
            page.reload()
            page.wait_for_function('allData.length === 99999')
            assert not page.evaluate('(id) => allData.some(v => v.videoId === id)', doomed)
            checks.append('committed-delete-survives-reload')
            search('music 000')
            before = ids()
            page.evaluate('testFailDelete = true')
            page.locator('.video-row:not([hidden]) .delete-btn').first.click()
            page.wait_for_function('testDeleteCalls.length === 1', timeout=8000)
            assert ids() == before
            assert page.evaluate('allData.length') == 99999
            page.reload()
            page.wait_for_function('allData.length === 99999')
            checks.append('failed-delete-restores-history-and-order')
            search('music 00')
            page.locator('.sort-btn[data-sort="title"]').click()
            before = ids()
            page.evaluate('testFailDelete = true; testDeferDelete = true')
            page.locator('.video-row:not([hidden]) .delete-btn').first.click()
            page.wait_for_function('testPendingDeleteResponses.length === 1', timeout=8000)
            search('music 09')
            page.locator('.sort-btn[data-sort="date-asc"]').click()
            page.evaluate('testPendingDeleteResponses.shift()()')
            assert page.evaluate('currentSort') == 'date-asc'
            assert ids() == [str(i).zfill(11) for i in range(100000) if (i * 7919) % 100000 >= 90000]
            assert page.evaluate("sortedCache.every(v => v.title.toLowerCase().includes('music 09'))")
            assert page.evaluate('allData.length') == 99999
            search('music 00')
            page.locator('.sort-btn[data-sort="title"]').click()
            assert ids() == before
            page.reload()
            page.wait_for_function('allData.length === 99999')
            checks.append('delayed-failure-after-search-and-sort-restores-correct-results')
            doomed = first_id()
            page.locator('.video-row:not([hidden]) .delete-btn').first.click()
            page.reload()
            page.wait_for_function('allData.length === 99998')
            assert not page.evaluate('(id) => allData.some(v => v.videoId === id)', doomed)
            checks.append('pagehide-flushes-pending-delete')
        else:
            def visible_ids():
                return page.locator('.video-row:not([hidden]) .video-id').all_text_contents()
            def assert_prefix(expected):
                visible = visible_ids()
                assert len(visible) == len(set(visible)), 'duplicate rendered video'
                assert visible == expected[:len(visible)], 'missing or out-of-order rendered video'
                assert len(visible) == page.evaluate('renderedCount'), 'rendered pointer disagrees with DOM'
            def next_batch():
                before = page.evaluate('renderedCount')
                page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                page.wait_for_function('(before) => renderedCount > before', arg=before)
            for mode in ['date-desc', 'date-asc', 'count-desc', 'channel', 'title']:
                page.evaluate('window.scrollTo(0, 0)')
                search('music 00')
                page.locator(f'.sort-btn[data-sort="{mode}"]').click()
                expected = ids()
                page.locator('.video-row:not([hidden]) .delete-btn').nth(99).click()
                remaining = set(ids())
                removed = [value for value in expected if value not in remaining]
                assert len(removed) == 1
                next_batch()
                assert_prefix([value for value in expected if value not in removed])
                page.locator('#undoToastBtn').click()
                assert_prefix(expected)
                next_batch()
                assert_prefix(expected)
                assert page.evaluate('testDeleteCalls.length') == 0
                checks.append('scroll-delete-undo-prefix-' + mode)
            page.evaluate('window.scrollTo(0, 0)')
            search('music 0000')
            page.locator('.sort-btn[data-sort="title"]').click()
            expected = ids()
            assert len(expected) == 100
            page.locator('.video-row:not([hidden]) .delete-btn').last.click()
            page.locator('#undoToastBtn').click()
            assert_prefix(expected)
            page.evaluate('window.scrollTo(0, 0)')
            page.wait_for_timeout(50)
            page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
            page.wait_for_timeout(100)
            assert_prefix(expected)
            assert visible_ids() == expected
            checks.append('last-rendered-delete-undo-does-not-duplicate-at-end')
        assert not errors, errors
        context.close()
    finally:
        browser.close()
result = {'result': 'passed', 'checks': checks, 'records': 100000, 'scenario': args.scenario,
          'commit': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
          'test_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'history_sha256': hashlib.sha256((root / 'history.js').read_bytes()).hexdigest(),
          'limitations': 'Synthetic Chrome APIs with immediate and delayed failure callbacks and sessionStorage persistence; sortedCache full order and rendered DOM prefix checked; no real extension background or YouTube account.'}
temporary = None
try:
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(result, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, output)
finally:
    if temporary is not None and temporary.exists():
        temporary.unlink()
print(f'PASS {len(checks)} browser workflows with 100000 synthetic records; no JavaScript errors')
