const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const CM = require('../credit_corrections.js');
const CT = require('../credit_target.js');
const read = file => fs.readFileSync(require.resolve('../' + file), 'utf8');
const source = read('background.js');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine};')({CreditTarget: CT, CreditMaintenance: CM});
const analyze = description => CM.analyze(description, 'Alpha', parser.extractCreditSegments, parser.cleanCreditLine, CT);
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS ' + name); }

check('reason no-evidence: no role label', () => assert.equal(analyze('An instrumental recording').reasons.composer, 'no-evidence'));
check('reason unparsed: labelled value rejected', () => {
  assert.equal(analyze('Composer: https://example.com').reasons.composer, 'unparsed');
  assert.equal(analyze('Composer:').reasons.composer, 'unparsed');
});
check('reason conflict: incompatible lists in repeated matching sections', () => {
  const result = analyze('Song: Alpha\nComposer: Contributor One\nSong: Alpha\nComposer: Contributor Two');
  assert.equal(result.reasons.composer, 'conflict');
  assert.equal(result.credits.composer, '');
  assert(result.held.includes('composer'));
});
check('reason scope-mismatch: only another song or version', () => {
  for (const header of ['Song: Beta', '[Original]']) {
    assert.equal(analyze(header + '\nArranger: Contributor One').reasons.arranger, 'scope-mismatch');
  }
});
check('reason unknown: unscoped evidence among song sections', () => {
  assert.equal(analyze('Composer: Contributor One\nSong: Beta\nLyricist: Contributor Two').reasons.composer, 'unknown');
});
check('unrecognized role-like text is unknown rather than absent', () => {
  assert.equal(analyze('Composer - Contributor One').reasons.composer, 'unknown');
  assert.equal(analyze('[Notes [Composer]: Contributor One]').reasons.composer, 'unknown');
});
check('mixed rejected and excluded evidence does not guess a cause', () => {
  assert.equal(analyze('Composer: https://example.com\nSong: Beta\nComposer: Contributor One').reasons.composer, 'unknown');
});
check('co-contributors within a section remain accepted without a reason', () => {
  const result = analyze('Song: Alpha\nComposer: Contributor One\nComposer: Contributor Two');
  assert.equal(result.credits.composer, 'Contributor One, Contributor Two');
  assert.equal(result.reasons.composer, undefined);
});
check('identical repeated lists are not conflicts', () => {
  const result = analyze('Song: Alpha\nComposer: Contributor One, Contributor Two\nSong: Alpha\nComposer: Contributor Two, Contributor One');
  assert(result.credits.composer);
  assert.equal(result.reasons.composer, undefined);
});

