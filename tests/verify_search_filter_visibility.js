const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, 'verify_official_search_filter_global_hide.js'), 'utf8');
const helpers = new Function('require', '__dirname', source.slice(0, source.lastIndexOf('async function main()')) +
  '\nreturn { makeRuntime, settings, settle, isShown, panel };')(require, __dirname);
const { makeRuntime, settings, settle, isShown, panel } = helpers;
function storage(value, deferred = false) {
  const store = { officialSearchFilter: settings({ hideOtherGlobal: true }), showSearchFilter: value };
  const listeners = new Set(), pending = [];
  const chrome = { runtime: {}, storage: {
    local: {
      get(key, cb) {
        const result = typeof key === 'string' ? { [key]: store[key] } : { ...store };
        if (deferred) pending.push(() => cb(result)); else cb(result);
      },
      set(values, cb) { Object.assign(store, values); cb(); },
    },
    onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
  } };
  return { chrome, release() { pending.splice(0).forEach(fn => fn()); },
    update(value, area = 'local') {
      store.showSearchFilter = value;
      for (const fn of listeners) fn({ showSearchFilter: { newValue: value } }, area);
    },
  };
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  await test('REQ-5 saved off suppresses panel handle and filtering', async () => {
    const s = storage(false), r = makeRuntime(s);
    try {
      await settle();
      assert.equal(panel(r), null);
      assert(Object.values(r.cards).every(isShown));
      r.document.dispatch('yt-navigate-finish');
      await settle();
      assert.equal(panel(r), null);
      assert(Object.values(r.cards).every(isShown));
    } finally { r.context._ywhOfficialSearchFilter.cleanup(); }
  });
  await test('REQ-5 live off restores results and on restores saved filter in all tabs', async () => {
    const s = storage(true), tabs = [makeRuntime(s), makeRuntime(s)];
    try {
      await settle();
      for (const r of tabs) { assert(panel(r)); assert(!isShown(r.cards.other)); }
      s.update(false, 'sync');
      assert(tabs.every(r => panel(r)));
      s.update(false);
      for (const r of tabs) {
        assert.equal(panel(r), null);
        assert(Object.values(r.cards).every(isShown));
        r.location.pathname = '/@name/videos';
        r.document.dispatch('yt-navigate-finish');
        r.location.pathname = '/results';
        r.document.dispatch('yt-navigate-finish');
      }
      await settle();
      for (const r of tabs) { assert.equal(panel(r), null); assert(Object.values(r.cards).every(isShown)); }
      s.update(true);
      for (const r of tabs) { assert(panel(r)); assert(!isShown(r.cards.other)); }
    } finally { tabs.forEach(r => r.context._ywhOfficialSearchFilter.cleanup()); }
  });
  await test('REQ-5 missing invalid and deleted values default on', async () => {
    for (const value of [undefined, null, 0, 'false', {}, []]) {
      const s = storage(value), r = makeRuntime(s);
      try {
        await settle();
        assert(panel(r));
        s.update(false); assert.equal(panel(r), null);
        s.update(value); assert(panel(r)); assert(!isShown(r.cards.other));
      } finally { r.context._ywhOfficialSearchFilter.cleanup(); }
    }
  });
  await test('REQ-5 pending initial read cannot override newer off event', async () => {
    const s = storage(true, true), r = makeRuntime(s);
    try {
      s.update(false);
      s.release();
      await settle();
      assert.equal(panel(r), null);
      assert(Object.values(r.cards).every(isShown));
    } finally { r.context._ywhOfficialSearchFilter.cleanup(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
