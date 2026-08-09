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

  // Execute the real popup formatters with the real diff result. These are
  // behavior checks, not source-string assertions.
  const renderStart = popupSource.indexOf('function renderImportDiff');
  const renderEnd = popupSource.indexOf('function formatImportResult', renderStart);
  const renderImportDiff = new Function(
    popupSource.slice(renderStart, renderEnd) + '; return renderImportDiff;'
  )();
  const formatStart = popupSource.indexOf('function formatImportResult');
  const formatEnd = popupSource.indexOf('function formatMergeImportStatus', formatStart);
  const formatImportResult = new Function(
    popupSource.slice(formatStart, formatEnd) + '; return formatImportResult;'
  )();
  const mergeFormatStart = popupSource.indexOf('function formatMergeImportStatus');
  const mergeFormatEnd = popupSource.indexOf('function handleImportResponse', mergeFormatStart);
  const formatMergeImportStatus = new Function(
    popupSource.slice(mergeFormatStart, mergeFormatEnd) + '; return formatMergeImportStatus;'
  )();
  const invalidPreview = renderImportDiff(invalidDiff);
  const invalidApplied = formatImportResult({ count: 1, liked: { imported: 0 }, dropped: { likedMetaStructural: true } }, '安全に統合');
  const invalidLegacy = formatMergeImportStatus({ added: 1, skipped: 0, liked: { imported: 0 }, dropped: { likedMetaStructural: true } });
  check('REQ-1 invalid likedSyncMeta reaches users with explanatory warning',
    invalidPreview.includes('同期アカウント情報の形式が不正')
      && invalidApplied.warning && invalidApplied.text.includes('高評価アカウント情報の形式不正')
      && invalidLegacy.warning && invalidLegacy.text.includes('高評価アカウント情報の形式が不正'));
  const validPreview = renderImportDiff(validDiff);
  const validApplied = formatImportResult({ count: 1, liked: { imported: 0 }, dropped: {} }, '安全に統合');
  const validLegacy = formatMergeImportStatus({ added: 1, skipped: 0, liked: { imported: 0 }, dropped: {} });
  check('REQ-2 valid likedSyncMeta produces no extra warning',
    !validPreview.includes('同期アカウント情報の形式が不正') && !validApplied.warning && !validLegacy.warning);
}

async function testWatchedOptionalFieldTolerance() {
  const badOptional = {
    videoId: 'optional-bad',
    title: 7,
    channel: {},
    source: false,
    composer: [],
    lyricist: 1,
    arranger: {},
    creditsSource: true,
    creditsRaw: [],
    creditsFetchFailReason: 9,
    durationFetchFailed: {},
    category: false,
    watchedAt: Infinity,
    firstWatchedAt: NaN,
    playCount: Infinity,
    durationSec: NaN,
    creditsCheckedAt: Infinity,
    creditsFetchAttemptedAt: NaN,
  };
  const { idb, stores } = makeFake([], []);
  const WatchedDB = loadWatchedDb(idb);
  const parsed = WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [badOptional],
    likedVideos: [],
  });
  check('REQ-1 optional field mismatches are retained by parsing',
    parsed.watchedVideos.length === 1 && parsed.droppedWatched === 0);

  const imported = await WatchedDB.importData(parsed.watchedVideos);
  const normalized = stores.watchedVideos.get('optional-bad');
  check('REQ-1 optional field mismatches are normalized and retained',
    imported === 1
      && normalized
      && normalized.title === ''
      && normalized.channel === ''
      && normalized.source === 'unknown'
      && Number.isFinite(normalized.watchedAt)
      && Number.isFinite(normalized.firstWatchedAt)
      && normalized.playCount === 0
      && normalized.durationSec === null
      && normalized.creditsCheckedAt === 0
      && normalized.creditsFetchAttemptedAt === 0);

  const merged = await WatchedDB.mergeImport([{ ...badOptional, videoId: 'optional-merge' }]);
  check('REQ-1 mergeImport retains optional field mismatches',
    merged.total === 1 && merged.dropped === 0 && stores.watchedVideos.has('optional-merge'));

  const replaced = await WatchedDB.replaceRecords([], [], [{ ...badOptional, videoId: 'optional-replace' }], []);
  check('REQ-1 replaceRecords retains optional field mismatches',
    replaced.importedWatched === 1 && stores.watchedVideos.has('optional-replace'));
}

