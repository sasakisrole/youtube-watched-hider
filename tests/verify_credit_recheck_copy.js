const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const CM = require('../credit_corrections.js');
const CT = require('../credit_target.js');
const read = file => fs.readFileSync(require.resolve('../' + file), 'utf8');
const background = read('background.js');
const block = background.slice(background.indexOf('function cleanCreditLine'), background.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine};')({CreditTarget: CT, CreditMaintenance: CM});
const analyze = description => CM.analyze(description, 'Alpha', parser.extractCreditSegments, parser.cleanCreditLine, CT);
const row = (id = 'sampleVid01') => ({videoId: id, title: 'Alpha', channel: 'Example channel', composer: 'Saved credit', creditsSource: 'general'});
const success = description => ({ok: true, title: 'Alpha', maintenance: analyze(description), description});
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

function boot(locale = 'en', clipboardMode = 'success', downloadMode = 'success') {
  const elements = {}, copied = [], ports = [], keys = new Set(), downloads = [], revoked = [];
  const runtime = {lastError: undefined, mbSent: [], mbResponse: null,
    sendMessage(message, callback) { this.mbSent.push(message); setImmediate(() => callback(this.mbResponse)); }};
  const confirms = [], accepted = [];
  let confirmAnswer = true;
  const review = {busy: new Set(), refreshReviewList() {}, lastBatch: [], pending: 0,
    adoptable(accept) { return Array.from({length: this.pending}, () => ({})); },
    async adoptAll(accept) {
      const own = {candidates: [{source: 'description-recheck', value: 'New credit'}]};
      const other = {candidates: [{source: 'description-recheck', value: 'New credit'}, {source: 'rule', value: 'Other'}]};
      accepted.push(accept(own, 'New credit'), accept(other, 'Other'));
      this.lastBatch = [{videoId: 'sampleVid01', role: 'composer'}]; this.pending = 0;
      return {targets: 1, adopted: 1, failed: 0};
    },
    async undoBatch() { this.lastBatch = []; this.pending = 1; return {targets: 1, undone: 1, failed: 0}; }};
  let records = [], saves = 0;
  const element = () => ({value: '', textContent: '', disabled: false, children: [], listeners: {},
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, checkValidity() { return true; }});
  const catalog = locale && JSON.parse(read('_locales/' + locale + '/messages.json'));
  const ctx = {CreditMaintenance: CM, CreditTarget: CT, structuredClone,
    CreditReview: {create() { return review; }},
    confirm(text) { confirms.push(text); return confirmAnswer; },
    document: {getElementById(id) { return elements[id] ||= element(); }, createElement: element},
    chrome: {runtime: Object.assign(runtime, {getManifest: () => JSON.parse(read('manifest.json')), connect() {
      const port = {onMessage: {addListener(fn) { port.receive = fn; }},
        onDisconnect: {addListener(fn) { port.disconnect = fn; }}, postMessage() {}};
      ports.push(port); return port;
    }}), downloads: {download(options, callback) {
      downloads.push(options);
      if (downloadMode === 'error') runtime.lastError = {message: 'blocked'};
      callback(downloadMode === 'success' ? 7 : undefined);
      runtime.lastError = undefined;
    }}},
    Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options.type; } },
    URL: {createObjectURL(blob) { downloads.blob = blob; return 'blob:report'; }, revokeObjectURL(url) { revoked.push(url); }},
    setTimeout(fn) { fn(); },
    navigator: clipboardMode === 'missing' ? {} : {clipboard: {writeText(text) {
      if (clipboardMode === 'throw') throw Error('unavailable');
      if (clipboardMode === 'reject') return Promise.reject(Error('denied'));
      copied.push(text); return Promise.resolve();
    }}},
  };
  if (catalog) ctx.historyMessage = (key, fallback, values = []) => {
    keys.add(key); assert(catalog[key], 'missing locale key ' + key);
    return catalog[key].message.replace(/\$([a-z_]+)\$/gi, (_, name) => catalog[key].placeholders[name.toLowerCase()].content)
      .replace(/\$(\d+)/g, (_, n) => values[n - 1]);
  };
  vm.runInNewContext(read('credit_maintenance.js'), ctx);
  const marked = [];
  ctx.CreditMaintenanceUI.create({getRecords: () => records, begin: () => true, end() {}, saveCreditRole() { saves++; },
    markRechecked(videoId, stamp) { marked.push([videoId, stamp]); const live = records.find(r => r.videoId === videoId); if (live) live.creditsRecheck = stamp; return Promise.resolve(true); }});
  const click = id => elements[id].listeners.click();
  return {elements, keys, copied, downloads, revoked, confirms, accepted, review, marked, runtime, click, get saves() { return saves; },
    set confirmAnswer(value) { confirmAnswer = value; },
    start(rows, scope = 'all') {
      records = rows; elements.creditRecheckScope.value = scope; elements.creditRecheckLimit.value = '50';
      click('creditRecheckStart'); return ports.at(-1);
    },
    progress(port, record, result) { port.receive({type: 'PROGRESS', videoId: record.videoId, result}); },
    done(port) { port.receive({type: 'DONE'}); },
    async report() { await click('creditRecheckCopy'); return JSON.parse(copied.at(-1)); },
  };
}

