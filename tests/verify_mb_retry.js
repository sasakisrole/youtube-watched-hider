const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = source.slice(source.indexOf('const ENRICH_RATE_LIMIT_MS'), source.indexOf('function decodeHtmlEntities'));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function boot(responses) {
  let now = 100000;
  const calls = [], sleeps = [];
  const ctx = {AbortController, Date: {now: () => now},
    setTimeout(fn, ms) { if (ms !== 30000) { sleeps.push(ms); now += ms; fn(); } return 1; }, clearTimeout() {},
    async fetch(url) {
      calls.push({url, time: now});
      const next = responses.shift();
      if (next === 'timeout') { const error = Error('aborted'); error.name = 'AbortError'; throw error; }
      return {ok: next.status === 200, status: next.status, headers: {get: () => next.after ?? null}, text: async () => 'ok'};
    }};
  vm.runInNewContext(block, ctx);
  return {calls, sleeps, fetch: ctx.fetchEnrichText};
}
async function main() {
  await check('503 retries once then succeeds', async () => {
    const b = boot([{status: 503}, {status: 200}]);
    assert.equal((await b.fetch('mb', 'a')).text, 'ok'); assert.equal(b.calls.length, 2); assert.deepEqual(b.sleeps, [2000]);
  });
  await check('429 honors Retry-After seconds', async () => {
    const b = boot([{status: 429, after: '5'}, {status: 200}]);
    await b.fetch('mb', 'a'); assert.deepEqual(b.sleeps, [5000]);
  });
  await check('third failure gives up with HTTP error and 2s/4s backoff', async () => {
    const b = boot([{status: 503}, {status: 503}, {status: 503}]);
    await assert.rejects(b.fetch('mb', 'a'), /HTTP 503/); assert.equal(b.calls.length, 3); assert.deepEqual(b.sleeps, [2000, 4000]);
  });
  await check('404 is not retried', async () => {
    const b = boot([{status: 404}]); await assert.rejects(b.fetch('mb', 'a'), /HTTP 404/); assert.equal(b.calls.length, 1);
  });
  await check('timeout retries only once and has short error', async () => {
    const b = boot(['timeout', 'timeout']); await assert.rejects(b.fetch('mb', 'a'), /^Error: timeout$/); assert.equal(b.calls.length, 2);
  });
  await check('timeout can recover', async () => {
    const b = boot(['timeout', {status: 200}]); assert.equal((await b.fetch('mb', 'a')).text, 'ok');
  });
  await check('queue cannot interleave retries and all starts are >=1100ms apart', async () => {
    const b = boot([{status: 503, after: '0'}, {status: 200}, {status: 200}]);
    await Promise.all([b.fetch('mb', 'a'), b.fetch('mb', 'b')]);
    assert.deepEqual(b.calls.map(c => c.url), ['a', 'a', 'b']);
    for (let i = 1; i < b.calls.length; i++) assert(b.calls[i].time - b.calls[i - 1].time >= 1100);
  });
  await check('non-MB sources keep single attempt behavior', async () => {
    for (const response of [{status: 503}, 'timeout']) {
      const b = boot([response]); await assert.rejects(b.fetch('youtube', 'a')); assert.equal(b.calls.length, 1); assert.deepEqual(b.sleeps, []);
    }
  });
  await check('both message handlers retain HTTP failure', async () => {
    for (const type of ['enrichCreditsMb', 'lookupMbArtistReading']) {
      const start = source.indexOf("  if (message.type === '" + type + "')");
      const end = source.indexOf('\n  if (message.type', start + 1);
      let response;
      new Function('message', 'sendResponse', 'enrichCreditsLookupMb', 'lookupMbArtistReading', source.slice(start, end))(
        {type, name: 'Alice'}, value => { response = value; }, () => Promise.reject(Error('HTTP 503')), () => Promise.reject(Error('HTTP 503')));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(response.error, 'HTTP 503');
    }
  });
  await check('artist-reading failure keeps detail', async () => {
    const CM = require('../credit_corrections.js');
    const lookup = CM.createArtistReadingLookup(async () => ({success: false, error: 'timeout'}));
    const result = await lookup('Alice, 山田', true, true);
    assert.equal(result.complete, false); assert.equal(result.error, 'timeout');
  });
  await check('recording failure detail enters export item', () => {
    const ui = fs.readFileSync(require.resolve('../credit_maintenance.js'), 'utf8');
    const start = ui.indexOf('    function applyMb('), end = ui.indexOf('      // A fuzzy title', start);
    const item = {};
    new Function('exports', ui.slice(start, end) + '}\nreturn applyMb;')(new Map([['video', item]]))({record: {videoId: 'video'}}, {success: false, reason: 'fetch-error', error: 'HTTP 503'});
    assert.equal(item.musicbrainz.error, 'HTTP 503');
  });
  const harness = fs.readFileSync(require.resolve('./verify_credit_recheck_copy.js'), 'utf8');
  const bootUi = new Function('require', harness.slice(0, harness.indexOf('async function main()')) + '\nreturn boot;')(require);
  await check('exported JSON keeps recording and artist lookup errors', async () => {
    for (const composer of ['Saved credit', 'Alice, 山田']) {
      const ui = bootUi();
      ui.elements.creditRecheckMb.checked = true;
      ui.runtime.mbResponse = {success: false, reason: 'fetch-error', error: 'HTTP 503'};
      const row = {videoId: 'sampleVid01', title: 'Alpha', channel: 'Artist', creditsSource: 'general', composer};
      const port = ui.start([row]);
      ui.progress(port, row, {ok: true, maintenance: {credits: {}, evidence: {}}});
      ui.done(port);
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal((await ui.report()).items[0].musicbrainz.error, 'HTTP 503');
    }
  });
  await check('cleanup survives UI export with bulk adoption disabled', async () => {
    const ui = bootUi();
    const row = {videoId: 'sampleVid01', title: 'Alpha', creditsSource: 'general', composer: 'Alice様'};
    const port = ui.start([row]);
    ui.progress(port, row, {ok: true, maintenance: {credits: {}, evidence: {}}});
    ui.done(port);
    const report = await ui.report();
    assert.deepEqual(report.items[0].roles.composer.proposal, {value: 'Alice', source: 'description-cleanup', adoptable: false, bucket: 'visual'});
    assert.equal(report.counts.adoptable, 0);
  });
  console.log(`RESULT: ${passed} passed / 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
