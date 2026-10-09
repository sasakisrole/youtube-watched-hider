// Recheck stamps: a successfully rechecked video stays checked across page
// reloads until its credits or the parser revision change.
// Run: node tests/verify_credit_recheck_stamp.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CM = require(path.join(ROOT, 'credit_corrections.js'));
const CT = require(path.join(ROOT, 'credit_target.js'));
const DB_SOURCE = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

function fakeDb(records) {
  const store = new Map(records.map((record) => [record.videoId, structuredClone(record)]));
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {}; let pending = 0; let issued = false;
      const complete = () => { if (issued && pending === 0) setImmediate(() => tx.oncomplete && tx.oncomplete()); };
      tx.objectStore = () => ({
        get(key) {
          const request = {}; pending++;
          setImmediate(() => {
            request.result = structuredClone(store.get(key));
            if (request.onsuccess) request.onsuccess();
            pending--; complete();
          });
          return request;
        },
        put(value) { store.set(value.videoId, structuredClone(value)); },
      });
      setImmediate(() => { issued = true; complete(); });
      return tx;
    },
  };
  const indexedDB = { open() {
    const request = {};
    setImmediate(() => { request.result = db; if (request.onsuccess) request.onsuccess({ target: request }); });
    return request;
  } };
  const api = new Function('indexedDB', 'globalThis', `${DB_SOURCE}\nreturn WatchedDB;`)(indexedDB, { CreditTarget: CT });
  return { api, store };
}

const base = { videoId: 'stampVid001', title: 'Song (Someone Remix)', channel: 'Example', composer: 'Alice', creditsSource: 'general' };

async function main() {
  await check('a stamped video is not a target until its credits change', () => {
    const stamped = { ...base, creditsRecheck: CM.recheckStamp(base) };
    assert.equal(CM.targets([stamped], 'remix', new Set(), 50, CT).length, 0);
    assert.equal(CM.targets([{ ...stamped, composer: 'Bob' }], 'remix', new Set(), 50, CT).length, 1);
    assert.equal(CM.targets([stamped], 'remix', new Set(), 50, CT, true).length, 1, 'recheck-all includes stamped videos');
  });
  await check('the stamp carries the parser revision', () => {
    assert.match(CM.recheckStamp(base), new RegExp('^' + CM.PARSER_REVISION + ':[0-9a-f]+$'));
    assert.notEqual(CM.recheckStamp(base), CM.recheckStamp({ ...base, lyricist: 'Carol' }));
    const stale = { ...base, creditsRecheck: '2000-01-01:' + CM.recheckStamp(base).split(':')[1] };
    assert.equal(CM.targets([stale], 'remix', new Set(), 50, CT).length, 1, 'an older revision expires');
  });
  await check('the database stores a valid stamp and refuses malformed ones', async () => {
    const { api, store } = fakeDb([base]);
    assert.equal(await api.markCreditsRechecked(base.videoId, CM.recheckStamp(base)), true);
    assert.equal(store.get(base.videoId).creditsRecheck, CM.recheckStamp(base));
    assert.equal(store.get(base.videoId).composer, 'Alice', 'other fields are untouched');
    assert.equal(await api.markCreditsRechecked(base.videoId, ''), false);
    assert.equal(await api.markCreditsRechecked(base.videoId, 'x'.repeat(101)), false);
    assert.equal(await api.markCreditsRechecked('missingVid01', CM.recheckStamp(base)), false);
  });
  await check('a restored backup keeps the stamp', async () => {
    const { api, store } = fakeDb([]);
    const stamp = CM.recheckStamp(base);
    await api.importData([{ ...base, watchedAt: 1, source: 'self', creditsRecheck: stamp },
      { ...base, videoId: 'stampVid002', watchedAt: 1, source: 'self', creditsRecheck: 'x'.repeat(101) }]);
    assert.equal(store.get(base.videoId).creditsRecheck, stamp);
    assert.equal('creditsRecheck' in store.get('stampVid002'), false);
  });
  console.log(`RESULT: ${passed} passed / ${failed} failed / 0 skipped`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
