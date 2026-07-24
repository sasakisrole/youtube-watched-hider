// u1ps §7.3 import-mode DB primitives (real code paths):
//   - replaceRecords: ATOMIC (single 2-store tx) delete-snapshot-only + put-new.
//     Final state = the backup's records; a NEW post-snapshot videoId (absent
//     from the snapshot id list) SURVIVES; snapshot-only ids are removed.
//   - mergeLikedData: current-priority "安全に統合" — existing liked kept, only
//     new ids added.
//
// Run: node tests/verify_import_modes.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// Stateful fake IndexedDB with put/delete/get/getAll. Models real ordering:
// tx.oncomplete fires only AFTER all issued get requests have resolved.
function makeFake(watched, liked) {
  const stores = {
    watchedVideos: new Map(watched.map((r) => [r.videoId, r])),
    likedVideos: new Map(liked.map((r) => [r.videoId, r])),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      let outstanding = 0;
      let issued = false;
      function maybeComplete() {
        if (issued && outstanding === 0) setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
      }
      tx.objectStore = (name) => ({
        put: (v) => { stores[name].set(v.videoId, v); },
        delete: (k) => { stores[name].delete(k); },
        get: (k) => {
          outstanding++;
          const req = {};
          setImmediate(() => { req.result = stores[name].get(k); if (req.onsuccess) req.onsuccess(); outstanding--; maybeComplete(); });
          return req;
        },
        getAll: () => { const req = {}; setImmediate(() => { req.result = [...stores[name].values()]; if (req.onsuccess) req.onsuccess(); }); return req; },
      });
      setImmediate(() => { issued = true; maybeComplete(); });
      return tx;
    },
  };
  return {
    idb: { open() { const req = {}; setImmediate(() => { req.result = db; if (req.onsuccess) req.onsuccess({ target: req }); }); return req; } },
    stores,
  };
}

function loadWatchedDb(idb) {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  return new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(idb, {});
}

async function testReplace() {
  // Current: w1,w2,w3 + liked l1 were in the pre-replace snapshot; 'w-late' is a
  // NEW videoId written AFTER the snapshot (concurrent 'ended').
  const { idb, stores } = makeFake(
    [{ videoId: 'w1', watchedAt: 1, source: 'self', playCount: 1 },
      { videoId: 'w2', watchedAt: 1, source: 'self' },
      { videoId: 'w3', watchedAt: 1, source: 'self' },
      { videoId: 'w-late', watchedAt: 1, source: 'self' }],
    [{ videoId: 'l1', accountId: 'A' }],
  );
  const WatchedDB = loadWatchedDb(idb);
  const parsed = WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [{ videoId: 'w1', watchedAt: 99, source: 'self', playCount: 5 }, { videoId: 'w4', watchedAt: 5, source: 'self' }],
    likedVideos: [{ videoId: 'l2', accountId: 'B' }],
  });
  const snapshotWatchedIds = ['w1', 'w2', 'w3']; // w-late intentionally NOT here
  const snapshotLikedIds = ['l1'];
  const newW = new Set(parsed.watchedVideos.map((r) => r.videoId));
  const newL = new Set(parsed.likedVideos.map((r) => r.videoId));
  const delW = snapshotWatchedIds.filter((id) => !newW.has(id));
  const delL = snapshotLikedIds.filter((id) => !newL.has(id));
  // Real atomic path (what offscreen.replaceApply calls).
  const res = await WatchedDB.replaceRecords(delW, delL, parsed.watchedVideos, parsed.likedVideos);
  check('replaceRecords reports counts', res.deletedWatched === 2 && res.importedWatched === 2 && res.deletedLiked === 1 && res.importedLiked === 1);

  const w = stores.watchedVideos;
  const l = stores.likedVideos;
  check('replace: snapshot-only w2/w3 removed', !w.has('w2') && !w.has('w3'));
  check('replace: overlap w1 overwritten by backup (playCount 5)', w.has('w1') && w.get('w1').playCount === 5);
  check('replace: backup-only w4 added', w.has('w4'));
  check('replace: NEW post-snapshot id w-late SURVIVES', w.has('w-late'));
  check('replace: final watched = new ∪ survivors', w.size === 3);
  check('replace: snapshot-only liked l1 removed, backup l2 added', !l.has('l1') && l.has('l2') && l.size === 1);
}

async function testMergeLiked() {
  const { idb, stores } = makeFake([], [{ videoId: 'l1', accountId: 'A', title: 'keep-me' }]);
  const WatchedDB = loadWatchedDb(idb);
  // l1 already exists (should be KEPT untouched), l2 is new (should be ADDED).
  const res = await WatchedDB.mergeLikedData([
    { videoId: 'l1', accountId: 'B', title: 'overwrite-attempt' },
    { videoId: 'l2', accountId: 'B' },
  ]);
  check('mergeLiked: added=1 (only l2)', res.added === 1);
  check('mergeLiked: skipped=1 (l1 exists)', res.skipped === 1);
  check('mergeLiked: existing l1 KEPT (current wins, title unchanged)', stores.likedVideos.get('l1').title === 'keep-me');
  check('mergeLiked: new l2 added', stores.likedVideos.has('l2'));

  // Dedupe: a duplicate new id in the backup must not over-count `added`.
  const { idb: idb2, stores: stores2 } = makeFake([], []);
  const WatchedDB2 = loadWatchedDb(idb2);
  const dup = await WatchedDB2.mergeLikedData([{ videoId: 'x' }, { videoId: 'x' }, { videoId: 'y' }]);
  check('mergeLiked: duplicate backup ids deduped (added=2)', dup.added === 2 && dup.total === 2);
  check('mergeLiked: dedupe final store has 2', stores2.likedVideos.size === 2);
}

function testLikedMetaStructural() {
  const WatchedDB = loadWatchedDb({});
  const parse = (likedSyncMeta, include = true) => WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [],
    ...(include ? { likedSyncMeta } : {}),
  });

  check('liked meta structural: string flagged', parse('corrupt').likedMetaStructuralError === true);
  check('liked meta structural: array flagged', parse([1, 2]).likedMetaStructuralError === true);
  check('liked meta structural: number flagged', parse(42).likedMetaStructuralError === true);
  check('liked meta structural: boolean flagged', parse(true).likedMetaStructuralError === true);

  const valid = parse({ accountId: 'UCabc', ownerName: 'X' });
  check('liked meta structural: valid object not flagged', valid.likedMetaStructuralError === false);
  check('liked meta structural: null and absent not flagged',
    parse(null).likedMetaStructuralError === false && parse(undefined, false).likedMetaStructuralError === false);
  check('liked meta structural: empty object not flagged when sanitized to null',
    parse({}).likedMetaStructuralError === false && parse({}).likedSyncMeta === null);

  const invalidDiff = WatchedDB.diffImport(parse('corrupt'), [], []);
  const validDiff = WatchedDB.diffImport(valid, [], []);
  check('liked meta structural: diff exposes invalid flag', invalidDiff.invalid.likedMetaStructural === true);
  check('liked meta structural: diff keeps valid flag false', validDiff.invalid.likedMetaStructural === false);

  const offscreenSource = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  check('liked meta structural: offscreen keeps both dropped paths wired',
    (offscreenSource.match(/likedMetaStructural/g) || []).length >= 2);
  check('liked meta structural: popup warning stays wired', popupSource.includes('likedMetaStructural'));
}

async function main() {
  await testReplace();
  await testMergeLiked();
  testLikedMetaStructural();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
