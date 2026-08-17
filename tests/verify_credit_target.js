// Verification for Path A (概要欄 Fix Credits) role-unit targeting + re-fetch
// cool-down (HANDOFF §3.1/§3.4 lightweight). Run: node verify_credit_target.js
//
// Pins the behavior change: the OLD whole-video gate
//   !(composer || lyricist || arranger || creditsRaw)
// excluded partial-credit videos; the NEW gate includes any video with a still
// -missing role, while the cool-down keeps re-fetch of unchanged descriptions
// bounded.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CT = require(path.join(ROOT, 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // fixed "now" so tests are deterministic
// The old excluded-any-credit gate, kept here to prove the regression direction.
function oldGate(v) { return !(v.composer || v.lyricist || v.arranger || v.creditsRaw); }

// --- hasMissingCreditRole ---------------------------------------------------
console.log('hasMissingCreditRole');
check('all blank -> missing', CT.hasMissingCreditRole({ composer: '', lyricist: '', arranger: '' }) === true);
check('composer filled, arranger blank -> missing', CT.hasMissingCreditRole({ composer: 'Ayase', lyricist: '', arranger: '' }) === true);
check('all filled -> not missing', CT.hasMissingCreditRole({ composer: 'A', lyricist: 'B', arranger: 'C' }) === false);
check('whitespace counts as blank -> missing', CT.hasMissingCreditRole({ composer: '  ', lyricist: 'B', arranger: 'C' }) === true);
check('undefined fields -> missing', CT.hasMissingCreditRole({}) === true);
check('null record -> missing (all blank)', CT.hasMissingCreditRole(null) === true);

// --- recentlyCreditChecked --------------------------------------------------
console.log('recentlyCreditChecked');
check('never checked (0) -> not recent', CT.recentlyCreditChecked({ creditsCheckedAt: 0 }, NOW) === false);
check('missing field -> not recent', CT.recentlyCreditChecked({}, NOW) === false);
check('checked 5 days ago -> recent', CT.recentlyCreditChecked({ creditsCheckedAt: NOW - 5 * DAY }, NOW) === true);
// creditsEmptyCount 0 = the last read made progress, so the short window applies.
check('checked 40 days ago on the short window -> not recent',
  CT.recentlyCreditChecked({ composer: 'found', creditsEmptyCount: 0, creditsCheckedAt: NOW - 40 * DAY }, NOW) === false);
check('just inside window (29.9 days) -> recent', CT.recentlyCreditChecked({ creditsCheckedAt: NOW - 29 * DAY }, NOW) === true);

// --- result-specific cool-down ----------------------------------------------
console.log('result-specific cool-down');
const emptyZeroAt30 = {
  composer: '', lyricist: '', arranger: '', creditsRaw: '', creditsEmptyCount: 0,
  creditsCheckedAt: NOW - 30 * DAY,
};
check('empty count 0 becomes eligible again at 30 days',
  CT.isFixCreditsTarget(emptyZeroAt30, { now: NOW }) === true);

const emptyOneAt30 = { ...emptyZeroAt30, creditsEmptyCount: 1 };
const emptyOneAt180 = { ...emptyOneAt30, creditsCheckedAt: NOW - 180 * DAY };
check('empty count 1 stays skipped at 30 days and becomes eligible at 180 days',
  CT.isFixCreditsTarget(emptyOneAt30, { now: NOW }) === false
    && CT.isFixCreditsTarget(emptyOneAt180, { now: NOW }) === true);

const emptyManyAt720 = { ...emptyZeroAt30, creditsEmptyCount: 99, creditsCheckedAt: NOW - 720 * DAY };
check('empty count 3 or more is capped at 720 days',
  CT.creditRecheckWindowMs({ creditsEmptyCount: 3 }) === 720 * DAY
    && CT.creditRecheckWindowMs({ creditsEmptyCount: 99 }) === 720 * DAY
    && CT.isFixCreditsTarget(emptyManyAt720, { now: NOW }) === true);

const legacyEmptyAt30 = {
  composer: '', lyricist: '', arranger: '', creditsRaw: '',
  creditsCheckedAt: NOW - 30 * DAY,
};
check('legacy checked record with no raw text and all roles blank uses 180 days',
  CT.creditsLookedEmptyCount(legacyEmptyAt30) === 1
    && CT.creditRecheckWindowMs(legacyEmptyAt30) === 180 * DAY
    && CT.isFixCreditsTarget(legacyEmptyAt30, { now: NOW }) === false);

