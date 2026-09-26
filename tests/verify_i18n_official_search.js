// Run: node tests/verify_i18n_official_search.js
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const source = read('official_search_filter.js');
const coreSource = read('official_search_filter_core.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const calls = [...(source + coreSource).matchAll(/officialMessage\('([^']+)'/g)];
assert(calls.length > 0, 'official search must use localized display keys');
const slots = s => [...s.matchAll(/\$(\d+)/g)].map(m => Number(m[1])).sort();
for (const [, key] of calls) {
  assert(ja[key] && en[key], `missing ja/en key: ${key}`);
  assert.deepEqual(slots(ja[key].message), slots(en[key].message), key);
}
function fn(name, text = source) {
  const found = text.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`));
  assert(found, name);
  return found[0];
}
async function check(locale) {
  const output = [], nodes = new Map();
  const element = () => ({ dataset: {}, setAttribute() {}, getAttribute() { return 'false'; }, addEventListener(event, handler) { this[event] = handler; }, appendChild() {},
    set textContent(v) { output.push(v); }, get textContent() { return ''; } });
  const panel = { querySelector(s) { if (!nodes.has(s)) nodes.set(s, element()); return nodes.get(s); }, querySelectorAll: () => [] };
  const scope = { console, document: { getElementById: id => id === 'panel' ? panel : panel.querySelector(id), createElement: element },
    getEffectiveProfile: () => ({ displayName: 'Example', id: 'example' }),
    renderManagementState() {}, scanSearchResults() {},
    appendText(parent, tag, cls, text) { output.push(text); },
    requestModeChange(mode) { scope.state.mode = mode; },
    runtimeMessage: async () => { throw new Error('offline'); },
    core: { PREVIEW_CREDITS_MAX_VIDEOS: 20 }, PANEL_ID: 'panel',
    MODE: { ALL: 'all', OFFICIAL: 'official', DISCOVERY: 'discovery' },
    state: { counts: {}, settings: {}, mode: 'all', previewVideoIds: [], previewResults: {}, previewMessage: '', visibleCount: 0 } };
  if (locale !== null) scope.chrome = { i18n: { getMessage(key, values = []) {
    if (locale === 'throws') throw new Error('invalid context');
    if (!locale[key]) return '';
    assert.equal(values.length, Math.max(0, ...slots(locale[key].message)), key);
    assert(values.every(v => typeof v === 'string'));
    return locale[key].message.replace(/\$(\d+)/g, (_, n) => values[n - 1]);
  } } };
  vm.createContext(scope);
  vm.runInContext(['officialMessage', 'officialModeLabel', 'officialPreviewLabel', 'renderPanelState', 'startPreviewCredits', 'cancelPreviewCredits', 'createModeButton', 'setManagementStatus'].map(n => fn(n)).join('\n'), scope);
  if (locale !== en) vm.runInContext(`
    const originalMessage = officialMessage;
    officialMessage = (key, fallback, substitutions) => {
      const result = originalMessage(key, fallback, substitutions);
      if (result !== fallback) throw new Error('Japanese fallback changed: ' + key);
      return result;
    };
  `, scope);
  for (const mode of ['all', 'official', 'discovery']) {
    scope.nextMode = mode;
    vm.runInContext('createModeButton(nextMode, officialModeLabel(nextMode), officialModeLabel(nextMode)).click(); renderPanelState();', scope);
    assert.equal(scope.state.mode, mode);
  }
  // Every fixed literal is checked through the shipped helper, including labels
  // that appear only in the management form.
  for (const match of (source + coreSource).matchAll(/officialMessage\('([^']+)', ('[^'\n]*')\)/g)) {
    const actual = vm.runInContext(match[0], scope);
    if (locale === en) assert(!/[぀-ヿ㐀-鿿]/.test(actual), match[1]);
    else assert.equal(actual, vm.runInContext(match[2], scope), match[1]);
  }
  for (const n of [0, 1, 2, 20]) {
    scope.state.previewVideoIds = Array.from({ length: n }, (_, i) => String(i));
    vm.runInContext('renderPanelState()', scope);
  }
  for (const status of ['complete', 'partial', 'not-found', 'error', 'unknown']) {
    scope.state.previewResults = { sample: { status, credits: { composer: 'Example' }, error: { kind: 'offline' } } };
    vm.runInContext('renderPanelState()', scope);
  }
  await vm.runInContext('startPreviewCredits()', scope);
  vm.runInContext('setManagementStatus(state.previewMessage, true)', scope);
  for (const response of [{ ok: false, reason: 'already-running' }, { ok: false, reason: 'offline' },
    { ok: true, autoStopped: true }, { ok: true, aborted: true }, { ok: true }]) {
    scope.runtimeMessage = async () => response;
    await vm.runInContext('startPreviewCredits()', scope);
    vm.runInContext('renderPanelState()', scope);
  }
  scope.state.previewRunning = true;
  await vm.runInContext('cancelPreviewCredits()', scope);
  scope.state.previewCancelling = false;
  scope.runtimeMessage = async () => { throw new Error('offline'); };
  await vm.runInContext('cancelPreviewCredits()', scope);
  vm.runInContext(coreSource, scope);
  for (const role of ['composer', 'lyricist', 'arranger', 'creditsRaw']) {
    const input = { items: [{ videoId: 'video', channel: { channelId: 'UCExample', canonicalPath: '/@Example', displayName: '日本語名' } }],
      creditsByVideoId: { video: { [role]: '原文' } }, creditAliases: ['原文'] };
    const before = JSON.stringify(input);
    const inferred = scope.YWHOfficialSearchFilterCore.inferCreditChannelCandidates(input);
    assert.equal(JSON.stringify(input), before, 'inference must not translate source data');
    const candidate = inferred.candidates[0];
    assert.equal(candidate.channel.displayName, '日本語名');
    const reason = candidate.reasons[0];
    assert(reason.includes('原文'));
    if (locale === en) {
      assert(!/[぀-ヿ㐀-鿿]/.test(reason.replaceAll('原文', '')));
      assert(reason.includes('matches alias'));
    } else {
      assert(reason.includes('クレジット「原文」が別名「原文」と正規化一致（動画 video）'));
    }
  }
  if (locale === en) {
    for (const text of output) assert(!/[\u3040-\u30ff\u3400-\u9fff]|undefined|\$\d/.test(text), text);
    assert(output.includes('Check credits for other Topic videos: 1'));
    assert(output.includes('Could not check: offline'));
  } else {
    assert(output.includes('他Topic 1件をクレジット確認'));
    assert(output.includes('確認できませんでした: offline'));
    assert(output.includes('公式優先'));
  }
}
(async () => {
  for (const locale of [en, ja, {}, null, 'throws']) await check(locale);
  console.log(`PASS official search i18n: ${new Set(calls.map(m => m[1])).size} keys`);
})().catch(error => { console.error(error); process.exitCode = 1; });
