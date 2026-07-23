// DATA LAYER Commit A: manual credit roles, per-role provenance, CAS, and backup paths.
// Run: node tests/verify_manual_credits.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CT = require(path.join(ROOT, 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const clone = (value) => value == null ? value : structuredClone(value);
const roleState = (record, role) => ({
  value: record[role],
  source: CT.effectiveRoleSource(record, role),
});

// Stateful fake IndexedDB. Each audit row represents exactly one transaction,
// allowing the CAS test to prove its get and put share one readwrite transaction.
function makeFake(watched = [], liked = []) {
  const stores = {
    watchedVideos: new Map(watched.map((r) => [r.videoId, clone(r)])),
    likedVideos: new Map(liked.map((r) => [r.videoId, clone(r)])),
  };
  const audit = [];
  let nextTxId = 1;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(names, mode) {
      const tx = {};
      const entry = { id: nextTxId++, mode, gets: [], puts: [], deletes: [] };
      audit.push(entry);
      let outstanding = 0;
      let issued = false;
      function maybeComplete() {
        if (issued && outstanding === 0) {
          setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
        }
      }
      tx.objectStore = (name) => ({
        get(key) {
          entry.gets.push({ store: name, key });
          outstanding++;
          const req = {};
          setImmediate(() => {
            req.result = clone(stores[name].get(key));
            if (req.onsuccess) req.onsuccess();
            outstanding--;
            maybeComplete();
          });
          return req;
        },
        getAll() {
          outstanding++;
          const req = {};
          setImmediate(() => {
            req.result = [...stores[name].values()].map(clone);
            if (req.onsuccess) req.onsuccess();
            outstanding--;
            maybeComplete();
          });
          return req;
        },
        put(value) {
          entry.puts.push({ store: name, key: value.videoId });
          stores[name].set(value.videoId, clone(value));
        },
        delete(key) {
          entry.deletes.push({ store: name, key });
          stores[name].delete(key);
        },
      });
      setImmediate(() => { issued = true; maybeComplete(); });
      return tx;
    },
  };
  return {
    idb: {
      open() {
        const req = {};
        setImmediate(() => {
          req.result = db;
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
    },
    stores,
    audit,
  };
}

function loadWatchedDb(idb) {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  return new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(idb, { CreditTarget: CT });
}

function baseRecord(videoId, extra = {}) {
  return {
    videoId,
    title: videoId,
    watchedAt: 100,
    firstWatchedAt: 100,
    playCount: 1,
    source: 'self',
    durationSec: null,
    composer: '',
    lyricist: '',
    arranger: '',
    creditsCheckedAt: 777,
    creditsSource: '',
    ...extra,
  };
}

async function testSharedApi() {
  check('shared API: blank and whitespace roles are reported missing',
    JSON.stringify(CT.getMissingCreditRoles({ composer: 'A', lyricist: '  ', arranger: null }))
      === JSON.stringify(['lyricist', 'arranger']));
  const partial = { creditsSource: 'topic', creditRoleSources: { composer: 'manual' } };
  check('shared API: own role source wins', CT.effectiveRoleSource(partial, 'composer') === 'manual');
  check('shared API: partial map falls back to flat source', CT.effectiveRoleSource(partial, 'lyricist') === 'topic');
  check('shared API: unknown per-role source falls back to flat source',
    CT.effectiveRoleSource({ creditsSource: 'general', creditRoleSources: { composer: 'bogus' } }, 'composer') === 'general');
}

async function testManualMutationsAndUndo() {
  const initial = baseRecord('manual', { creditsSource: 'topic' });
  const env = makeFake([
    initial,
    baseRecord('own-source', { creditsSource: 'general', creditRoleSources: { composer: 'topic' } }),
  ]);
  const db = loadWatchedDb(env.idb);

  const saved = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: 'Alice', expectedCurrent: '  ', expectedSource: 'topic',
  });
  let record = env.stores.watchedVideos.get('manual');
  check('manual save: blank role gets value and manual source',
    saved.updated === true && record.composer === 'Alice' && record.creditRoleSources.composer === 'manual');
  check('manual save: creditsCheckedAt is unchanged', record.creditsCheckedAt === 777);
  check('manual save: previous/post capture source presence and states',
    saved.previous.sourcePresent === false && saved.previous.source === 'topic'
      && saved.post.value === 'Alice' && saved.post.source === 'manual');

  const undoInput = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: saved.previous.value,
    expectedCurrent: saved.post.value, expectedSource: saved.post.source,
    restoreRoleSource: saved.previous.sourcePresent ? saved.previous.source : null,
  });
  record = env.stores.watchedVideos.get('manual');
  check('undo input: post-save expected restores blank value and prior source',
    undoInput.updated === true && CT.creditIsBlank(record.composer)
      && CT.effectiveRoleSource(record, 'composer') === 'topic'
      && !(record.creditRoleSources && 'composer' in record.creditRoleSources));

  const ownSaved = await db.setManualCreditRole({
    videoId: 'own-source', role: 'composer', value: 'Own Source Artist',
    expectedCurrent: '', expectedSource: 'topic',
  });
  check('manual save: previous sourcePresent is true when the role had its own key',
    ownSaved.updated === true && ownSaved.previous.sourcePresent === true && ownSaved.previous.source === 'topic');
  const ownUndo = await db.setManualCreditRole({
    videoId: 'own-source', role: 'composer', value: ownSaved.previous.value,
    expectedCurrent: ownSaved.post.value, expectedSource: ownSaved.post.source,
    restoreRoleSource: ownSaved.previous.sourcePresent ? ownSaved.previous.source : null,
  });
  const ownRecord = env.stores.watchedVideos.get('own-source');
  check('undo input: blank value, own source key, and effective source restore exactly',
    ownUndo.updated === true && CT.creditIsBlank(ownRecord.composer)
      && ownRecord.creditRoleSources.composer === 'topic'
      && CT.effectiveRoleSource(ownRecord, 'composer') === 'topic');

  const seeded = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: 'Old Name', expectedCurrent: '', expectedSource: 'topic',
  });
  const corrected = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: 'New Name',
    expectedCurrent: seeded.post.value, expectedSource: seeded.post.source,
  });
  check('manual correction: allowed and previous manual state returned',
    corrected.updated === true && corrected.previous.value === 'Old Name' && corrected.previous.source === 'manual');
  const undoCorrection = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: corrected.previous.value,
    expectedCurrent: corrected.post.value, expectedSource: corrected.post.source,
    restoreRoleSource: corrected.previous.sourcePresent ? corrected.previous.source : null,
  });
  record = env.stores.watchedVideos.get('manual');
  check('undo correction: prior value and manual source restored together',
    undoCorrection.updated === true && record.composer === 'Old Name'
      && record.creditRoleSources.composer === 'manual');

  const cancelled = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: ' ', expectedCurrent: 'Old Name', expectedSource: 'manual',
  });
  record = env.stores.watchedVideos.get('manual');
  check('manual cancel: value blanked and role source removed',
    cancelled.updated === true && CT.creditIsBlank(record.composer)
      && !(record.creditRoleSources && 'composer' in record.creditRoleSources));
  const undoCancel = await db.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: cancelled.previous.value,
    expectedCurrent: cancelled.post.value, expectedSource: cancelled.post.source,
    restoreRoleSource: cancelled.previous.sourcePresent ? cancelled.previous.source : null,
  });
  record = env.stores.watchedVideos.get('manual');
  check('undo cancel: cancelled manual value/source restored together',
    undoCancel.updated === true && record.composer === 'Old Name'
      && record.creditRoleSources.composer === 'manual');
}

