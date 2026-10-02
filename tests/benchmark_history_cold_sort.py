"""Measure cold filtered sort changes against a Git revision, offline."""
import argparse
import hashlib
import os
import tempfile
import json
import mimetypes
from pathlib import Path
import statistics
import subprocess
from urllib.parse import urlparse, unquote

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--baseline', default='HEAD')
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
baseline = subprocess.check_output(['git', '-C', str(root), 'show', args.baseline + ':history.js'])
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
mock = r"""() => {
  const records = Array.from({length: 100000}, (_, i) => ({
    videoId: String(i).padStart(11, '0'), title: 'Music ' + String((i * 7919) % 100000).padStart(6, '0'),
    channel: 'Channel ' + (i % 100), watchedAt: 1700000000000 + i * 1000, playCount: 1 + i % 5,
  }));
  window.chrome = {
    i18n: {getMessage: () => '', getUILanguage: () => 'ja'},
    runtime: {
      sendMessage: (message, callback) => {
        const data = message.type === 'EXPORT_DATA' ? records : {success: true};
        callback?.(data); return Promise.resolve(data);
      },
    },
    storage: {local: {
      get: (keys, callback) => { callback?.({}); return Promise.resolve({}); },
      set: (_values, callback) => { callback?.(); return Promise.resolve(); },
    }, onChanged: {addListener() {}}},
  };
}"""
results = {}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    try:
        for version in ['baseline', 'current']:
            context = browser.new_context(offline=True, viewport={'width': 1200, 'height': 900})
            def route_request(route):
                url = urlparse(route.request.url)
                if url.hostname != 'ywh.test':
                    route.abort()
                    return
                path = (root / unquote(url.path).lstrip('/')).resolve()
                if not path.is_relative_to(root) or not path.is_file():
                    route.abort()
                    return
                body = baseline if version == 'baseline' and path == root / 'history.js' else path.read_bytes()
                content_type = 'application/javascript' if path.suffix == '.js' else mimetypes.guess_type(str(path))[0]
                route.fulfill(body=body, content_type=content_type or 'application/octet-stream')
            context.route('**/*', route_request)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script('(' + mock + ')()')
            page.goto('https://ywh.test/history.html')
            page.wait_for_function('allData.length === 100000 && renderedCount === 100')
            page.locator('.sort-btn[data-sort="title"]').click()
            measured = page.evaluate(r"""() => {
              const samples = {}, outputs = [];
              for (const query of ['music 0000', 'music 00', 'music']) {
                for (const mode of ['title', 'channel', 'count-desc', 'date-asc']) {
                  const key = query + '/' + mode;
                  samples[key] = [];
                  for (let run = 0; run < 5; run++) {
                    allData = allData.slice();
                    currentSort = 'date-desc'; searchInput.value = ''; render();
                    searchInput.value = query; render();
                    currentSort = mode;
                    const start = performance.now();
                    render(); content.getBoundingClientRect();
                    samples[key].push(performance.now() - start);
                    if (run === 0) outputs.push({key, ids: sortedCache.map(v => v.videoId)});
                  }
                }
              }
              return {samples, outputs};
            }""")
            assert not errors, errors
            measured['medians_ms'] = {key: statistics.median(values) for key, values in measured['samples'].items()}
            results[version] = measured
            context.close()
        assert results['baseline']['outputs'] == results['current']['outputs'], 'displayed history differs'
    finally:
        browser.close()
results['description'] = '100k synthetic records; cold sort change after filtering to 100, 10000 or 100000 rows, all four nondefault sorts, five runs. DOM/layout included; debounce/paint excluded. Each run starts with a new data array and date-desc order.'
results['baseline_commit'] = subprocess.check_output(['git', '-C', str(root), 'rev-parse', args.baseline], text=True).strip()
results['current_history_sha256'] = hashlib.sha256((root / 'history.js').read_bytes()).hexdigest()
temporary = None
try:
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(results, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, output)
finally:
    if temporary is not None and temporary.exists():
        temporary.unlink()
print(json.dumps({version: results[version]['medians_ms'] for version in ['baseline', 'current']}))
print('PASS matching displayed records and no JavaScript errors')
