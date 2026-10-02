"""Render the real popup with synthetic Chrome responses and no external traffic."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)

mock = r"""({messages, language}) => {
  window.testWrites = [];
  window.testTabMessages = [];
  window.chrome = {
    i18n: {
      getUILanguage: () => language,
      getMessage: (key, args = []) => {
        const item = messages[key];
        if (!item) return '';
        let text = item.message;
        for (const [name, placeholder] of Object.entries(item.placeholders || {})) {
          const n = Number(placeholder.content.replace('$', '')) - 1;
          text = text.replaceAll('$' + name.toUpperCase() + '$', args[n] || '0');
        }
        return text.replace(/\$(\d+)/g, (_, n) => String(args[Number(n) - 1] ?? '0'));
      }
    },
    runtime: {
      getManifest: () => ({version: '1.58.0'}),
      sendMessage: (message, callback) => {
        let response = {success: true};
        if (message.type === 'GET_STATS') response = {count: 100000, dbStatus: 'ready', cacheMode: 'full', positiveCacheSize: 100000};
        if (message.type === 'GET_ENABLED') response = {enabled: true, autoBackup: true, migrationV135Done: true};
        if (message.type === 'EXPORT_DATA') response = [];
        if (callback) callback(response);
        return Promise.resolve(response);
      },
      getURL: name => name,
    },
    storage: {local: {
      get: (defaults, callback) => callback({...defaults}),
      set: (value, callback) => { testWrites.push(value); callback?.(); },
    }},
    tabs: {
      query: (_query, callback) => { const tabs = [{id: 17}]; callback?.(tabs); return Promise.resolve(tabs); },
      create() {},
      sendMessage: (id, message) => { testTabMessages.push({id, message}); return Promise.resolve({success: true}); },
    },
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    try:
        for language in ['ja', 'en']:
            messages = json.loads((root / '_locales' / language / 'messages.json').read_text(encoding='utf-8'))
            for theme in ['light', 'dark']:
                context = browser.new_context(viewport={'width': 320, 'height': 900}, color_scheme=theme, offline=True)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                init = '(' + mock + ')(' + json.dumps({'messages': messages, 'language': language}) + ')'
                page.add_init_script(init)
                page.goto((root / 'popup.html').as_uri())
                page.locator('#settingsBtn').focus()
                page.keyboard.press('Enter')
                assert page.locator('.settings-group').count() == 6
                assert page.locator('.settings-group[open]').count() == 1
                assert page.locator('#watchedThreshold').is_visible()
                assert not page.locator('#clearAllBtn').is_visible()
                assert not page.locator('#cacheModeBadge').is_visible()
                page.screenshot(path=str(output / f'popup-{language}-{theme}.png'), full_page=True)
                for i in range(1, 6):
                    summary = page.locator('.settings-group > summary').nth(i)
                    summary.focus()
                    page.keyboard.press('Space' if i % 2 else 'Enter')
                    assert page.locator('.settings-group').nth(i).get_attribute('open') is not None
                page.locator('#refreshCompletedPlaylists').click()
                assert page.evaluate("testTabMessages.some(item => item.id === 17 && item.message.type === 'REFRESH_COMPLETED_PLAYLISTS')")
                assert page.locator('#refreshCompletedPlaylists').is_enabled()
                assert page.locator('#playlistRefreshStatus').inner_text() == messages['popup_playlistRefreshStarted']['message']
                assert page.locator('#backupNowBtn').is_visible()
                assert page.locator('#syncImportBtn').is_visible()
                assert page.locator('#clearAllBtn').is_visible()
                page.locator('#dimWatched').focus()
                page.keyboard.press('Space')
                assert page.evaluate('testWrites.some(item => item.dimWatched === true)')
                assert page.locator('#dimWatched + .slider').evaluate("el => getComputedStyle(el).outlineStyle") == 'solid'
                for selector in ['.settings-group > summary', '.toggle input', '#backupNowBtn', '#playlistCardMode']:
                    for element in page.locator(selector).all():
                        if element.is_visible():
                            box = element.bounding_box()
                            assert box['width'] >= 44 and box['height'] >= 44, (selector, box)
                page.locator('#aboutBtn').focus()
                page.keyboard.press('Enter')
                assert page.locator('#cacheModeBadge').is_visible()
                # Tab through the expanded popup without executing destructive controls.
                page.locator('#settingsBtn').focus()
                seen = set()
                for _ in range(80):
                    page.keyboard.press('Tab')
                    page.wait_for_timeout(220)
                    state = page.evaluate("""() => {
                      const el = document.activeElement;
                      if (el === document.body) return null;
                      const target = el.matches('.toggle input') ? el.nextElementSibling : el;
                      const style = getComputedStyle(target);
                      return {id: el.id || el.outerHTML.slice(0, 100), outline: style.outlineStyle, width: style.outlineWidth};
                    }""")
                    if not state:
                        continue
                    if state['id'] in seen:
                        break
                    seen.add(state['id'])
                    assert state['outline'] == 'solid' and state['width'] == '2px', state
                assert len(seen) >= 20, len(seen)
                page.evaluate("document.documentElement.style.zoom = '2'")
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '200% layout overflows'
                page.screenshot(path=str(output / f'popup-{language}-{theme}-200.png'), full_page=True)
                assert not errors, errors
                context.close()
                print(f'PASS {language}/{theme}: native sections, keyboard, controls, 200% layout, no JS errors')
    finally:
        browser.close()