// A description that yielded raw text but left roles blank does not carry those
// roles, so re-reading it is just as fruitless as an empty one.
const legacyRawAt30 = { ...legacyEmptyAt30, creditsRaw: 'Composer: someone' };
check('legacy record checked but still incomplete uses 180 days even with raw text',
  CT.creditsLookedEmptyCount(legacyRawAt30) === 1
    && CT.creditRecheckWindowMs(legacyRawAt30) === 180 * DAY
    && CT.isFixCreditsTarget(legacyRawAt30, { now: NOW }) === false);

// One batch shares a check timestamp; without a spread they would all come due on
// the same day and rebuild the pile. Same id must always land on the same offset.
const spreadA = { ...legacyEmptyAt30, videoId: 'aaaaaaaaaaa' };
const spreadB = { ...legacyEmptyAt30, videoId: 'bbbbbbbbbbb' };
check('the long window is spread per video and is stable for the same id',
  CT.creditRecheckSpreadMs(spreadA) === CT.creditRecheckSpreadMs({ ...spreadA })
    && CT.creditRecheckSpreadMs(spreadA) !== CT.creditRecheckSpreadMs(spreadB)
    && CT.creditRecheckSpreadMs(spreadA) < CT.CREDIT_RECHECK_SPREAD_MS
    && CT.creditRecheckWindowMs(spreadA) >= 180 * DAY
    && CT.creditRecheckWindowMs(spreadA) < 210 * DAY);
check('a record without a videoId gets no spread',
  CT.creditRecheckSpreadMs(legacyEmptyAt30) === 0
    && CT.creditRecheckWindowMs(legacyEmptyAt30) === 180 * DAY);

const legacyPartialAt30 = { ...legacyEmptyAt30, composer: 'Ayase', creditsRaw: 'Ayase' };
check('legacy record with one role filled and the rest blank also uses 180 days',
  CT.creditsLookedEmptyCount(legacyPartialAt30) === 1
    && CT.isFixCreditsTarget(legacyPartialAt30, { now: NOW }) === false
    && CT.isFixCreditsTarget({ ...legacyPartialAt30, creditsCheckedAt: NOW - 181 * DAY }, { now: NOW }) === true);

// --- isFixCreditsTarget: the core §3.1 regression ---------------------------
console.log('isFixCreditsTarget (role-unit)');
const partial = { composer: 'Ayase', lyricist: '', arranger: '', creditsRaw: 'Ayase · X', creditsCheckedAt: 0 };
check('REGRESSION old gate EXCLUDES partial record', oldGate(partial) === false);
check('REGRESSION new gate INCLUDES partial record (never checked)',
  CT.isFixCreditsTarget(partial, { skipChecked: true, now: NOW }) === true);
check('fully-assigned record is never a target',
  CT.isFixCreditsTarget({ composer: 'A', lyricist: 'B', arranger: 'C', creditsCheckedAt: 0 }, { skipChecked: true, now: NOW }) === false);
check('never-fetched Topic video (all blank, no creditsRaw) is a target',
  CT.isFixCreditsTarget({ composer: '', lyricist: '', arranger: '' }, { skipChecked: true, now: NOW }) === true);

// --- isFixCreditsTarget: cool-down interaction with skipChecked -------------
console.log('isFixCreditsTarget (cool-down)');
const recentPartial = { composer: 'Ayase', lyricist: '', arranger: '', creditsCheckedAt: NOW - 5 * DAY };
const oldPartial = { composer: 'Ayase', lyricist: '', arranger: '', creditsCheckedAt: NOW - 40 * DAY };
check('skip on: recently-checked partial is SKIPPED',
  CT.isFixCreditsTarget(recentPartial, { skipChecked: true, now: NOW }) === false);
// A partial record was read and stayed partial, so 40 days is still inside its
// (long) window — it comes back after 180 days instead of hammering every month.
check('skip on: long-ago-checked partial waits for the long window',
  CT.isFixCreditsTarget(oldPartial, { skipChecked: true, now: NOW }) === false
    && CT.isFixCreditsTarget({ ...oldPartial, creditsCheckedAt: NOW - 181 * DAY }, { skipChecked: true, now: NOW }) === true);