async function testWatchedRequiredVideoId() {
  const invalid = [null, {}, { videoId: '' }, { videoId: 42 }];
  const { idb } = makeFake([], []);
  const WatchedDB = loadWatchedDb(idb);
  const parsed = WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [...invalid, { videoId: 'valid' }],
    likedVideos: [],
  });
  check('REQ-1 invalid videoId records remain dropped',
    parsed.watchedVideos.length === 1 && parsed.droppedWatched === invalid.length);

  const imported = await WatchedDB.importData(invalid);
  const merged = await WatchedDB.mergeImport(invalid);
  const replaced = await WatchedDB.replaceRecords([], [], invalid, []);
  check('REQ-1 direct callers still reject invalid videoId records',
    imported === 0 && merged.total === 0 && merged.dropped === invalid.length && replaced.importedWatched === 0);
}


async function testLikedOptionalFieldTolerance() {
  const badOptional = {
    videoId: 'liked-optional-bad',
    title: 7,
    channel: {},
    accountId: false,
    likedAt: Infinity,
    syncedAt: NaN,
    playlistIndex: 'first',
  };
  const { idb, stores } = makeFake([], []);
  const WatchedDB = loadWatchedDb(idb);
  const parsed = WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [],
    likedVideos: [badOptional],
  });
  check('REQ-5 liked optional field mismatches are retained by parsing',
    parsed.likedVideos.length === 1 && parsed.droppedLiked === 0);

  const imported = await WatchedDB.importLikedData(parsed.likedVideos);
  const normalized = stores.likedVideos.get('liked-optional-bad');
  check('REQ-5 liked optional fields are coerced during import',
    imported === 1
      && normalized
      && normalized.title === ''
      && normalized.channel === ''
      && normalized.accountId === ''
      && Number.isFinite(normalized.likedAt)
      && Number.isFinite(normalized.syncedAt)
      && normalized.playlistIndex === 0);

  const merged = await WatchedDB.mergeLikedData([{ ...badOptional, videoId: 'liked-optional-merge' }]);
  const replaced = await WatchedDB.replaceRecords([], [], [], [{ ...badOptional, videoId: 'liked-optional-replace' }]);
  check('REQ-5 liked optional mismatches survive merge and replace',
    merged.total === 1
      && stores.likedVideos.has('liked-optional-merge')
      && replaced.importedLiked === 1
      && stores.likedVideos.has('liked-optional-replace'));
}

async function testLikedRequiredVideoId() {
  const invalid = [null, {}, { videoId: '' }, { videoId: 42 }];
  const { idb } = makeFake([], []);
  const WatchedDB = loadWatchedDb(idb);
  const parsed = WatchedDB.parseImportData({
    schemaVersion: 2,
    watchedVideos: [],
    likedVideos: [...invalid, { videoId: 'liked-valid' }],
  });
  check('REQ-6 invalid liked videoId records remain dropped',
    parsed.likedVideos.length === 1 && parsed.droppedLiked === invalid.length);
  const imported = await WatchedDB.importLikedData(invalid);
  const merged = await WatchedDB.mergeLikedData(invalid);
  const replaced = await WatchedDB.replaceRecords([], [], [], invalid);
  check('REQ-6 direct liked paths still reject invalid videoId records',
    imported === 0 && merged.total === 0 && replaced.importedLiked === 0);
}
function testLikedStructuralWarning() {
  const WatchedDB = loadWatchedDb({});
  let parsed = null;
  let threw = false;
  try {
    parsed = WatchedDB.parseImportData({
      schemaVersion: 2,
      watchedVideos: [{ videoId: 'watched-ok' }],
      likedVideos: { broken: true },
    });
  } catch (_) {
    threw = true;
  }
  check('REQ-2 non-array likedVideos warns without throwing',
    !threw
      && parsed.watchedVideos.length === 1
      && parsed.likedVideos.length === 0
      && parsed.likedStructuralError === true
      && parsed.droppedWatched === 0
      && parsed.droppedLiked === 0);

  const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const renderStart = popupSource.indexOf('function renderImportDiff');
  const renderEnd = popupSource.indexOf('function formatImportResult', renderStart);
  const renderSnippet = popupSource.slice(renderStart, renderEnd);
  const renderImportDiff = new Function(renderSnippet + '; return renderImportDiff;')();
  const warning = renderImportDiff(WatchedDB.diffImport(parsed, [], []));
  check('REQ-2 popup renders liked structural warning',
    warning.includes('高評価データの形式が不正'));
}