async function main() {
  await check('REQ-1: markup and zero checked disable copying', async () => {
    assert.match(read('history.html'), /<button[^>]+id="creditRecheckCopy"[^>]+disabled[^>]+data-i18n="history_recheckCopy"/);
    assert.match(read('history.html'), /id="creditRecheckCopyStatus"[^>]+role="status"/);
    const ui = boot();
    assert.equal(ui.elements.creditRecheckCopy.disabled, true);
    await ui.click('creditRecheckCopy'); assert.equal(ui.copied.length, 0);
    ui.start([row()]); assert.equal(ui.elements.creditRecheckCopy.disabled, true);
  });
  await check('REQ-2: complete JSON shape, counts, statuses, role sources, snapshot and evidence', async () => {
    const ui = boot();
    const rows = [row(), row('sampleVid02'), row('sampleVid03'), row('sampleVid04')];
    rows[0].lyricist = 'Manual credit'; rows[0].creditRoleSources = {lyricist: 'manual'};
    const port = ui.start(rows);
    const first = success('Composer: New credit\nLyricist: Suggested credit\nUnrelated promotional text');
    ui.progress(port, rows[0], first);
    ui.progress(port, rows[1], success('[Original]\nComposer: Original credit'));
    ui.progress(port, rows[2], success('Composer: Saved credit'));
    ui.progress(port, rows[3], {ok: false, reason: 'http-429', html: 'Never export raw response'});
    rows[0].composer = 'Later saved value';
    assert.equal(ui.elements.creditRecheckCopy.disabled, false);
    const report = await ui.report();
    assert.deepEqual(Object.keys(report).sort(), ['version', 'exportedAt', 'scope', 'counts', 'items'].sort());
    assert.equal(report.version, JSON.parse(read('manifest.json')).version); assert.equal(new Date(report.exportedAt).toISOString(), report.exportedAt);
    assert.equal(report.scope, 'all');
    assert.deepEqual(report.counts, {checked: 4, proposals: 1, held: 1, failed: 1});
    assert.deepEqual(report.items.map(item => item.status), ['proposal', 'held', 'ok', 'failed']);
    const item = report.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['videoId', 'title', 'channel', 'status', 'fetchReason', 'roles'].sort());
    assert.equal(item.videoId, 'sampleVid01'); assert.equal(item.title, 'Alpha'); assert.equal(item.channel, 'Example channel');
    assert.equal(item.fetchReason, '');
    assert.deepEqual(item.roles.composer, {current: 'Saved credit', currentSource: 'auto', candidate: 'New credit', heldReason: '', evidence: ['Composer: New credit']});
    assert.deepEqual(item.roles.lyricist, {current: 'Manual credit', currentSource: 'manual', candidate: 'Suggested credit', heldReason: '', evidence: ['Lyricist: Suggested credit']});
    assert.deepEqual(item.roles.arranger, {current: '', currentSource: 'auto', candidate: '', heldReason: '', evidence: []});
    assert.equal(report.items[3].fetchReason, 'http-429');
    assert.equal(report.items[3].roles.composer.heldReason, '');
    assert.deepEqual(report.items[3].roles.composer.evidence, []);
    assert.doesNotMatch(ui.copied.at(-1), /Unrelated promotional text|Never export raw response|description|html/);
    assert.equal(ui.saves, 0);
  });
  const heldCases = [
    ['no-evidence', 'Unrelated text', []],
    ['unparsed', 'Composer: https://example.com', ['Composer: https://example.com']],
    ['unparsed', 'Composer:', ['Composer:']],
    ['scope-mismatch', '[Original]\nComposer: Original credit', ['[Original]', 'Composer: Original credit']],
    ['scope-mismatch', 'Song: Beta\nComposer: Other credit', ['Song: Beta', 'Composer: Other credit']],
    ['conflict', 'Song: Alpha\nComposer: First credit\nSong: Alpha\nComposer: Second credit', ['Song: Alpha', 'Composer: First credit', 'Song: Alpha', 'Composer: Second credit']],
    ['unknown', 'Composer - Unsupported credit', ['Composer - Unsupported credit']],
  ];
  for (const [reason, description, evidence] of heldCases) {
    await check('REQ-2/4: held reason and evidence ' + reason + ' / ' + description.split('\n')[0], async () => {
      const ui = boot(), record = row(), port = ui.start([record]);
      ui.progress(port, record, success(description));
      const item = (await ui.report()).items[0];
      assert.equal(item.status, 'held'); assert.equal(item.roles.composer.heldReason, reason);
      assert.deepEqual(item.roles.composer.evidence, evidence);
      assert.equal(item.roles.composer.candidate, '');
    });
  }
  await check('REQ-2: mixed proposal/held counts and all role evidence', async () => {
    const record = {...row(), lyricist: 'Saved lyric', arranger: 'Saved arrangement'};
    const ui = boot(), port = ui.start([record]);
    ui.progress(port, record, success('Composer: New credit\nLyricist: https://example.com\nArranger: New contributor'));
    const report = await ui.report();
    assert.deepEqual(report.counts, {checked: 1, proposals: 2, held: 1, failed: 0});
    assert.equal(report.items[0].status, 'proposal');
    assert.equal(report.items[0].roles.lyricist.heldReason, 'unparsed');
    assert.deepEqual(report.items[0].roles.lyricist.evidence, ['Lyricist: https://example.com']);
    assert.deepEqual(report.items[0].roles.arranger.evidence, ['Arranger: New contributor']);
  });
  await check('REQ-2: continuation, scope changes, reset, and retry replace stale results', async () => {
    const ui = boot(), first = {...row(), title: 'Alpha Remix'}, second = row('sampleVid02');
    let port = ui.start([first], 'remix');
    ui.progress(port, first, {ok: false, reason: 'timeout'}); ui.done(port);
    ui.elements.creditRecheckScope.value = 'all'; ui.elements.creditRecheckScope.listeners.change();
    assert.equal((await ui.report()).scope, 'remix');
    port = ui.start([first, second]); ui.progress(port, second, success('Composer: Saved credit')); ui.done(port);
    assert.equal((await ui.report()).items.length, 2);
    ui.click('creditRecheckReset'); assert.equal(ui.elements.creditRecheckCopy.disabled, true);
    const before = ui.copied.length; await ui.click('creditRecheckCopy'); assert.equal(ui.copied.length, before);
    port = ui.start([first, second]); ui.progress(port, first, success('Composer: Saved credit'));
    const report = await ui.report();
    assert.equal(report.scope, 'all'); assert.equal(report.items.length, 2);
    assert.deepEqual(report.counts, {checked: 2, proposals: 0, held: 0, failed: 0});
    assert.equal(report.items[0].fetchReason, '');
  });
  await check('REQ-2/4: absent fetch result and unknown reason use empty strings', async () => {
    const ui = boot(), record = {...row(), title: '', channel: ''}, port = ui.start([record]);
    ui.progress(port, record, undefined);
    const item = (await ui.report()).items[0];
    assert.equal(item.status, 'failed'); assert.equal(item.fetchReason, ''); assert.equal(item.channel, ''); assert.equal(item.title, '');
  });
  for (const locale of ['ja', 'en', null]) {
    for (const mode of ['success', 'missing', 'throw', 'reject']) {
      await check('REQ-3: clipboard feedback ' + locale + '/' + mode, async () => {
        const ui = boot(locale, mode), record = row(), port = ui.start([record]);
        ui.progress(port, record, success('Composer: Saved credit'));
        await ui.click('creditRecheckCopy');
        const key = mode === 'success' ? 'history_recheckCopySuccess' : 'history_recheckCopyFailure';
        const catalog = JSON.parse(read('_locales/' + (locale || 'ja') + '/messages.json'));
        assert.equal(ui.elements.creditRecheckCopyStatus.textContent, catalog[key].message);
        assert.equal(ui.copied.length, mode === 'success' ? 1 : 0);
        if (locale) assert(ui.keys.has(key));
      });
    }
  }
  await check('SAVE-1: save button starts disabled and follows copy', async () => {
    assert.match(read('history.html'), /<button[^>]+id="creditRecheckSave"[^>]+disabled[^>]+data-i18n="history_recheckSave"/);
    const ui = boot();
    assert.equal(ui.elements.creditRecheckSave.disabled, true);
    await ui.click('creditRecheckSave'); assert.equal(ui.downloads.length, 0);
    const record = row(), port = ui.start([record]);
    ui.progress(port, record, success('Composer: New credit'));
    assert.equal(ui.elements.creditRecheckSave.disabled, false);
  });
  await check('SAVE-2: save writes the same report into the reports folder', async () => {
    const ui = boot('ja'), record = row(), port = ui.start([record]);
    ui.progress(port, record, success('Composer: New credit'));
    await ui.click('creditRecheckSave');
    const options = ui.downloads[0];
    assert.match(options.filename, /^youtube-watched-hider-reports\/credit-recheck-\d{8}-\d{6}\.json$/);
    assert.equal(options.saveAs, false); assert.equal(options.conflictAction, 'uniquify');
    assert.equal(ui.elements.creditRecheckCopyStatus.textContent, JSON.parse(read('_locales/ja/messages.json')).history_recheckSaveSuccess.message);
    const saved = JSON.parse(ui.downloads.blob.text), copied = await ui.report();
    delete saved.exportedAt; delete copied.exportedAt;
    assert.deepEqual(saved, copied);
    assert.deepEqual(ui.revoked, ['blob:report']);
  });
  for (const mode of ['error', 'missing-id']) {
    await check('SAVE-3: download failure is reported ' + mode, async () => {
      const ui = boot('en', 'success', mode), record = row(), port = ui.start([record]);
      ui.progress(port, record, success('Composer: New credit'));
      await ui.click('creditRecheckSave');
      assert.equal(ui.elements.creditRecheckCopyStatus.textContent, 'Could not save results.');
      assert.deepEqual(ui.revoked, ['blob:report']);
    });
  }
  await check('ADOPT-1: adopt all needs proposals and a confirmation, then offers undo', async () => {
    const html = read('history.html');
    assert.match(html, /<button[^>]+id="creditRecheckAdoptAll"[^>]+disabled/);
    assert.match(html, /<button[^>]+id="creditRecheckUndoAll"[^>]+disabled/);
    const ui = boot('ja'), record = row(), port = ui.start([record]);
    assert.equal(ui.elements.creditRecheckAdoptAll.disabled, true);
    ui.progress(port, record, success('Composer: Saved credit'));
    ui.done(port);
    assert.equal(ui.elements.creditRecheckAdoptAll.disabled, true);
    const next = row('sampleVid02'), port2 = ui.start([next]);
    ui.progress(port2, next, success('Composer: New credit')); ui.review.pending = 1;
    assert.equal(ui.elements.creditRecheckAdoptAll.disabled, true, 'disabled while scanning');
    ui.done(port2);
    assert.equal(ui.elements.creditRecheckAdoptAll.disabled, false);
    assert.equal(ui.elements.creditRecheckUndoAll.disabled, true);
    ui.confirmAnswer = false;
    await ui.click('creditRecheckAdoptAll');
    assert.equal(ui.confirms.length, 1); assert.equal(ui.review.lastBatch.length, 0);
    ui.confirmAnswer = true;
    await ui.click('creditRecheckAdoptAll');
    assert.deepEqual(ui.accepted, [true, false]);
    assert.equal(ui.elements.creditRecheckCopyStatus.textContent, '1件を採用しました。');
    assert.equal(ui.elements.creditRecheckUndoAll.disabled, false);
    assert.equal(ui.elements.creditRecheckAdoptAll.disabled, true, 'nothing left to adopt');
    ui.confirmAnswer = false;
    await ui.click('creditRecheckUndoAll');
    assert.equal(ui.review.lastBatch.length, 1, 'cancelled undo keeps the batch');
    assert.equal(ui.confirms.at(-1), 'まとめて採用した 1件を元に戻します。よろしいですか？');
    ui.confirmAnswer = true;
    await ui.click('creditRecheckUndoAll');
    assert.equal(ui.elements.creditRecheckCopyStatus.textContent, '1件を元に戻しました。');
    assert.equal(ui.elements.creditRecheckUndoAll.disabled, true);
  });
  await check('STAMP-1: only successful fetches are stamped, and reset rechecks stamped videos', async () => {
    const ui = boot(), ok = row(), bad = row('sampleVid02');
    let port = ui.start([ok, bad]);
    ui.progress(port, ok, success('Composer: Saved credit'));
    ui.progress(port, bad, {ok: false, reason: 'timeout'});
    ui.done(port);
    assert.deepEqual(ui.marked, [['sampleVid01', CM.recheckStamp(ok)]]);
    assert.equal(CM.targets([ok, bad], 'all', new Set(), 50, CT).map(r => r.videoId).join(), 'sampleVid02');
    ui.click('creditRecheckReset');
    port = ui.start([ok, bad]);
    ui.progress(port, ok, success('Composer: Saved credit'));
    assert.equal(ui.marked.length, 2, 'reset includes the stamped video again');
  });
  const mbFound = (stage) => ({success: true, candidate: {composer: 'Saved credit', lyricist: 'Carol・Dave', arranger: '',
    mbid: 'mb-1', roleRecordingIds: {lyricist: 'mb-2'}, mbTitle: 'Alpha', stage, manualReviewReason: ''}});
  const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  await check('MB-1: MusicBrainz is never queried unless the user opts in', async () => {
    const ui = boot(), record = {...row(), lyricist: 'Old lyric'}, port = ui.start([record]);
    ui.progress(port, record, success('Unrelated text')); await settle();
    assert.equal(ui.runtime.mbSent.length, 0);
    assert.match(read('history.html'), /<input id="creditRecheckMb" type="checkbox">/);
  });
  await check('MB-2: a strict match proposes held roles one by one; a fuzzy match proposes nothing', async () => {
    for (const [stage, proposals] of [['strict', 1], ['fuzzy', 0]]) {
      const ui = boot(), record = {...row(), lyricist: 'Old lyric'};
      ui.runtime.mbResponse = mbFound(stage);
      ui.elements.creditRecheckMb.checked = true;
      const port = ui.start([record]);
      ui.progress(port, record, success('Unrelated text')); await settle();
      assert.equal(JSON.stringify(ui.runtime.mbSent), JSON.stringify([{type: 'enrichCreditsMb', artist: 'Example channel', title: 'Alpha'}]));
      const report = await ui.report();
      assert.equal(report.counts.proposals, proposals, stage);
      assert.equal(report.items[0].musicbrainz.status, 'found');
      assert.equal(report.items[0].musicbrainz.stage, stage);
    }
  });
  await check('MB-3: an agreeing or failed lookup proposes nothing', async () => {
    for (const response of [mbFound('strict'), null, {success: true, candidate: null, reason: 'no-recording'}]) {
      const ui = boot(), record = {...row(), lyricist: 'Dave, Carol'};
      ui.runtime.mbResponse = response;
      ui.elements.creditRecheckMb.checked = true;
      const port = ui.start([record]);
      ui.progress(port, record, success('Unrelated text')); await settle();
      const report = await ui.report();
      assert.equal(report.counts.proposals, 0);
      assert.equal(report.items[0].musicbrainz.status, response ? (response.candidate ? 'found' : 'no-recording') : 'error');
    }
  });
  await check('REQ-6: release and locale metadata', () => {
    assert.equal(JSON.parse(read('manifest.json')).version, read('CHANGELOG.md').match(/^## v(\d+\.\d+\.\d+)/m)[1]);
    assert.match(read('CHANGELOG.md'), /## v1\.60\.29[^]*?Copy credit recheck results as JSON/);
    const ja = JSON.parse(read('_locales/ja/messages.json')), en = JSON.parse(read('_locales/en/messages.json'));
    assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
    for (const key of ['history_recheckCopy', 'history_recheckCopySuccess', 'history_recheckCopyFailure',
      'history_recheckSave', 'history_recheckSaveSuccess', 'history_recheckSaveFailure',
      'history_recheckAdoptAll', 'history_recheckAdoptAllConfirm', 'history_recheckAdoptAllRunning', 'history_recheckAdoptAllDone',
      'history_recheckAdoptAllPartial', 'history_recheckAdoptAllFailure', 'history_recheckUndoAll', 'history_recheckUndoAllConfirm', 'history_recheckUndoAllRunning',
      'history_recheckUndoAllDone', 'history_recheckUndoAllPartial', 'history_recheckUndoAllFailure',
      'history_recheckMb', 'history_recheckMbProgress']) assert(ja[key] && en[key]);
  });
  console.log(`RESULT: ${passed} passed / ${failed} failed / 0 skipped`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
