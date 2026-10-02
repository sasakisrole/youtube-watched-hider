"""Check native Chromium 200% zoom in a disposable profile, never the user's profile."""
import argparse
import ast
import json
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
tree = ast.parse((root / 'tests/verify_popup_settings.py').read_text(encoding='utf-8'))
mock = next(ast.literal_eval(node.value) for node in tree.body
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'mock' for t in node.targets))
profile = Path(tempfile.mkdtemp(prefix='zoom-profile-', dir=output))
closed = False
try:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(profile), executable_path=args.browser,
                                                      headless=True, viewport={'width': 320, 'height': 900})
        try:
            settings = context.pages[0]
            settings.goto('chrome://settings/appearance')
            settings.locator('#zoomLevel').select_option('2')
            context.set_offline(True)
            for language in ['ja', 'en']:
                messages = json.loads((root / '_locales' / language / 'messages.json').read_text(encoding='utf-8'))
                for theme in ['light', 'dark']:
                    page = context.new_page()
                    page.emulate_media(color_scheme=theme)
                    page.add_init_script('(' + mock + ')(' + json.dumps({'messages': messages, 'language': language}) + ')')
                    page.goto((root / 'popup.html').as_uri())
                    assert page.evaluate('devicePixelRatio') == 2, 'native zoom did not apply'
                    assert page.evaluate('getComputedStyle(document.documentElement).zoom') == '1'
                    page.locator('#settingsBtn').focus()
                    page.keyboard.press('Enter')
                    for i in range(1, 6):
                        page.locator('.settings-group > summary').nth(i).focus()
                        page.keyboard.press('Enter')
                    page.locator('#playlistCardMode').select_option('hide')
                    assert page.locator('#playlistCardPlaces').is_visible()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'native 200% overflows'
                    page.locator('#clearAllBtn').scroll_into_view_if_needed()
                    assert page.locator('#clearAllBtn').is_visible()
                    page.screenshot(path=str(output / f'popup-{language}-{theme}-native200.png'), full_page=True)
                    page.close()
                    print(f'PASS {language}/{theme}: native 200% zoom, all sections, playlist subsettings, bottom reachable')
        finally:
            context.close()
            closed = True
finally:
    if closed:
        assert profile.resolve().is_relative_to(output) and profile.name.startswith('zoom-profile-')
        shutil.rmtree(profile)
