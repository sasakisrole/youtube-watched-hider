// Verification for Path A (概要欄 Fix Credits) role-unit targeting + re-fetch
// cool-down (HANDOFF §3.1/§3.4 lightweight). Run: node verify_credit_target.js
//
// Pins the behavior change: the OLD whole-video gate
//   !(composer || lyricist || arranger || creditsRaw)
// excluded partial-credit videos; the NEW gate includes any video with a still
// -missing role, while the cool-down keeps re-fetch of unchanged descriptions
// bounded.
const path = require('path');
const CT = require(path.join(__dirname, '..', 'credit_target.js'));

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
check('checked 40 days ago -> not recent', CT.recentlyCreditChecked({ creditsCheckedAt: NOW - 40 * DAY }, NOW) === false);
check('boundary: exactly 30 days ago -> not recent (>= window)', CT.recentlyCreditChecked({ creditsCheckedAt: NOW - 30 * DAY }, NOW) === false);
check('just inside window (29.9 days) -> recent', CT.recentlyCreditChecked({ creditsCheckedAt: NOW - 29 * DAY }, NOW) === true);

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
check('skip on: long-ago-checked partial is ELIGIBLE again',
  CT.isFixCreditsTarget(oldPartial, { skipChecked: true, now: NOW }) === true);
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
check('CREDIT_ROLES are the 3 roles', JSON.stringify(CT.CREDIT_ROLES) === JSON.stringify(['composer', 'lyricist', 'arranger']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