const record = {videoId: 'sampleVid01', title: 'Alpha', composer: 'Saved One', arranger: 'Saved Two', creditsSource: 'general'};
function boot(locale, row = record) {
  const elements = {}, keys = new Set();
  const element = () => ({dataset:{},children: [], textContent: '', value: 'all', listeners: {}, disabled: false,
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, checkValidity() { return true; }});
  let listener, materials, refresh;
  const ctx = {CreditMaintenance: CM, CreditTarget: CT, structuredClone,
    CreditReview: {create(env) { materials = env.getMaterials; refresh = env.onRefresh; return {busy: new Set(), refreshReviewList() {}, adoptable() { return []; }}; }},
    document: {getElementById(id) { return elements[id] ||= element(); }, createElement: element},
    chrome: {runtime: {connect() { return {onMessage: {addListener(fn) { listener = fn; }}, onDisconnect: {addListener() {}}, postMessage() {}}; }}}};
  if (locale) {
    const catalog = JSON.parse(read('_locales/' + locale + '/messages.json'));
    ctx.historyMessage = (key, fallback, values = []) => {
      keys.add(key);
      const entry = catalog[key];
      assert(entry, 'missing translation: ' + key);
      return entry.message.replace(/\$([a-z0-9_]+)\$/gi, (_, name) => entry.placeholders[name.toLowerCase()].content)
        .replace(/\$(\d+)/g, (_, n) => values[n - 1]);
    };
  }
  vm.runInNewContext(read('credit_maintenance.js'), ctx);
  ctx.CreditMaintenanceUI.create({getRecords: () => [row], begin: () => true, end() {}, saveCreditRole() { throw Error('unexpected save'); }});
  elements.creditRecheckLimit.value = '50';
  elements.creditRecheckStart.listeners.click();
  return {keys, elements, materials, refresh: () => refresh(), done(data = {}) { listener({type: 'DONE', ...data}); }, progress(result) { listener({type: 'PROGRESS', videoId: row.videoId, result}); },
    issues() { return elements.creditRecheckIssues.children.map(item => item.children[1].textContent).join('\n'); }};
}
for (const locale of [null, 'ja', 'en']) {
  check('proposed role is never also held; other roles remain visible: ' + locale, () => {
    const ui = boot(locale);
    ui.progress({ok: true, title: 'Alpha', maintenance: analyze('Composer: New contributor')});
    assert.equal(ui.materials().candidates.length, 1);
    assert.equal(ui.materials().candidates[0].role, 'composer');
    assert.match(ui.issues(), locale === 'en' ? /Arranger: Not listed/ : /編曲: 記載なし/);
    assert.doesNotMatch(ui.issues(), /Composer:|作曲:/);
  });
  check('no held row for unchanged, manual or blank roles: ' + locale, () => {
    for (const row of [record, {...record, arranger: ''}, {...record, creditRoleSources: {arranger: 'manual'}}]) {
      const ui = boot(locale, row);
      ui.progress({ok: true, title: 'Alpha', maintenance: analyze('Composer: Saved One\nArranger: Saved Two')});
      assert.equal(ui.issues(), '');
    }
  });
  check('manual and blank roles with no evidence are omitted: ' + locale, () => {
    const ui = boot(locale, {...record, arranger: '', lyricist: 'Saved Three', creditRoleSources: {lyricist: 'manual'}});
    ui.progress({ok: true, title: 'Alpha', maintenance: analyze('Composer: Saved One')});
    assert.equal(ui.issues(), '');
  });
  check('unknown reasons and older responses use unknown wording: ' + locale, () => {
    for (const reasons of [undefined, {composer: 'future-reason'}]) {
      const ui = boot(locale);
      ui.progress({ok: true, maintenance: {credits: {}, evidence: {}, reasons}});
      assert.match(ui.issues(), locale === 'en' ? /Unknown reason/ : /理由不明/);
    }
  });
  const failureCases = [
    ['sorry-redirect', /ボット確認/, /bot check/],
    ['video-identity-mismatch', /動画を照合/, /matched to the requested video/],
    ['no-youtube-tab', /YouTubeタブを開いて/, /Open a YouTube tab/],
    ['proxy-failed', /応答を取得/, /response from the YouTube tab/],
    ['no-playerResponse', /再生情報/, /player information/],
    ['no-videoDetails', /詳細情報/, /video details/],
    ['no-description', /概要欄/, /description/],
    ['timeout', /タイムアウト/, /timed out/],
    ['aborted', /中止/, /cancelled/],
    ['fetch-error', /通信エラー/, /network error/],
    ['http-429', /HTTPエラー 429/, /HTTP error 429/],
    ['future-reason', /原因を特定できない/, /unknown reason/],
    [undefined, /原因を特定できない/, /unknown reason/],
  ];
  for (const [reason, ja, en] of failureCases) check('fetch failure ' + reason + ': ' + locale, () => {
    const ui = boot(locale);
    ui.progress({ok: false, reason});
    assert.match(ui.issues(), locale === 'en' ? en : ja);
    if (reason !== 'no-youtube-tab') assert.doesNotMatch(ui.issues(), /YouTubeタブを開いて|Open a YouTube tab/);
    assert.match(ui.elements.creditRecheckStatus.textContent, locale === 'en' ? /held: 0/ : /保留 0/);
  });
  check('all held reason translations are exercised: ' + locale, () => {
    for (const [reason, ja, en] of [['unparsed', /解析できない/, /Could not parse/], ['conflict', /競合/, /Conflicting credits/], ['scope-mismatch', /曲・版の照合不一致/, /Song\/version mismatch/]]) {
      const ui = boot(locale);
      ui.progress({ok: true, maintenance: {credits: {}, evidence: {}, reasons: {composer: reason}}});
      assert.match(ui.issues(), locale === 'en' ? en : ja);
    }
  });
}
for (const locale of [null, 'ja', 'en']) {
  check('completion message survives later status updates: ' + locale, () => {
    const done = locale === 'en' ? /recheck is complete/ : /点検が完了しました/;
    const ui = boot(locale);
    ui.progress({ok: true, title: 'Alpha', maintenance: analyze('Composer: Saved One\nArranger: Saved Two')});
    ui.done();
    assert.match(ui.elements.creditRecheckStatus.textContent, done);
    ui.refresh();
    assert.match(ui.elements.creditRecheckStatus.textContent, done);
    const failed = boot(locale);
    failed.progress({ok: false, reason: 'timeout'});
    failed.done();
    failed.refresh();
    assert.match(failed.elements.creditRecheckStatus.textContent, locale === 'en' ? /Reload this page/ : /再読み込み/);
  });
  check('stop message survives later status updates: ' + locale, () => {
    const ui = boot(locale, {...record, videoId: 'sampleVid02'});
    ui.done({stopped: true});
    ui.refresh();
    assert.match(ui.elements.creditRecheckStatus.textContent, locale === 'en' ? /stopped|Stopped/ : /停止しました/);
  });
}
check('release metadata is updated', () => {
  assert.equal(JSON.parse(read('manifest.json')).version, read('CHANGELOG.md').match(/^## v(\d+\.\d+\.\d+)/m)[1]);
  assert.match(read('CHANGELOG.md'), /## v1\.60\.28/);
});
console.log(`${passed} passed`);