async function testGuardsAndTransaction() {
  const env = makeFake([
    baseRecord('auto', { composer: 'Auto Composer', creditsSource: 'topic', creditRoleSources: { composer: 'topic' } }),
    baseRecord('stale', { creditsSource: 'general' }),
  ]);
  const db = loadWatchedDb(env.idb);
  const autoReject = await db.setManualCreditRole({
    videoId: 'auto', role: 'composer', value: 'Manual Attempt',
    expectedCurrent: 'Auto Composer', expectedSource: 'topic',
  });
  check('guard: auto value cannot be overwritten manually',
    autoReject.error === 'not_manual' && autoReject.updated !== true
      && env.stores.watchedVideos.get('auto').composer === 'Auto Composer');
  const autoCancel = await db.setManualCreditRole({
    videoId: 'auto', role: 'composer', value: '', expectedCurrent: 'Auto Composer', expectedSource: 'topic',
  });
  check('guard: auto value cannot be cancelled',
    autoCancel.error === 'not_manual' && autoCancel.updated !== true);
  const invalid = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: 'Copyright Control', expectedCurrent: '', expectedSource: 'general',
  });
  check('guard: invalid non-empty value is not success and not written',
    invalid.error === 'invalid_value' && !invalid.updated && !env.stores.watchedVideos.get('stale').lyricist);
  const nonString = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: [], expectedCurrent: '', expectedSource: 'general',
  });
  check('guard: non-string value is invalid, not a blank cancellation', nonString.error === 'invalid_value');
  const badRole = await db.setManualCreditRole({ videoId: 'stale', role: 'producer', value: 'A' });
  check('guard: non-whitelisted role rejected without success',
    badRole.error === 'bad_role' && badRole.updated !== true);
  const notFound = await db.setManualCreditRole({
    videoId: 'missing', role: 'composer', value: 'Missing Artist', expectedCurrent: '', expectedSource: '',
  });
  check('guard: missing record returns not_found without success',
    notFound.error === 'not_found' && notFound.updated !== true);
  const invalidRestore = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: 'Restore Artist', expectedCurrent: '', expectedSource: 'general',
    restoreRoleSource: 'bogus',
  });
  check('guard: invalid restoreRoleSource is invalid_value and not written',
    invalidRestore.error === 'invalid_value' && invalidRestore.updated !== true && !env.stores.watchedVideos.get('stale').lyricist);
  const foreignRestore = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: 'Foreign Restore', expectedCurrent: '', expectedSource: 'general',
    restoreRoleSource: 'topic',
  });
  check('guard: restore cannot assign a non-manual source onto a non-manual current role',
    foreignRestore.error === 'not_manual' && foreignRestore.updated !== true
      && !env.stores.watchedVideos.get('stale').lyricist);

  const auditBefore = env.audit.length;
  const first = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: 'First Editor', expectedCurrent: null, expectedSource: 'general',
  });
  const txAudit = env.audit[auditBefore];
  check('CAS: successful read and write use one readwrite transaction',
    first.updated === true && env.audit.length === auditBefore + 1 && txAudit.mode === 'readwrite'
      && txAudit.gets.length === 1 && txAudit.puts.length === 1);
  const stale = await db.setManualCreditRole({
    videoId: 'stale', role: 'lyricist', value: 'Second Editor', expectedCurrent: '', expectedSource: 'general',
  });
  const conflictAudit = env.audit[env.audit.length - 1];
  check('CAS: stale second screen conflicts and cannot last-write-win',
    stale.conflict === true && !stale.updated
      && stale.current.value === 'First Editor' && stale.current.source === 'manual'
      && env.stores.watchedVideos.get('stale').lyricist === 'First Editor');
  check('CAS: conflict transaction performs no put', conflictAudit.gets.length === 1 && conflictAudit.puts.length === 0);
}

