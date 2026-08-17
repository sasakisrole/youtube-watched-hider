// u1ps §7.1 (Option A): likedSyncMeta lossless FLAT roundtrip verification.
//
// Locks the correctness fix: export -> import(parse) must preserve the RUNTIME
// FLAT likedSyncMeta shape (accountId/ownerName/lastSyncedAt/partial/
// identityConfidence/unknownConfirmedAt) so the account-change / 誤同期防止 guard
// (background.js reads meta.accountId flat) and the analyzer meta row keep
// working after a restore.
//
// RED on the old impl: the previous export/import normalized to an accounts-map
// ({schemaVersion:2, lastAccountId, accounts:{}}) which has NO top-level
// accountId and DROPS identityConfidence/partial — every flat-form assertion
// below fails against that shape.
//
// Run: node tests/verify_backup_roundtrip.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// db.js references globalThis.CreditTarget only inside updateCredits (not at
// load or in the pure export/import functions we exercise), and getAppVersion
// safely falls back to 'unknown' when chrome is undefined. So a no-op fake
// indexedDB + empty globalThis is enough to load WatchedDB and call the pure
// wrapExport / exportAll-free / parseImportData helpers.
function loadWatchedDb() {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const noopIndexedDb = { open() { return {}; } };
  return new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(noopIndexedDb, {});
}

const WatchedDB = loadWatchedDb();

// A fully-populated runtime flat likedSyncMeta as background.js persists it.
const runtimeFlat = {
  accountId: 'UCkenrec',
  ownerName: 'Ken',
  ownerHandle: '@kenhandle',
  ownerChannelId: 'UCkenrec',
  identityConfidence: 'browse-recovered',
  unknownConfirmedAt: null,
  lastSyncedAt: 1731000000000,
  count: 42,
  partial: true,
  hasMore: false,
  degraded: false,
  droppedLoose: 3,
  lastError: 'network hiccup',
};

const mbLookup = {
  status: 'not-found',
  checkedAt: 1731000000000,
  nextEligibleAt: 1738776000000,
  queryFingerprint: 'artist\u0000title',
  missingRoles: ['composer', 'arranger'],
  attempts: 0,
};

// --- Export preserves flat shape + all fields ---
const envelope = WatchedDB.wrapExport(
  [{ videoId: 'a', watchedAt: 1, source: 'self', mbLookup }],
  { likedVideos: [{ videoId: 'b', accountId: 'UCkenrec' }], likedSyncMeta: runtimeFlat, source: 'manual' }
);
const em = envelope.likedSyncMeta;
check('export: likedSyncMeta is a flat object (has top-level accountId)', !!em && typeof em.accountId === 'string');
check('export: NOT accounts-map (no .accounts key)', !!em && !('accounts' in em) && !('schemaVersion' in em));
check('export: accountId preserved', em && em.accountId === 'UCkenrec');
check('export: ownerName preserved', em && em.ownerName === 'Ken');
check('export: ownerHandle preserved', em && em.ownerHandle === '@kenhandle');
check('export: lastSyncedAt preserved', em && em.lastSyncedAt === 1731000000000);
check('export: identityConfidence preserved (dropped by old impl)', em && em.identityConfidence === 'browse-recovered');
check('export: partial preserved (dropped by old impl)', em && em.partial === true);
check('export: count preserved', em && em.count === 42);
check('export: lastError preserved', em && em.lastError === 'network hiccup');
check('export: watched mbLookup is preserved by whole-record export',
  JSON.stringify(envelope.watchedVideos[0].mbLookup) === JSON.stringify(mbLookup));

// --- parseImportData roundtrips the flat shape ---
const parsed = WatchedDB.parseImportData(envelope);
const pm = parsed.likedSyncMeta;
check('import: likedSyncMeta flat (top-level accountId accessible)', !!pm && pm.accountId === 'UCkenrec');
check('import: NOT accounts-map', !!pm && !('accounts' in pm));
check('import: identityConfidence survives roundtrip', pm && pm.identityConfidence === 'browse-recovered');
check('import: unknownConfirmedAt null preserved', pm && pm.unknownConfirmedAt === null);
check('import: partial survives roundtrip', pm && pm.partial === true);
check('import: watched records restored', parsed.watchedVideos.length === 1 && parsed.watchedVideos[0].videoId === 'a');
check('import: watched mbLookup survives envelope roundtrip',
  JSON.stringify(parsed.watchedVideos[0].mbLookup) === JSON.stringify(mbLookup));
check('import: liked records restored', parsed.likedVideos.length === 1 && parsed.likedVideos[0].videoId === 'b');

// --- 誤同期防止 guard scenario: after restore, the flat guard still fires ---
// background.js: if (meta && meta.accountId && meta.accountId !== accountId ...)
// A different synced account must be detectable off the restored meta.
function accountChangeDetected(meta, syncAccountId) {
  return !!(meta && meta.accountId && meta.accountId !== syncAccountId);
}
check('guard: detects account change after restore', accountChangeDetected(pm, 'UCotheraccount') === true);
check('guard: no false positive for same account', accountChangeDetected(pm, 'UCkenrec') === false);