check('skip on: a partial whose last read made progress is ELIGIBLE again at 40 days',
  CT.isFixCreditsTarget({ ...oldPartial, creditsEmptyCount: 0 }, { skipChecked: true, now: NOW }) === true);
check('skip OFF: recently-checked partial is forced back in',
  CT.isFixCreditsTarget(recentPartial, { skipChecked: false, now: NOW }) === true);
check('skip OFF: fully-assigned is still NOT a target (role gate wins)',
  CT.isFixCreditsTarget({ composer: 'A', lyricist: 'B', arranger: 'C', creditsCheckedAt: NOW - 5 * DAY }, { skipChecked: false, now: NOW }) === false);
check('failed fetch (missing roles, no creditsCheckedAt) stays immediately eligible',
  CT.isFixCreditsTarget({ composer: '', lyricist: '', arranger: '', creditsFetchFailReason: 'timeout' }, { skipChecked: true, now: NOW }) === true);
check('skipChecked defaults to true when omitted',
  CT.isFixCreditsTarget(recentPartial, { now: NOW }) === false);

// --- constant sanity --------------------------------------------------------
console.log('constants');
check('CREDIT_RECHECK_MS is 30 days', CT.CREDIT_RECHECK_MS === 30 * DAY);
check('MB_RECHECK_MS is 90 days', CT.MB_RECHECK_MS === 90 * DAY);
check('CREDIT_ROLES are the 3 roles', JSON.stringify(CT.CREDIT_ROLES) === JSON.stringify(['composer', 'lyricist', 'arranger']));

// --- MusicBrainz persistent cooldown ---------------------------------------
console.log('MusicBrainz cooldown');
const mbFingerprint = CT.mbQueryFingerprint(' Artist ', 'Ｔｉｔｌｅ');
const mbRecord = { mbLookup: {
  status: 'not-found', checkedAt: NOW - DAY, nextEligibleAt: NOW + DAY,
  queryFingerprint: mbFingerprint, missingRoles: ['lyricist'], attempts: 0,
} };
check('unchanged MusicBrainz lookup inside cooldown is skipped',
  CT.shouldQueryMb(mbRecord, { artist: 'artist', title: 'title', missingRoles: ['lyricist'], now: NOW }) === false);
check('changed MusicBrainz query is immediately eligible',
  CT.shouldQueryMb(mbRecord, { artist: 'artist', title: 'new title', missingRoles: ['lyricist'], now: NOW }) === true);
check('newly missing MusicBrainz role is immediately eligible',
  CT.shouldQueryMb(mbRecord, { artist: 'artist', title: 'title', missingRoles: ['lyricist', 'arranger'], now: NOW }) === true);

function makeFakeIndexedDb(record) {
  const db = {
    transaction() {
      const tx = {};
      const store = {
        get() {
          const request = {};
          setImmediate(() => {
            request.result = record;
            if (request.onsuccess) request.onsuccess();
            setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
          });
          return request;
        },
        put(value) { Object.assign(record, value); },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    open() {
      const request = {};
      setImmediate(() => {
        request.result = db;
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
  };
}

async function verifyDbEmptyCount() {
  console.log('DB empty-count writes');
  const record = {
    videoId: 'empty-count', title: 'Test video',
    composer: 'Existing Composer', lyricist: '', arranger: '', creditsRaw: '',
  };
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const watchedDb = new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(
    makeFakeIndexedDb(record), { CreditTarget: CT });

  await watchedDb.markCreditsChecked(record.videoId);
  const afterFirstEmpty = record.creditsEmptyCount;
  await watchedDb.markCreditsChecked(record.videoId);
  const afterSecondEmpty = record.creditsEmptyCount;
  // composer is already filled, so nothing new lands: the read was fruitless too.
  const didUpdate = await watchedDb.updateCredits(record.videoId, { composer: 'Replacement' }, false, 'general');
  check('markCreditsChecked increments, and a no-progress updateCredits keeps counting up',
    afterFirstEmpty === 1 && afterSecondEmpty === 2
      && didUpdate === false && record.creditsEmptyCount === 3);

  // Real progress means the description is still worth re-reading soon.
  const progressed = await watchedDb.updateCredits(record.videoId, { lyricist: 'Someone' }, false, 'general');
  check('updateCredits resets the count when a role is actually filled',
    progressed === true && record.creditsEmptyCount === 0);
}

async function run() {
  await verifyDbEmptyCount();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