async function testBackupPaths() {
  const dirty = baseRecord('dirty', {
    composer: 'A', lyricist: 'B', arranger: 'C', creditsSource: 'general',
    creditRoleSources: { composer: 'manual', lyricist: 'enrich:mb', arranger: 'bogus', producer: 'topic' },
  });
  const old = baseRecord('old', { composer: 'Legacy', creditsSource: 'topic' });
  const malformed = baseRecord('malformed', { creditRoleSources: ['manual'] });
  const env = makeFake();
  const db = loadWatchedDb(env.idb);
  const imported = await db.importData([dirty, old, malformed]);
  const importedDirty = env.stores.watchedVideos.get('dirty');
  check('import normalize: records survive malformed/unknown role-source content', imported === 3 && env.stores.watchedVideos.size === 3);
  check('import normalize: only allowed role/source pairs survive',
    JSON.stringify(importedDirty.creditRoleSources) === JSON.stringify({ composer: 'manual', lyricist: 'enrich:mb' }));
  check('old backup: missing map imports and effective source falls back flat',
    CT.effectiveRoleSource(env.stores.watchedVideos.get('old'), 'composer') === 'topic');
  check('non-object/array map sanitizes without dropping record',
    Object.keys(env.stores.watchedVideos.get('malformed').creditRoleSources).length === 0);

  const exported = await db.exportAll({ source: 'manual' });
  const exportedDirty = exported.watchedVideos.find((r) => r.videoId === 'dirty');
  check('export: raw record carries sanitized creditRoleSources',
    exportedDirty.creditRoleSources.composer === 'manual'
      && exportedDirty.creditRoleSources.lyricist === 'enrich:mb');

  const roundEnv = makeFake();
  const roundDb = loadWatchedDb(roundEnv.idb);
  await roundDb.importData(roundDb.parseImportData(exported).watchedVideos);
  check('export/import roundtrip preserves per-role sources',
    JSON.stringify(roundEnv.stores.watchedVideos.get('dirty').creditRoleSources)
      === JSON.stringify({ composer: 'manual', lyricist: 'enrich:mb' }));

  const mergeEnv = makeFake([baseRecord('merge', {
    composer: 'Current Manual', lyricist: '', arranger: 'Current Auto', creditsSource: 'topic',
    creditRoleSources: { composer: 'manual', arranger: 'topic' },
  })]);
  const mergeDb = loadWatchedDb(mergeEnv.idb);
  await mergeDb.mergeImport([baseRecord('merge', {
    composer: 'Backup Composer', lyricist: 'Backup Lyricist', arranger: 'Backup Arranger',
    creditsSource: 'general', creditRoleSources: { composer: 'general', lyricist: 'enrich:mb', arranger: 'manual', bad: 'manual' },
  })]);
  const merged = mergeEnv.stores.watchedVideos.get('merge');
  check('merge: existing manual value/source are never overwritten',
    merged.composer === 'Current Manual' && merged.creditRoleSources.composer === 'manual');
  check('merge: existing auto value/source are kept as a unit',
    merged.arranger === 'Current Auto' && merged.creditRoleSources.arranger === 'topic');
  check('merge: blank role adopts incoming value/source as a unit',
    merged.lyricist === 'Backup Lyricist' && merged.creditRoleSources.lyricist === 'enrich:mb');

  const replaceEnv = makeFake([baseRecord('gone')]);
  const replaceDb = loadWatchedDb(replaceEnv.idb);
  await replaceDb.replaceRecords(['gone'], [], [dirty], []);
  const replaced = replaceEnv.stores.watchedVideos.get('dirty');
  check('replace: per-role sources preserved and sanitized',
    replaced && JSON.stringify(replaced.creditRoleSources) === JSON.stringify({ composer: 'manual', lyricist: 'enrich:mb' })
      && !replaceEnv.stores.watchedVideos.has('gone'));
}

