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
mock = r"""(locales) => {
  const lang = new URL(location.href).searchParams.get("lang") || "ja";
  const messages = locales[lang];
  const make = (id,title,manual=false) => ({videoId:id,title,composer:'Old',lyricist:'Old',arranger:'Old',creditsSource:manual?'manual':'general',watchedAt:123,playCount:1});
  window.testRecords = [make('anyVideo001','First (Guest Remix)'),make('anyVideo002','Second Remix'),make('anyVideo003','Plain Song'),make('anyVideo004','Unclear Remix'),make('anyVideo005','Manual Remix',true)];
  window.testWrites=[];
  window.chrome = {
    i18n: {getUILanguage: () => lang, getMessage: (key, subs=[]) => {
      const entry=messages[key]; if(!entry)return '';
      return entry.message.replace(/\$([a-z0-9_]+)\$/gi, (all,name) => {
        const field=entry.placeholders?.[name.toLowerCase()];
        return field ? (subs[Number(field.content.slice(1))-1] ?? '') : all;
      });
    }},
    runtime: {
      connect: () => {
        let onMessage, onDisconnect, aborted=false;
        return {
          onMessage:{addListener: fn => {onMessage=fn;}}, onDisconnect:{addListener:fn=>{onDisconnect=fn;}},
          postMessage: data => {
            if(data.type==='ABORT'){aborted=true;return;}
            (async()=>{
              let processed=0;
              for(const id of data.videoIds){
                await new Promise(resolve=>setTimeout(resolve,70));
                if(aborted)break;
                const row=testRecords.find(r=>r.videoId===id);
                const credits=(id==='anyVideo004'||window.testHoldAll)?{composer:'',lyricist:'',arranger:''}:{composer:'Alice',lyricist:'Bob',arranger:'Guest'};
                onMessage({type:'PROGRESS',videoId:id,processed:++processed,total:data.videoIds.length,result:{ok:true,title:row.title,maintenance:{credits,evidence:{composer:'Composer: Alice',lyricist:'Lyrics: Bob',arranger:'Arranger: Guest'}}}});
              }
              onMessage({type:'DONE',processed,total:data.videoIds.length,aborted}); onDisconnect?.();
            })();
          }
        };
      },
      sendMessage: (message, callback) => {
        let result={success:true};
        if(message.type==='EXPORT_DATA')result=structuredClone(testRecords);
        if(message.type==='DB_RPC'){
          const r=testRecords.find(r=>r.videoId===message.videoId), role=message.role;
          const source=r.creditRoleSources?.[role]||r.creditsSource;
          if(r[role]!==message.expectedCurrent||source!==message.expectedSource)result={conflict:true};
          else {
            const previous={value:r[role],source,sourcePresent:Object.hasOwn(r.creditRoleSources||{},role)};
            r[role]=message.value; r.creditRoleSources ||= {};
            if(Object.hasOwn(message,'restoreRoleSource')) {if(message.restoreRoleSource===null)delete r.creditRoleSources[role];else r.creditRoleSources[role]=message.restoreRoleSource;}
            else r.creditRoleSources[role]='manual';
            result={updated:true,previous,post:{value:r[role],source:r.creditRoleSources[role]||r.creditsSource}};
            testWrites.push(message);
          }
        }
        if(message.type==='DB_RPC') result={success:true,result};
        callback?.(result); return Promise.resolve(result);
      }
    },
    storage:{local:{get:(_keys,cb)=>{cb?.({});return Promise.resolve({});},set:(_values,cb)=>{cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}
  };
}"""
with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(str(output / 'browser-profile'), executable_path=args.browser, headless=True, viewport={'width': 1200, 'height': 900})
    try:
        settings = context.pages[0]
        settings.goto('chrome://settings/appearance')
        settings.locator('#zoomLevel').select_option('1')
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
        locales = {lang: json.loads((root / '_locales' / lang / 'messages.json').read_text(encoding='utf-8')) for lang in ['ja', 'en']}
        page.add_init_script('(' + mock + ')(' + json.dumps(locales) + ')')
        page.goto('https://ywh.test/history.html')
        page.wait_for_function('typeof creditReviewController !== "undefined" && creditReviewController !== null')
        if page.locator('#maintToggle').get_attribute('aria-expanded') == 'false':
            page.locator('#maintToggle').click()
        if page.locator('#repairToggle').get_attribute('aria-expanded') == 'false':
            page.locator('#repairToggle').click()
        page.locator('#creditReviewOpen').focus()
        page.keyboard.press('Enter')
        page.keyboard.press('Shift+Tab')
        assert page.evaluate('document.activeElement.closest("#creditReviewModal") !== null')
        page.keyboard.press('Tab')
        assert page.evaluate('document.activeElement.id === "creditReviewClose"')
        page.locator('#creditRecheckLimit').fill('1')
        def scan():
            page.locator('#creditRecheckStart').click()
            page.wait_for_function('!document.getElementById("creditRecheckStart").disabled')
        scan()
        assert page.locator('.credit-review-item').count() == 3
        assert page.evaluate('testWrites.length') == 0
        page.locator('[data-credit-review-action="adopt"]').first.click()
        page.wait_for_function('testWrites.length === 1')
        page.locator('#creditReviewList [data-credit-review-action="undo"]').first.click()
        page.wait_for_function('testWrites.length === 2')
        assert page.evaluate('testRecords[0].composer') == 'Old'
        scan()
        assert page.locator('.credit-review-item').count() == 6
        scan()
        assert page.locator('#creditRecheckIssues').inner_text().find('Unclear Remix') >= 0
        page.locator('#creditRecheckScope').select_option('all')
        scan()
        assert page.locator('.credit-review-item').count() == 9
        assert page.evaluate('testWrites.length') == 2
        page.locator('#creditRecheckReset').click()
        page.locator('#creditRecheckLimit').fill('50')
        page.locator('#creditRecheckStart').click()
        page.locator('#creditRecheckStop').click()
        page.wait_for_function('!document.getElementById("creditRecheckStart").disabled')
        assert page.evaluate('testWrites.length') == 2
        page.evaluate('window.testHoldAll = true')
        scan()
        assert page.locator('#creditReviewList [data-credit-review-action="adopt"]').count() == 0
        assert page.evaluate('testWrites.length') == 2
        checks = []
        for width, zoom in [(1200, 1), (390, 1), (1200, 2)]:
            page.set_viewport_size({'width': width, 'height': 900})
            settings.locator('#zoomLevel').select_option(str(zoom))
            page.reload()
            page.wait_for_function('typeof creditReviewController !== "undefined" && creditReviewController !== null')
            page.evaluate('creditReviewController.open()')
            scan()
            assert page.evaluate('devicePixelRatio') == zoom
            assert page.evaluate('getComputedStyle(document.documentElement).zoom') == '1'
            for theme in ['light', 'dark']:
                page.emulate_media(color_scheme=theme)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert page.evaluate('''() => [...document.querySelectorAll('.credit-review-item')].every(e => e.scrollWidth <= e.clientWidth + 1)''')
                page.screenshot(path=str(output / f'{width}-{zoom}-{theme}.png'))
                action = page.locator('#creditReviewList [data-credit-review-action="adopt"]').first
                action.scroll_into_view_if_needed()
                assert action.is_visible()
                assert action.bounding_box()['height'] >= 40
                page.screenshot(path=str(output / f'{width}-{zoom}-{theme}-action.png'))
                checks.append({'width': width, 'zoom': zoom, 'theme': theme, 'overflow': False})
        page.keyboard.press('Escape')
        assert page.locator('#creditReviewModal').is_hidden()
        page.goto('https://ywh.test/history.html?lang=en')
        page.wait_for_function('typeof creditReviewController !== "undefined" && creditReviewController !== null')
        page.evaluate('creditReviewController.open()')
        scan()
        assert page.locator('#creditReviewTitle').inner_text() == 'Recheck saved credits'
        assert 'Scanned on this page: 3' in page.locator('#creditRecheckStatus').inner_text()
        assert page.locator('#creditReviewList').inner_text().find('Composer: Alice') >= 0

        (output / 'checks.json').write_text(json.dumps({'checks': checks, 'keyboard': 'passed', 'rows': 9}, indent=2), encoding='utf-8')
        print('PASS: generic Remix/all-history scan, continuation, held evidence, adopt/undo, zero scan writes, stop, keyboard and six native zoom/theme checks')
    finally:
        context.close()
