"""Exercise the shipped correction screen in an isolated, offline browser."""
import argparse
import json
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
mock = r"""() => {
  window.chrome = {
    i18n: {getMessage: () => '', getUILanguage: () => 'ja'},
    runtime: {sendMessage: (message, callback) => {
      let result = {success: true};
      if (message.type === 'EXPORT_DATA') result = testRecords;
      callback?.(result); return Promise.resolve(result);
    }},
    storage: {local: {
      get: (_keys, callback) => {callback?.({}); return Promise.resolve({});},
      set: (_values, callback) => {callback?.(); return Promise.resolve();},
    }, onChanged: {addListener() {}}},
  };
  window.testRecords = [];
}"""
with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(str(output / 'browser-profile'), executable_path=args.browser, headless=True, viewport={'width': 1200, 'height': 900})
    try:
        settings = context.pages[0]
        settings.goto('chrome://settings/appearance')
        context.set_offline(True)
        def route_request(route):
            url = urlparse(route.request.url)
            path = (root / unquote(url.path).lstrip('/')).resolve()
            if url.hostname != 'ywh.test' or not path.is_relative_to(root) or not path.is_file():
                route.abort()
                return
            route.fulfill(body=path.read_bytes(), content_type='application/javascript' if path.suffix == '.js' else mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        context.route('**/*', route_request)
        page = context.new_page()
        page.add_init_script('(' + mock + ')()')
        page.goto('https://ywh.test/history.html')
        page.wait_for_function('typeof creditReviewController !== "undefined" && creditReviewController !== null')
        page.evaluate('''() => {
          const titles = {KMvTTyBRffk: "Banbado (Shiron Dub'n'Bado Remix) - Shiron", L0KM98yjqZo: 'Battle of Marion(ISK "Meteorite" Remix)', XGpzjurA0ug: '闇の彼方 (mozell remix)', rXcPRKriVsI: 'ワールドイズマイン CPK! Remix (かぐや & 月見ヤチヨ ver.)'};
          const records = new Map();
          for (const rule of CreditCorrections.rules) {
            if (!records.has(rule.videoId)) records.set(rule.videoId, {videoId: rule.videoId, title: titles[rule.videoId], creditsSource: 'general'});
            records.get(rule.videoId)[rule.role] = rule.before;
          }
          allData = [...records.values()];
        }''')
        page.locator('#maintToggle').click()
        page.locator('#repairToggle').click()
        page.locator('#creditReviewOpen').focus()
        page.keyboard.press('Enter')
        assert page.locator('.credit-review-item').count() == 6
        assert page.locator('.credit-review-item > a').count() == 6
        page.keyboard.press('Shift+Tab')
        assert page.evaluate('document.activeElement.closest("#creditReviewModal") !== null')
        page.keyboard.press('Tab')
        assert page.evaluate('document.activeElement.id === "creditReviewClose"')
        page.locator('#creditReviewList').evaluate('(element) => {element.scrollTop = 0}')
        records = page.evaluate('allData')
        checks = []
        for width, zoom in [(1200, 1), (390, 1), (1200, 2)]:
            page.set_viewport_size({'width': width, 'height': 900})
            settings.locator('#zoomLevel').select_option(str(zoom))
            page.reload()
            page.wait_for_function('typeof creditReviewController !== "undefined" && creditReviewController !== null')
            page.evaluate('(records) => { allData = records; creditReviewController.open(); }', records)
            assert page.evaluate('devicePixelRatio') == zoom
            assert page.evaluate('getComputedStyle(document.documentElement).zoom') == '1'
            for theme in ['light', 'dark']:
                page.emulate_media(color_scheme=theme)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert page.evaluate('''() => [...document.querySelectorAll('.credit-review-item')].every(e => e.scrollWidth <= e.clientWidth + 1)''')
                page.screenshot(path=str(output / f'{width}-{zoom}-{theme}.png'))
                checks.append({'width': width, 'zoom': zoom, 'theme': theme, 'overflow': False})
        page.keyboard.press('Escape')
        assert page.locator('#creditReviewModal').is_hidden()
        assert page.locator('#creditReviewModal').is_hidden()
        (output / 'checks.json').write_text(json.dumps({'checks': checks, 'keyboard': 'passed', 'rows': 6}, indent=2), encoding='utf-8')
        print('PASS: 6 correction rows, official links, keyboard open/trap/close, 6 viewport/theme checks')
    finally:
        context.close()
