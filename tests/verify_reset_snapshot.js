// u1ps §7.4 (Codex B1 VERIFY): freeze-free full-reset uses delete-by-snapshot-ids.
// Locks the core safety property: deleteManyRecords deletes ONLY the ids captured
// in the pre-reset backup snapshot, so a record written AFTER the snapshot (absent
// from the id list) SURVIVES instead of being deleted-without-backup.
//
// Run: node tests/verify_reset_snapshot.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// Stateful fake IndexedDB backing WatchedDB.deleteManyRecords. Supports the
// exact surface db.js touches: open -> db.transaction([stores],'readwrite') ->
// objectStore(name).delete(key), resolving on tx.oncomplete.
function makeStatefulIdb(watched, liked) {
  const stores = {
    watchedVideos: new Map(watched.map((r) => [r.videoId, r])),
    likedVideos: new Map(liked.map((r) => [r.videoId, r])),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      tx.objectStore = (name) => ({
        delete: (key) => { stores[name].delete(key); },
      });
      setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
      return tx;
    },
    _stores: stores,
  };
  return {
    idb: {
      open() {
        const req = {};
        setImmediate(() => { req.result = db; if (req.onsuccess) req.onsuccess({ target: req }); });
        return req;
      },
    },
    stores,
  };
}

function loadWatchedDb(idb) {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  return new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(idb, {});
}

async function main() {
  // Snapshot captured 2 watched + 1 liked. AFTER the snapshot, a new watched
  // ('w-new') and a new liked ('l-new') were written (simulating a concurrent
  // 'ended' record / sync during the backup download window).
  const { idb, stores } = makeStatefulIdb(
    [{ videoId: 'w1' }, { videoId: 'w2' }, { videoId: 'w-new' }],
    [{ videoId: 'l1' }, { videoId: 'l-new' }],
  );
  const WatchedDB = loadWatchedDb(idb);

  const res = await WatchedDB.deleteManyRecords(['w1', 'w2'], ['l1']);
  check('reports deleted counts', res && res.watched === 2 && res.liked === 1);
  check('snapshot watched ids deleted', !stores.watchedVideos.has('w1') && !stores.watchedVideos.has('w2'));
  check('snapshot liked id deleted', !stores.likedVideos.has('l1'));
  // The safety property: post-snapshot writes survive.
  check('post-snapshot watched SURVIVES (not lost)', stores.watchedVideos.has('w-new'));
  check('post-snapshot liked SURVIVES (not lost)', stores.likedVideos.has('l-new'));

  // Empty lists => no-op (truly-empty DB reset path).
  const { idb: idb2, stores: stores2 } = makeStatefulIdb([{ videoId: 'a' }], []);
  const WatchedDB2 = loadWatchedDb(idb2);
  const res2 = await WatchedDB2.deleteManyRecords([], []);
  check('empty id lists are a no-op', res2.watched === 0 && res2.liked === 0 && stores2.watchedVideos.has('a'));

  // Non-array args are tolerated as empty (defensive).
  const { idb: idb3, stores: stores3 } = makeStatefulIdb([{ videoId: 'b' }], []);
  const WatchedDB3 = loadWatchedDb(idb3);
  await WatchedDB3.deleteManyRecords(null, undefined);
  check('non-array args tolerated (no throw, no delete)', stores3.watchedVideos.has('b'));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
