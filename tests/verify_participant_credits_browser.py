"""Offline participation UI checks with synthetic records and mocked extension APIs."""
import argparse
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
mock = r"""() => {
  const records = [
    {videoId:'sample00001',title:'Example',channel:'Artist - Topic',composer:'Composer',lyricist:'Lyricist',arranger:'Arranger',participants:[{name:'Kenbo(CLACK inc.)',role:'Drums arrange'},{name:'是',role:'ピアノ編曲'}]},
    {videoId:'sample00002',title:'Other',channel:'General',creditsRaw:'Raw',participants:[{name:'X',role:'Strings Arrangement'}]}
  ].map(r=>({...r,watchedAt:1700000000000,playCount:1,durationSec:100}));
  window.sentJobs=[];
  window.chrome={
    i18n:{getMessage:()=>'',getUILanguage:()=> 'ja'},
    runtime:{
      sendMessage:(m,cb)=>{const data=m.type==='EXPORT_DATA'?records:m.type==='GET_LIKED'?[]:{success:true};cb?.(data);return Promise.resolve(data);},
      connect:()=>({onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage:m=>sentJobs.push(m)})
    },
    storage:{local:{get:(_k,cb)=>{cb?.({});return Promise.resolve({});},set:(_v,cb)=>{cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}
  };
}"""
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    try:
        context = browser.new_context(offline=True)
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
        page.wait_for_function('allData.length === 2')
        page.locator('#search').fill('Kenbo')
        page.wait_for_function('sortedCache.length === 1')
        assert page.evaluate('sortedCache[0].videoId') == 'sample00001'
        page.locator('#search').fill('')
        page.locator('#toggleAnalyze').click()
        page.locator('[data-aztab="credits"]').click()
        page.locator('[data-credit="participants"]').click()
        page.wait_for_function("document.querySelectorAll('#azCreditsTable tbody tr').length === 2")
        assert page.locator('#azParticipantRoleHeader').is_visible()
        rows = page.locator('#azCreditsTable tbody tr').all_inner_texts()
        assert any('Kenbo(CLACK inc.)' in row and 'Drums arrange' in row for row in rows), rows
        assert any('是' in row and 'ピアノ編曲' in row for row in rows), rows
        assert page.locator('#azCreditsTable tbody tr').first.locator('td').count() == 6
        page.locator('#azIncludeGeneral').check()
        assert page.locator('#azCreditsTable tbody').inner_text().find('Strings Arrangement') >= 0
        page.locator('[data-credit="composer"]').click()
        assert not page.locator('#azParticipantRoleHeader').is_visible()
        assert page.locator('#azCreditsTable tbody tr').first.locator('td').count() == 5
        assert page.locator('#azCreditsTable tbody tr').count() == 1
        page.locator('[data-credit="raw"]').click()
        assert page.locator('#azCreditsTable tbody tr').count() == 1
        page.locator('[data-credit="participants"]').click()
        page.locator('#toggleAnalyze').click()
        page.locator('#toggleAnalyze').click()
        page.wait_for_timeout(100)
        assert not errors, errors
        page.locator('#toggleAnalyze').click()
        page.locator('#maintToggle').click()
        page.locator('#participantsOnly').check()
        page.locator('#includeGeneralCredits').check()
        page.on('dialog', lambda dialog: dialog.accept())
        page.locator('#fixCredits').click()
        jobs = page.evaluate('sentJobs')
        assert len(jobs) == 1 and jobs[0]['participantsOnly'] is True, jobs
        assert jobs[0]['videoIds'] == ['sample00001', 'sample00002'], jobs
        assert not errors, errors
        print('PASS offline browser: participation role cells, filters, unchanged counts, reopen, name search, participant-only backfill message; no JavaScript errors')
    finally:
        browser.close()
