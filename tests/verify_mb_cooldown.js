// MusicBrainz persistent cooldown verification.
// Run: node tests/verify_mb_cooldown.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CT = require(path.join(ROOT, 'credit_target.js'));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 2_000_000_000_000;

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function lookup(overrides = {}) {
  return {
    status: 'not-found',
    checkedAt: NOW - DAY,
    nextEligibleAt: NOW + DAY,
    queryFingerprint: CT.mbQueryFingerprint('Artist', 'Title'),
    missingRoles: ['composer'],
    attempts: 0,
    ...overrides,
  };
}

const opts = {
  artist: 'Artist',
  title: 'Title',
  missingRoles: ['composer'],
  now: NOW,
  ignoreCooldown: false,
};

console.log('fingerprint normalization');
check('NFKC, trim, whitespace collapse, and lowercase are canonicalized',
  CT.mbQueryFingerprint('  ＡＲＴＩＳＴ\tName ', ' Song\n TITLE ')
    === 'artist name\u0000song title');

console.log('shouldQueryMb');
check('condition 1: absent lookup queries', CT.shouldQueryMb({}, opts) === true);
check('condition 1: malformed lookup queries',
  CT.shouldQueryMb({ mbLookup: lookup({ attempts: -1 }) }, opts) === true);
check('cooldown hit skips an unchanged query',
  CT.shouldQueryMb({ mbLookup: lookup() }, opts) === false);
check('condition 2: exact expiry queries',
  CT.shouldQueryMb({ mbLookup: lookup({ nextEligibleAt: NOW }) }, opts) === true);
check('condition 3: changed fingerprint queries',
  CT.shouldQueryMb({ mbLookup: lookup() }, { ...opts, title: 'Changed title' }) === true);
check('condition 4: same missing roles stay skipped',
  CT.shouldQueryMb({ mbLookup: lookup({ missingRoles: ['composer', 'lyricist'] }) }, opts) === false);
check('condition 4: a newly missing role queries',
  CT.shouldQueryMb({ mbLookup: lookup() }, { ...opts, missingRoles: ['composer', 'arranger'] }) === true);
check('explicit bypass queries during cooldown',
  CT.shouldQueryMb({ mbLookup: lookup() }, { ...opts, ignoreCooldown: true }) === true);

console.log('computeMbNextEligibleAt');
check('successful statuses use 90 days',
  ['found', 'not-found', 'no-roles'].every((status) =>
    CT.computeMbNextEligibleAt(status, 0, NOW) === NOW + 90 * DAY));
check('error backoff starts at 1 hour', CT.computeMbNextEligibleAt('error', 1, NOW) === NOW + HOUR);
check('error backoff doubles by attempt', CT.computeMbNextEligibleAt('error', 5, NOW) === NOW + 16 * HOUR);
check('error backoff caps at 24 hours',
  CT.computeMbNextEligibleAt('error', 6, NOW) === NOW + 24 * HOUR
    && CT.computeMbNextEligibleAt('error', 20, NOW) === NOW + 24 * HOUR);

function makeFake(record) {
  const watched = new Map([[record.videoId, record]]);
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {};
      let outstanding = 0;
      let issued = false;
      const complete = () => {
        if (issued && outstanding === 0) setImmediate(() => tx.oncomplete && tx.oncomplete());
      };
      tx.objectStore = () => ({
        get(key) {
          outstanding++;
          const req = {};
          setImmediate(() => {
            req.result = watched.get(key);
            if (req.onsuccess) req.onsuccess();
            outstanding--;
            complete();
          });
          return req;
        },
        put(value) { watched.set(value.videoId, value); },
      });
      setImmediate(() => { issued = true; complete(); });
      return tx;
    },
  };
  return {
    watched,
    indexedDB: {
      open() {
        const req = {};
        setImmediate(() => {
          req.result = db;
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
    },
  };
}

async function testRecordMbLookup() {
  console.log('recordMbLookup');
  const fake = makeFake({ videoId: 'video-1', watchedAt: 1, source: 'self' });
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const WatchedDB = new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(
    fake.indexedDB,
    { CreditTarget: CT },
  );
  const fingerprint = CT.mbQueryFingerprint('Artist', 'Title');

  await WatchedDB.recordMbLookup('video-1', {
    status: 'error', missingRoles: ['composer'], queryFingerprint: fingerprint, now: NOW,
  });
  let saved = fake.watched.get('video-1').mbLookup;
  check('first DB error records attempts=1 and a 1-hour retry',
    saved.status === 'error' && saved.attempts === 1 && saved.nextEligibleAt === NOW + HOUR);

  await WatchedDB.recordMbLookup('video-1', {
    status: 'error', missingRoles: ['composer'], queryFingerprint: fingerprint, now: NOW + HOUR,
  });
  saved = fake.watched.get('video-1').mbLookup;
  check('repeated DB error increments attempts and doubles retry delay',
    saved.attempts === 2 && saved.nextEligibleAt === NOW + 3 * HOUR);

  const changedFingerprint = CT.mbQueryFingerprint('Artist', 'Changed Title');
  await WatchedDB.recordMbLookup('video-1', {
    status: 'error', missingRoles: ['composer'], queryFingerprint: changedFingerprint, now: NOW + 2 * HOUR,
  });
  saved = fake.watched.get('video-1').mbLookup;
  check('changed query condition restarts error backoff at attempt 1',
    saved.attempts === 1 && saved.nextEligibleAt === NOW + 3 * HOUR);

  await WatchedDB.recordMbLookup('video-1', {
    status: 'not-found', missingRoles: ['composer'], queryFingerprint: fingerprint, now: NOW + 4 * HOUR,
  });
  saved = fake.watched.get('video-1').mbLookup;
  check('successful DB result resets attempts and writes the 90-day boundary',
    saved.attempts === 0 && saved.nextEligibleAt === NOW + 4 * HOUR + 90 * DAY);

  fake.watched.get('video-1').mbLookup = lookup({ status: 'error', attempts: 8 });
  await WatchedDB.recordMbLookup('video-1', {
    status: 'error', missingRoles: ['arranger'], queryFingerprint: fingerprint,
    now: NOW + 5 * HOUR, ignoreCooldown: true,
  });
  saved = fake.watched.get('video-1').mbLookup;
  check('explicit bypass resets error backoff before recording the new failure',
    saved.attempts === 1 && saved.nextEligibleAt === NOW + 6 * HOUR
      && JSON.stringify(saved.missingRoles) === JSON.stringify(['arranger']));
}

testRecordMbLookup().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}).catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