async function testPartialSuccessDisplay() {
  const offscreenSource = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  const importStart = offscreenSource.indexOf('async function importPayload');
  const importEnd = offscreenSource.indexOf('// u1ps §7.3: read-only dry-run diff', importStart);
  const importSnippet = offscreenSource.slice(importStart, importEnd);
  let watchedCalls = 0;
  const WatchedDB = {
    parseImportData: () => ({
      watchedVideos: [{ videoId: 'watched-ok' }],
      likedVideos: [{ videoId: 'liked-fails' }],
      likedSyncMeta: null,
      droppedWatched: 0,
      droppedLiked: 0,
      likedStructuralError: false,
      likedMetaStructuralError: false,
    }),
    importData: async () => { watchedCalls++; return 1; },
    importLikedData: async () => { throw new Error('liked write failed'); },
  };
  const importPayload = new Function('WatchedDB', importSnippet + '; return importPayload;')(WatchedDB);
  const response = await importPayload({ data: {} }, false);
  check('REQ-3 liked failure returns partial success after watched import',
    watchedCalls === 1
      && response.count === 1
      && response.partialSuccess === true
      && response.liked.failed === true
      && response.liked.error === 'liked write failed');

  const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const formatStart = popupSource.indexOf('function formatImportResult');
  const formatEnd = popupSource.indexOf('function handleImportResponse', formatStart);
  const formatSnippet = popupSource.slice(formatStart, formatEnd);
  const formatImportResult = new Function(formatSnippet + '; return formatImportResult;')();
  const rendered = formatImportResult({ ...response, success: true }, 'バックアップ優先で統合');
  check('REQ-3 popup renders partial success warning',
    rendered.warning === true
      && rendered.text.includes('一部成功')
      && rendered.text.includes('高評価の復元に失敗')
      && rendered.text.includes('1 records'));

  const formatMergeImportStatus = new Function(formatSnippet + '; return formatMergeImportStatus;')();
  const legacyRendered = formatMergeImportStatus({ ...response, success: true, added: 1, skipped: 0 });
  check('REQ-3 legacy merge result identifies watched success and liked failure',
    legacyRendered.warning === true
      && legacyRendered.text.includes('一部成功')
      && legacyRendered.text.includes('視聴履歴 +1 new')
      && legacyRendered.text.includes('高評価の復元に失敗'));

  const successfulDb = {
    ...WatchedDB,
    importLikedData: async () => 1,
  };
  const successfulImportPayload = new Function(
    'WatchedDB', importSnippet + '; return importPayload;'
  )(successfulDb);
  const successfulResponse = await successfulImportPayload({ data: {} }, false);
  const successfulRendered = formatImportResult({ ...successfulResponse, success: true }, 'バックアップ優先で統合');
  const successfulLegacy = formatMergeImportStatus({ ...successfulResponse, success: true, added: 1, skipped: 0 });
  check('REQ-4 complete success is not reported as partial',
    successfulResponse.partialSuccess === false
      && successfulResponse.liked.failed === false
      && successfulRendered.warning === false
      && successfulLegacy.warning === false
      && !successfulRendered.text.includes('一部成功')
      && !successfulLegacy.text.includes('一部成功'));

  const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  check('REQ-3 failed liked import does not store liked metadata',
    (backgroundSource.match(/if \(!\(result\.liked && result\.liked\.failed\)\)/g) || []).length === 2);
}

async function main() {
  await testReplace();
  await testMergeLiked();
  testLikedMetaStructural();
  await testWatchedOptionalFieldTolerance();
  await testWatchedRequiredVideoId();
  await testLikedOptionalFieldTolerance();
  await testLikedRequiredVideoId();
  testLikedStructuralWarning();
  await testPartialSuccessDisplay();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