async function testAutoProvenance() {
  const env = makeFake([baseRecord('mixed', { composer: '', lyricist: '', arranger: 'Existing', creditsCheckedAt: 10 })]);
  const db = loadWatchedDb(env.idb);
  const first = await db.updateCredits('mixed', {
    composer: 'Topic Artist', arranger: 'Must Not Replace', creditsRaw: 'raw-1',
  }, false, 'topic');
  let record = env.stores.watchedVideos.get('mixed');
  check('auto: source map is created only for role actually written',
    first === true && record.creditRoleSources.composer === 'topic'
      && !('arranger' in record.creditRoleSources) && record.arranger === 'Existing');
  const checkedAfterFirst = record.creditsCheckedAt;
  const forced = await db.updateCredits('mixed', {
    composer: 'Force Intruder', creditsRaw: 'raw-2',
  }, true, 'general');
  record = env.stores.watchedVideos.get('mixed');
  check('auto: force refreshes creditsRaw but never overwrites an existing role',
    forced === true && record.creditsRaw === 'raw-2' && record.composer === 'Topic Artist');
  await db.updateCredits('mixed', {
    composer: 'Must Not Replace', lyricist: 'MusicBrainz Writer',
  }, false, 'enrich:mb');
  record = env.stores.watchedVideos.get('mixed');
  check('auto: mixed provenance resolves independently per role',
    record.composer === 'Topic Artist' && CT.effectiveRoleSource(record, 'composer') === 'topic'
      && record.lyricist === 'MusicBrainz Writer' && CT.effectiveRoleSource(record, 'lyricist') === 'enrich:mb');
  check('auto: no source entry is created for role not written',
    !('arranger' in record.creditRoleSources) && !('producer' in record.creditRoleSources));
  check('auto: existing checked-at stamping behavior remains active',
    checkedAfterFirst > 10 && record.creditsCheckedAt >= checkedAfterFirst);
}

async function testOffscreenRoute() {
  const source = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  check('offscreen routes SET_MANUAL_CREDIT_ROLE to dedicated DB mutation',
    source.includes("case 'SET_MANUAL_CREDIT_ROLE':") && source.includes('WatchedDB.setManualCreditRole(args)')
      && source.includes("hasOwnProperty.call(message, 'restoreRoleSource')"));
}

async function main() {
  await testSharedApi();
  await testManualMutationsAndUndo();
  await testGuardsAndTransaction();
  await testBackupPaths();
  await testAutoProvenance();
  await testOffscreenRoute();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });

