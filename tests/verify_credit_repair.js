// Regression verification for iv0b v2 stored credit repair and restore.
// Run: node tests/verify_credit_repair.js
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
const mapSnapshot = (map) => JSON.stringify([...map.entries()]);

// Stateful fake IndexedDB with transaction-local staging. Readwrite changes are
// committed only by oncomplete, so every injected abort proves rollback rather
// than merely proving that the returned promise rejected.
function makeFake(watched = [], liked = [], options = {}) {
  const stores = {
    watchedVideos: new Map(watched.map((record) => [record.videoId, clone(record)])),
    likedVideos: new Map(liked.map((record) => [record.videoId, clone(record)])),
  };
  const audit = [];
  let nextTxId = 1;
  let updateCalls = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(names, mode) {
      const tx = {};
      const storeNames = Array.isArray(names) ? names.slice() : [names];
      const entry = {
        id: nextTxId++, mode, stores: storeNames.slice(), gets: [], puts: [], deletes: [],
        aborted: false, abortHandled: false,
      };
      audit.push(entry);
      const staged = Object.fromEntries(storeNames.map((name) => [
        name,
        new Map([...stores[name].entries()].map(([key, value]) => [key, clone(value)])),
      ]));
      let outstanding = 0;
      let issued = false;
      let aborted = false;
      let completed = false;
      let completionQueued = false;

      function invoke(handler, event) {
        if (!handler || aborted || completed) return;
        try {
          handler(event);
        } catch (error) {
          abortTransaction(error, false);
        }
      }

      function abortTransaction(error, fireError) {
        if (aborted || completed) return;
        aborted = true;
        entry.aborted = true;
        entry.error = error && error.message ? error.message : String(error);
        if (fireError && tx.onerror) tx.onerror({ target: { error } });
        setImmediate(() => {
          entry.abortHandled = typeof tx.onabort === 'function';
          if (tx.onabort) tx.onabort({ target: { error } });
        });
      }

      function commit() {
        if (mode !== 'readwrite') return;
        for (const name of storeNames) {
          stores[name].clear();
          for (const [key, value] of staged[name]) stores[name].set(key, clone(value));
        }
      }

      function maybeComplete() {
        if (!issued || outstanding !== 0 || aborted || completed || completionQueued) return;
        completionQueued = true;
        setImmediate(() => {
          completionQueued = false;
          if (aborted || completed || outstanding !== 0) return;
          if ((options.abortTransactions || []).includes(entry.id)) {
            abortTransaction(new Error('injected tx.onabort'), false);
            return;
          }
          commit();
          completed = true;
          if (tx.oncomplete) tx.oncomplete();
        });
      }

      tx.objectStore = (name) => ({
        openCursor() {
          outstanding++;
          const req = {};
          const keys = [...staged[name].keys()];
          let index = 0;
          const advance = () => {
            setImmediate(() => {
              if (aborted || completed) return;
              if (index >= keys.length) {
                invoke(req.onsuccess, { target: { result: null } });
                outstanding--;
                maybeComplete();
                return;
              }
              const key = keys[index];
              const cursor = {
                value: clone(staged[name].get(key)),
                update(value) {
                  updateCalls++;
                  entry.puts.push({ store: name, key });
                  outstanding++;
                  const updateReq = {};
                  staged[name].set(key, clone(value));
                  const shouldFail = updateCalls === options.updateFailureAt;
                  setImmediate(() => {
                    if (aborted || completed) return;
                    outstanding--;
                    if (shouldFail) {
                      const error = new Error('injected cursor.update failure');
                      if (updateReq.onerror) invoke(updateReq.onerror, { target: { error } });
                      abortTransaction(error, true);
                      return;
                    }
                    updateReq.result = key;
                    invoke(updateReq.onsuccess, { target: updateReq });
                    maybeComplete();
                  });
                  return updateReq;
                },
                continue() {
                  index++;
                  advance();
                },
              };
              invoke(req.onsuccess, { target: { result: cursor } });
            });
          };
          advance();
          return req;
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

function loadWatchedDb(idb, creditTarget = CT) {
  const source = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  return new Function('indexedDB', 'globalThis', `${source}\nreturn WatchedDB;`)(idb, { CreditTarget: creditTarget });
}

function loadOffscreenHandler(db) {
  const source = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  const chrome = { runtime: { onMessage: { addListener() {} } } };
  return new Function('WatchedDB', 'chrome', `${source}\nreturn handleDbRpc;`)(db, chrome);
}

function record(videoId, extra = {}) {
  return {
    videoId,
    title: `Title ${videoId}`,
    composer: '',
    lyricist: '',
    arranger: '',
    creditsRaw: 'raw evidence',
    creditsCheckedAt: 123456,
    creditsEmptyCount: 2,
    creditsSource: 'general',
    ...extra,
  };
}

async function rejects(promise) {
  try {
    await promise;
    return false;
  } catch (_error) {
    return true;
  }
}

function testPlannerAndManualProtection() {
  const cases = [
    ['URL', { composer: 'https://example.com/credits' }, 'composer'],
    ['60 chars', { lyricist: 'A'.repeat(61) }, 'lyricist'],
    ['rights notice', { arranger: 'Copyright Control' }, 'arranger'],
    ['handle', { composer: '@handle_only' }, 'composer'],
    ['role label', { lyricist: 'Lyrics: Alice' }, 'lyricist'],
    ['symbols', { arranger: '////' }, 'arranger'],
  ];
  for (const [label, values, role] of cases) {
    const planned = CT.planCreditRepair(record(label, values));
    check(`planner rejects ${label}`, planned.length === 1
      && planned[0].role === role && planned[0].before === values[role]);
  }

  const titleEcho = record('echo', { composer: 'Title echo' });
  const echoPlan = CT.planCreditRepair(titleEcho);
  check('planner still rejects a non-manual value identical to the video title',
    echoPlan.length === 1 && echoPlan[0].role === 'composer');

  const manualEcho = record('manual-echo', {
    composer: 'Title manual-echo',
    creditRoleSources: { composer: 'manual' },
  });
  check('[G3] manual-source title echo is excluded from repair',
    CT.planCreditRepair(manualEcho).length === 0);

  const clean = record('clean', {
    composer: 'Alice', lyricist: '  ', arranger: '山田太郎', creditsRaw: 'https://example.com/raw',
  });
  check('planner keeps normal names, blanks, and creditsRaw out of the plan',
    CT.planCreditRepair(clean).length === 0);
  check('planner handles a missing record without inventing repairs', CT.planCreditRepair(null).length === 0);
}

async function testFailSafeRpcDefault() {
  const variants = [
    ['unspecified', {}],
    ['null', { dryRun: null }],
    ['zero', { dryRun: 0 }],
  ];
  let safe = true;
  for (const [_label, payload] of variants) {
    const before = record('unsafe', { composer: 'https://example.com/bad' });
    const env = makeFake([before]);
    const handleDbRpc = loadOffscreenHandler(loadWatchedDb(env.idb));
    const result = await handleDbRpc({ op: 'REPAIR_INVALID_CREDITS', ...payload });
    safe = safe && result.dryRun === true && result.values === 1
      && env.audit[0].mode === 'readonly' && env.audit[0].puts.length === 0
      && mapSnapshot(env.stores.watchedVideos) === mapSnapshot(new Map([[before.videoId, before]]));
  }
  check('[G1] RPC defaults unspecified, null, and zero dryRun to preview without writes', safe);

  // The RPC layer and the DB layer each default to preview. Exercise the DB API
  // directly so removing the DB-layer default cannot hide behind the RPC guard.
  let dbSafe = true;
  for (const [_label, args] of [['no args', undefined], ['empty', {}], ['null', { dryRun: null }]]) {
    const before = record('unsafe-direct', { composer: 'https://example.com/bad' });
    const env = makeFake([before]);
    const db = loadWatchedDb(env.idb);
    const result = await db.repairInvalidCredits(args);
    dbSafe = dbSafe && result.dryRun === true && result.values === 1
      && env.audit[0].mode === 'readonly' && env.audit[0].puts.length === 0
      && mapSnapshot(env.stores.watchedVideos) === mapSnapshot(new Map([[before.videoId, before]]));
  }
  check('[G1] DB API itself defaults a missing dryRun to preview without writes', dbSafe);
}

async function testExpectedValuesGuard() {
  const rows = [
    record('one', { composer: 'https://example.com/one' }),
    record('two', { lyricist: '@bad_two' }),
  ];
  const env = makeFake(rows);
  const handleDbRpc = loadOffscreenHandler(loadWatchedDb(env.idb));
  const before = mapSnapshot(env.stores.watchedVideos);

  const mismatch = await handleDbRpc({
    op: 'REPAIR_INVALID_CREDITS', dryRun: false, expectedValues: 1,
  });
  check('[G2] expectedValues mismatch returns expected and actual with zero writes',
    mismatch.mismatch === true && mismatch.expected === 1 && mismatch.actual === 2
      && env.audit[0].mode === 'readwrite' && env.audit[0].puts.length === 0
      && mapSnapshot(env.stores.watchedVideos) === before);

  const missing = await handleDbRpc({ op: 'REPAIR_INVALID_CREDITS', dryRun: false });
  check('[G2] apply without expectedValues is rejected with expected null and zero writes',
    missing.mismatch === true && missing.expected === null && missing.actual === 2
      && env.audit[1].puts.length === 0 && mapSnapshot(env.stores.watchedVideos) === before);
}

async function testRepairLoopAndAudit() {
  const oldLog = Array.from({ length: 9 }, (_, index) => ({
    v: 1, role: 'composer', before: `old-${index}`, sourceBefore: null,
    at: index + 1, reason: 'invalid-credit-value',
  }));
  const firstBefore = record('first', {
    composer: 'https://example.com/composer',
    lyricist: 'Alice Smith',
    arranger: 'Copyright Control',
    creditRoleSources: { composer: 'topic', lyricist: 'manual', arranger: '' },
    creditsRepairLog: oldLog,
  });
  const secondBefore = record('second', {
    composer: 'Bob Jones', lyricist: '@bad_handle', arranger: '',
    creditRoleSources: { composer: 'topic' },
  });
  const untouchedBefore = record('clean', {
    composer: 'Alice', lyricist: 'Bob', arranger: 'Carol',
    creditRoleSources: { composer: 'manual', lyricist: 'topic', arranger: 'enrich:mb' },
  });
  const env = makeFake([firstBefore, secondBefore, untouchedBefore]);
  const db = loadWatchedDb(env.idb);

  const preview = await db.repairInvalidCredits({ dryRun: true });
  const previewAudit = env.audit[0];
  check('dry-run reports scanned, video, value, and role counts',
    preview.dryRun === true && preview.scanned === 3 && preview.videos === 2 && preview.values === 3
      && preview.byRole.composer === 1 && preview.byRole.lyricist === 1 && preview.byRole.arranger === 1);
  check('dry-run uses readonly and performs zero writes',
    previewAudit.mode === 'readonly' && previewAudit.puts.length === 0);
  check('dry-run leaves stored records byte-for-byte unchanged',
    JSON.stringify(env.stores.watchedVideos.get('first')) === JSON.stringify(firstBefore)
      && JSON.stringify(env.stores.watchedVideos.get('second')) === JSON.stringify(secondBefore));

  const applied = await db.repairInvalidCredits({ dryRun: false, expectedValues: preview.values });
  const applyAudit = env.audit[1];
  const first = env.stores.watchedVideos.get('first');
  const second = env.stores.watchedVideos.get('second');
  const clean = env.stores.watchedVideos.get('clean');
  check('matching expectedValues applies in the counting transaction and writes only affected videos',
    applied.dryRun === false && !applied.mismatch && applied.scanned === 3
      && applied.videos === preview.videos && applied.values === preview.values
      && JSON.stringify(applied.byRole) === JSON.stringify(preview.byRole)
      && applyAudit.mode === 'readwrite' && applyAudit.puts.length === 2);
  check('apply blanks only invalid roles and removes only their role sources',
    first.composer === '' && first.arranger === '' && first.lyricist === 'Alice Smith'
      && JSON.stringify(first.creditRoleSources) === JSON.stringify({ lyricist: 'manual' })
      && second.composer === 'Bob Jones' && second.lyricist === ''
      && JSON.stringify(second.creditRoleSources) === JSON.stringify({ composer: 'topic' }));
  const newFirstLogs = first.creditsRepairLog.filter((entry) => entry.at === applied.at);
  const newSecondLogs = second.creditsRepairLog.filter((entry) => entry.at === applied.at);
  check('apply records sourceBefore and caps the audit log at 10',
    first.creditsRepairLog.length === 10 && newFirstLogs.length === 2 && newSecondLogs.length === 1
      && newFirstLogs.some((entry) => entry.role === 'composer' && entry.before === firstBefore.composer
        && entry.sourceBefore === 'topic' && entry.v === 1 && entry.reason === 'invalid-credit-value')
      && newFirstLogs.some((entry) => entry.role === 'arranger' && entry.sourceBefore === '')
      && newSecondLogs[0].role === 'lyricist' && newSecondLogs[0].sourceBefore === null);
  check('repair leaves creditsRaw and refresh metadata unchanged',
    first.creditsRaw === firstBefore.creditsRaw && second.creditsRaw === secondBefore.creditsRaw
      && clean.creditsRaw === untouchedBefore.creditsRaw
      && first.creditsCheckedAt === firstBefore.creditsCheckedAt
      && first.creditsEmptyCount === firstBefore.creditsEmptyCount
      && first.creditsSource === firstBefore.creditsSource);
  check('unrelated clean record is unchanged', JSON.stringify(clean) === JSON.stringify(untouchedBefore));

  const secondApply = await db.repairInvalidCredits({ dryRun: false, expectedValues: 0 });
  const secondApplyAudit = env.audit[2];
  check('second repair apply is idempotent and performs zero writes',
    secondApply.scanned === 3 && secondApply.videos === 0 && secondApply.values === 0
      && secondApplyAudit.mode === 'readwrite' && secondApplyAudit.puts.length === 0);
}

async function testManualProtectionAtDbBoundary() {
  const manual = record('manual-db', {
    composer: 'Title manual-db',
    creditRoleSources: { composer: 'manual' },
  });
  const env = makeFake([manual]);
  const db = loadWatchedDb(env.idb);
  const result = await db.repairInvalidCredits({ dryRun: false, expectedValues: 0 });
  check('[G3] manual-source title echo survives DB apply with zero writes',
    result.values === 0 && env.audit[0].puts.length === 0
      && JSON.stringify(env.stores.watchedVideos.get('manual-db')) === JSON.stringify(manual));
}

async function testFailureRollback() {
  const rows = [
    record('one', { composer: 'https://example.com/one' }),
    record('two', { composer: 'https://example.com/two' }),
  ];

  const updateEnv = makeFake(rows, [], { updateFailureAt: 2 });
  const updateBefore = mapSnapshot(updateEnv.stores.watchedVideos);
  const updateRejected = await rejects(loadWatchedDb(updateEnv.idb)
    .repairInvalidCredits({ dryRun: false, expectedValues: 2 }));
  await new Promise((resolve) => setImmediate(resolve));
  check('[G4] second cursor.update failure aborts and rolls back the first staged update',
    updateRejected && updateEnv.audit[0].puts.length === 2 && updateEnv.audit[0].aborted
      && updateEnv.audit[0].abortHandled
      && mapSnapshot(updateEnv.stores.watchedVideos) === updateBefore);

  let planned = 0;
  const throwingTarget = {
    ...CT,
    planCreditRepair(value) {
      planned++;
      if (planned === 2) throw new Error('injected scan exception');
      return CT.planCreditRepair(value);
    },
  };
  const scanEnv = makeFake(rows);
  const scanBefore = mapSnapshot(scanEnv.stores.watchedVideos);
  const scanRejected = await rejects(loadWatchedDb(scanEnv.idb, throwingTarget)
    .repairInvalidCredits({ dryRun: false, expectedValues: 2 }));
  check('[G4] exception during scan triggers tx.onabort with no partial apply',
    scanRejected && scanEnv.audit[0].puts.length === 0 && scanEnv.audit[0].aborted
      && scanEnv.audit[0].abortHandled && mapSnapshot(scanEnv.stores.watchedVideos) === scanBefore);

  const abortEnv = makeFake(rows, [], { abortTransactions: [1] });
  const abortBefore = mapSnapshot(abortEnv.stores.watchedVideos);
  const abortRejected = await rejects(loadWatchedDb(abortEnv.idb)
    .repairInvalidCredits({ dryRun: false, expectedValues: 2 }));
  check('[G4] injected tx.onabort discards every staged update',
    abortRejected && abortEnv.audit[0].puts.length === 2 && abortEnv.audit[0].aborted
      && abortEnv.audit[0].abortHandled && mapSnapshot(abortEnv.stores.watchedVideos) === abortBefore);
}

async function testLikedStoreIsolation() {
  const liked = [{ videoId: 'liked-sentinel', accountId: 'acct', marker: 'must-survive' }];
  const env = makeFake([record('repair-me', { composer: 'https://example.com/bad' })], liked);
  const db = loadWatchedDb(env.idb);
  const likedBefore = mapSnapshot(env.stores.likedVideos);
  const preview = await db.repairInvalidCredits({ dryRun: true });
  await db.repairInvalidCredits({ dryRun: false, expectedValues: preview.values });
  const restorePreview = await db.restoreRepairedCredits({ dryRun: true });
  await db.restoreRepairedCredits({ dryRun: false, expectedValues: restorePreview.values });
  check('[G5] likedVideos sentinel is unchanged across repair and restore',
    mapSnapshot(env.stores.likedVideos) === likedBefore
      && env.audit.every((entry) => JSON.stringify(entry.stores) === JSON.stringify(['watchedVideos'])));
}

async function testRestoreContract() {
  const at = 500;
  const restorable = record('restorable', {
    creditRoleSources: { keeper: 'general' },
    creditsRepairLog: [
      { v: 1, role: 'composer', before: 'Old Composer', sourceBefore: 'topic', at, reason: 'invalid-credit-value' },
      { v: 1, role: 'lyricist', before: 'Old Lyricist', sourceBefore: '', at, reason: 'invalid-credit-value' },
      { v: 1, role: 'arranger', before: 'Old Arranger', sourceBefore: null, at, reason: 'invalid-credit-value' },
    ],
  });
  const occupied = record('occupied', {
    composer: 'Correct External Value',
    creditsRepairLog: [
      { v: 1, role: 'composer', before: 'Old Bad Value', sourceBefore: 'general', at, reason: 'invalid-credit-value' },
    ],
  });
  const env = makeFake([restorable, occupied]);
  const db = loadWatchedDb(env.idb);

  const preview = await db.restoreRepairedCredits({ dryRun: true });
  check('[G6] restore preview counts blank roles and reports occupied roles as skipped',
    preview.dryRun && preview.scanned === 2 && preview.videos === 1 && preview.values === 3
      && preview.skipped === 1 && preview.byRole.composer === 1
      && preview.byRole.lyricist === 1 && preview.byRole.arranger === 1
      && env.audit[0].puts.length === 0);

  const applied = await db.restoreRepairedCredits({ dryRun: false, expectedValues: preview.values });
  const restored = env.stores.watchedVideos.get('restorable');
  const skipped = env.stores.watchedVideos.get('occupied');
  check('[G6] restore fills only blank roles and recreates sourceBefore including empty vs absent',
    applied.values === 3 && applied.skipped === 1
      && restored.composer === 'Old Composer' && restored.lyricist === 'Old Lyricist'
      && restored.arranger === 'Old Arranger'
      && restored.creditRoleSources.composer === 'topic'
      && Object.prototype.hasOwnProperty.call(restored.creditRoleSources, 'lyricist')
      && restored.creditRoleSources.lyricist === ''
      && !Object.prototype.hasOwnProperty.call(restored.creditRoleSources, 'arranger')
      && restored.creditRoleSources.keeper === 'general');
  check('[G6] restored log entries are removed while skipped entries and current values remain',
    restored.creditsRepairLog.length === 0
      && skipped.composer === 'Correct External Value' && skipped.creditsRepairLog.length === 1);

  const secondPreview = await db.restoreRepairedCredits({ dryRun: true });
  const secondApply = await db.restoreRepairedCredits({ dryRun: false, expectedValues: secondPreview.values });
  check('[G6] second restore is idempotent with zero restorable values and no writes',
    secondPreview.values === 0 && secondPreview.skipped === 1
      && secondApply.values === 0 && secondApply.skipped === 1
      && env.audit[3].puts.length === 0);
}

async function testReadonlyVerification() {
  const at = 900;
  const rows = [
    record('logged-invalid', {
      creditsRepairLog: [
        { v: 1, role: 'composer', before: 'https://example.com/bad', sourceBefore: 'topic', at, reason: 'invalid-credit-value' },
      ],
    }),
    record('logged-valid', {
      lyricist: 'Current Value',
      creditsRepairLog: [
        { v: 1, role: 'lyricist', before: 'Alice Smith', sourceBefore: 'general', at, reason: 'invalid-credit-value' },
      ],
    }),
    record('remaining-invalid', { arranger: '@still_bad' }),
  ];
  const env = makeFake(rows);
  const db = loadWatchedDb(env.idb);
  const before = mapSnapshot(env.stores.watchedVideos);
  const verified = await db.verifyCreditRepair({ at });
  check('[G7] verifyCreditRepair returns all four diagnostics correctly',
    verified.at === at && verified.remainingInvalid === 1 && verified.loggedTotal === 2
      && verified.loggedStillValid === 1 && verified.restorable === 1);
  check('[G7] verifyCreditRepair is readonly and performs zero writes',
    env.audit[0].mode === 'readonly' && env.audit[0].puts.length === 0
      && mapSnapshot(env.stores.watchedVideos) === before);
}

function testWiringAndUi() {
  const offscreen = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
  const history = fs.readFileSync(path.join(ROOT, 'history.js'), 'utf8');
  check('offscreen exposes fail-safe repair, restore, and readonly verification RPCs',
    offscreen.includes("case 'REPAIR_INVALID_CREDITS':")
      && offscreen.includes("case 'RESTORE_REPAIRED_CREDITS':")
      && offscreen.includes("case 'VERIFY_CREDIT_REPAIR':")
      && offscreen.includes('dryRun: message.dryRun === false ? false : true')
      && offscreen.includes('expectedValues: message.expectedValues'));
  check('background generic DB_RPC relay covers all credit maintenance operations',
    background.includes("if (message.type === 'DB_RPC')")
      && background.includes('sendToOffscreenDb(message.op, message)'));

  const repairPreviewAt = history.indexOf("sendHistoryDbRpc('REPAIR_INVALID_CREDITS', { dryRun: true })");
  const repairZeroAt = history.indexOf('if (preview.values === 0)', repairPreviewAt);
  const repairConfirmAt = history.indexOf('const confirmed = confirm(', repairZeroAt);
  const repairApplyAt = history.indexOf("sendHistoryDbRpc('REPAIR_INVALID_CREDITS', {", repairConfirmAt);
  const verifyAt = history.indexOf("sendHistoryDbRpc('VERIFY_CREDIT_REPAIR'", repairApplyAt);
  check('repair UI enforces preview, zero exit, confirm, expectedValues apply, then verification order',
    repairPreviewAt >= 0 && repairPreviewAt < repairZeroAt && repairZeroAt < repairConfirmAt
      && repairConfirmAt < repairApplyAt && repairApplyAt < verifyAt
      && history.indexOf('expectedValues: preview.values', repairApplyAt) > repairApplyAt
      && history.includes('もう一度確認してください'));
  check('repair UI displays all diagnostics and states the validator limitation',
    history.includes('verified.remainingInvalid') && history.includes('verified.loggedTotal')
      && history.includes('verified.loggedStillValid') && history.includes('verified.restorable')
      && history.includes('判定基準そのものは検証していません'));

  const repairButtonAt = html.indexOf('id="repairCredits"');
  const restoreButtonAt = html.indexOf('id="restoreCredits"');
  const restorePreviewAt = history.indexOf("sendHistoryDbRpc('RESTORE_REPAIRED_CREDITS', { dryRun: true })");
  const restoreZeroAt = history.indexOf('if (preview.values === 0)', restorePreviewAt);
  const restoreConfirmAt = history.indexOf('const confirmed = confirm(', restoreZeroAt);
  const restoreApplyAt = history.indexOf("sendHistoryDbRpc('RESTORE_REPAIRED_CREDITS', {", restoreConfirmAt);
  check('restore button is adjacent and UI enforces the same four-step guarded flow',
    repairButtonAt >= 0 && repairButtonAt < restoreButtonAt
      && restorePreviewAt >= 0 && restorePreviewAt < restoreZeroAt && restoreZeroAt < restoreConfirmAt
      && restoreConfirmAt < restoreApplyAt
      && history.indexOf('expectedValues: preview.values', restoreApplyAt) > restoreApplyAt
      && history.includes('上書きせずスキップ'));
}

async function main() {
  testPlannerAndManualProtection();
  await testFailSafeRpcDefault();
  await testExpectedValuesGuard();
  await testRepairLoopAndAudit();
  await testManualProtectionAtDbBoundary();
  await testFailureRollback();
  await testLikedStoreIsolation();
  await testRestoreContract();
  await testReadonlyVerification();
  testWiringAndUi();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