// --- unknown-confirmed identity survives (M1 confidence) ---
const unknownFlat = {
  accountId: 'unknown', ownerName: '', ownerHandle: '', ownerChannelId: '',
  identityConfidence: 'unknown-confirmed', unknownConfirmedAt: 1731000000123,
  lastSyncedAt: 1731000000123, count: 5, partial: false,
};
const u = WatchedDB.parseImportData(WatchedDB.wrapExport([], { likedSyncMeta: unknownFlat }));
check('unknown-confirmed: identityConfidence preserved', u.likedSyncMeta && u.likedSyncMeta.identityConfidence === 'unknown-confirmed');
check('unknown-confirmed: unknownConfirmedAt number preserved', u.likedSyncMeta && u.likedSyncMeta.unknownConfirmedAt === 1731000000123);

// --- Backward compat: a pre-u1ps accounts-map backup still imports (-> flat) ---
const legacyAccountsMap = {
  schemaVersion: 2,
  exportedAt: '2026-07-01T00:00:00.000Z',
  watchedVideos: [{ videoId: 'z', watchedAt: 2, source: 'self' }],
  likedVideos: [],
  likedSyncMeta: {
    schemaVersion: 2,
    lastAccountId: 'UClegacy',
    accounts: {
      UClegacy: { accountId: 'UClegacy', ownerName: 'Legacy Ken', ownerHandle: '@legacy', ownerChannelId: 'UClegacy', lastSyncedAt: 1700000000000, count: 7 },
    },
  },
};
const legacy = WatchedDB.parseImportData(legacyAccountsMap);
check('legacy accounts-map: converted to flat accountId', legacy.likedSyncMeta && legacy.likedSyncMeta.accountId === 'UClegacy');
check('legacy accounts-map: ownerName carried over', legacy.likedSyncMeta && legacy.likedSyncMeta.ownerName === 'Legacy Ken');
check('legacy accounts-map: guard works off restored flat meta', accountChangeDetected(legacy.likedSyncMeta, 'UCsomeoneelse') === true);
check('legacy accounts-map: watched restored', legacy.watchedVideos.length === 1 && legacy.watchedVideos[0].videoId === 'z');

// --- Empty / null meta -> null (matches runtime default, no phantom account) ---
const emptyEnv = WatchedDB.wrapExport([], { likedSyncMeta: null });
check('empty: export likedSyncMeta is null', emptyEnv.likedSyncMeta === null);
const emptyAccountsMap = { schemaVersion: 2, watchedVideos: [], likedVideos: [], likedSyncMeta: { schemaVersion: 2, lastAccountId: '', accounts: {} } };
check('empty accounts-map -> null on import', WatchedDB.parseImportData(emptyAccountsMap).likedSyncMeta === null);
check('missing meta -> null on import', WatchedDB.parseImportData({ schemaVersion: 2, watchedVideos: [], likedVideos: [] }).likedSyncMeta === null);

// --- Codex B1 VERIFY minor 2: non-array likedVideos flagged, not silently dropped ---
const structuralEnv = { schemaVersion: 2, watchedVideos: [{ videoId: 'x', watchedAt: 1, source: 'self' }], likedVideos: 'not-an-array' };
const st = WatchedDB.parseImportData(structuralEnv);
check('structural: non-array likedVideos flagged', st.likedStructuralError === true);
check('structural: watched still restored despite bad liked block', st.watchedVideos.length === 1);
check('structural: valid liked array not flagged', WatchedDB.parseImportData({ schemaVersion: 2, watchedVideos: [], likedVideos: [{ videoId: 'k' }] }).likedStructuralError === false);
check('structural: absent likedVideos not flagged', WatchedDB.parseImportData({ schemaVersion: 2, watchedVideos: [] }).likedStructuralError === false);

// --- Codex B1 VERIFY minor 3: pre-destructive backup source is preserved ---
check('export source: pre-reset preserved (not coerced to manual)', WatchedDB.wrapExport([], { source: 'pre-reset' }).source === 'pre-reset');
check('export source: pre-replace preserved', WatchedDB.wrapExport([], { source: 'pre-replace' }).source === 'pre-replace');
check('export source: unknown still coerced to manual', WatchedDB.wrapExport([], { source: 'bogus' }).source === 'manual');

// --- §7.3: diffImport dry-run counts (pure) ---
const diffParsed = {
  watchedVideos: [{ videoId: 'a' }, { videoId: 'b' }, { videoId: 'c' }], // a,b overlap; c new
  likedVideos: [{ videoId: 'L1' }], // L1 new
  droppedWatched: 2, droppedLiked: 1, likedStructuralError: false,
};
const diff = WatchedDB.diffImport(diffParsed, ['a', 'b', 'x', 'y'], ['L9']);
check('diff watched: add (backup-only)', diff.watched.add === 1); // c
check('diff watched: overlap (in both)', diff.watched.overlap === 2); // a,b
check('diff watched: currentOnly (replace deletes)', diff.watched.currentOnly === 2); // x,y
check('diff watched: backup/current totals', diff.watched.backup === 3 && diff.watched.current === 4);
check('diff liked: add', diff.liked.add === 1 && diff.liked.overlap === 0 && diff.liked.currentOnly === 1);
check('diff invalid carried through', diff.invalid.watched === 2 && diff.invalid.liked === 1);
check('diff empty backup vs empty current', (() => { const d = WatchedDB.diffImport({ watchedVideos: [], likedVideos: [] }, [], []); return d.watched.add === 0 && d.watched.currentOnly === 0; })());
check('diff dedupes duplicate backup ids', (() => { const d = WatchedDB.diffImport({ watchedVideos: [{ videoId: 'a' }, { videoId: 'a' }] }, [], []); return d.watched.add === 1 && d.watched.backup === 1; })());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
