// Regression verification for iv0b stored credit repair.
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

function makeFake(watched = []) {
  const stores = {
    watchedVideos: new Map(watched.map((record) => [record.videoId, clone(record)])),
    likedVideos: new Map(),
  };
  const audit = [];
  let nextTxId = 1;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_names, mode) {
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
        openCursor() {
          outstanding++;
          const req = {};
          const keys = [...stores[name].keys()];
          let index = 0;
          const advance = () => {
            setImmediate(() => {
              if (index >= keys.length) {
                if (req.onsuccess) req.onsuccess({ target: { result: null } });
                outstanding--;
                maybeComplete();
                return;
              }
              const key = keys[index];
              const cursor = {
                value: clone(stores[name].get(key)),
                update(value) {
                  entry.puts.push({ store: name, key });
                  stores[name].set(key, clone(value));
                },
                continue() {
                  index++;
                  advance();
                },
              };
              if (req.onsuccess) req.onsuccess({ target: { result: cursor } });
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

function loadWatchedDb(idb) {
  const source = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  return new Function('indexedDB', 'globalThis', `${source}\nreturn WatchedDB;`)(idb, { CreditTarget: CT });
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

function testPlanner() {
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

  // The plan must pass the record's own title through to the validator; drop it
  // and the "credit value equals the video title" rejection silently stops firing.
  const titleEcho = record('echo', { composer: 'Title echo' });
  const echoPlan = CT.planCreditRepair(titleEcho);
  check('planner rejects a value identical to the video title',
    echoPlan.length === 1 && echoPlan[0].role === 'composer' && echoPlan[0].before === 'Title echo');

  const clean = record('clean', {
    composer: 'Alice', lyricist: '  ', arranger: '山田太郎', creditsRaw: 'https://example.com/raw',
  });
  check('planner keeps normal names, blanks, and creditsRaw out of the plan',
    CT.planCreditRepair(clean).length === 0);
  check('planner handles a missing record without inventing repairs', CT.planCreditRepair(null).length === 0);
}

async function testRepairLoop() {
  const oldLog = Array.from({ length: 9 }, (_, index) => ({
    v: 1, role: 'composer', before: `old-${index}`, at: index + 1, reason: 'invalid-credit-value',
  }));
  const firstBefore = record('first', {
    composer: 'https://example.com/composer',
    lyricist: 'Alice Smith',
    arranger: 'Copyright Control',
    creditRoleSources: { composer: 'topic', lyricist: 'manual', arranger: 'general' },
    creditsRepairLog: oldLog,
  });
  const secondBefore = record('second', {
    composer: 'Bob Jones', lyricist: '@bad_handle', arranger: '',
    creditRoleSources: { composer: 'topic', lyricist: 'general' },
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

  const applied = await db.repairInvalidCredits({ dryRun: false });
  const applyAudit = env.audit[1];
  const first = env.stores.watchedVideos.get('first');
  const second = env.stores.watchedVideos.get('second');
  const clean = env.stores.watchedVideos.get('clean');
  check('apply reports the same counts and writes only affected videos',
    applied.dryRun === false && applied.scanned === 3 && applied.videos === preview.videos
      && applied.values === preview.values && JSON.stringify(applied.byRole) === JSON.stringify(preview.byRole)
      && applyAudit.mode === 'readwrite' && applyAudit.puts.length === 2);
  check('apply blanks only invalid roles and removes only their role sources',
    first.composer === '' && first.arranger === '' && first.lyricist === 'Alice Smith'
      && JSON.stringify(first.creditRoleSources) === JSON.stringify({ lyricist: 'manual' })
      && second.composer === 'Bob Jones' && second.lyricist === ''
      && JSON.stringify(second.creditRoleSources) === JSON.stringify({ composer: 'topic' }));
  const newFirstLogs = first.creditsRepairLog.filter((entry) => entry.at === applied.at);
  const newSecondLogs = second.creditsRepairLog.filter((entry) => entry.at === applied.at);
  check('apply appends reconstructable audit entries and caps the log at 10',
    first.creditsRepairLog.length === 10 && newFirstLogs.length === 2 && newSecondLogs.length === 1
      && newFirstLogs.some((entry) => entry.role === 'composer' && entry.before === firstBefore.composer
        && entry.v === 1 && entry.reason === 'invalid-credit-value')
      && newFirstLogs.some((entry) => entry.role === 'arranger' && entry.before === firstBefore.arranger)
      && newSecondLogs[0].role === 'lyricist' && newSecondLogs[0].before === secondBefore.lyricist);
  check('creditsRaw is unchanged for repaired and clean records',
    first.creditsRaw === firstBefore.creditsRaw && second.creditsRaw === secondBefore.creditsRaw
      && clean.creditsRaw === untouchedBefore.creditsRaw);
  check('creditsCheckedAt and creditsEmptyCount are unchanged',
    first.creditsCheckedAt === firstBefore.creditsCheckedAt && first.creditsEmptyCount === firstBefore.creditsEmptyCount
      && second.creditsCheckedAt === secondBefore.creditsCheckedAt && second.creditsEmptyCount === secondBefore.creditsEmptyCount
      && first.creditsSource === firstBefore.creditsSource && second.creditsSource === secondBefore.creditsSource);
  check('unrelated clean record is unchanged', JSON.stringify(clean) === JSON.stringify(untouchedBefore));

  const secondApply = await db.repairInvalidCredits({ dryRun: false });
  const secondApplyAudit = env.audit[2];
  check('second apply is idempotent and performs zero writes',
    secondApply.scanned === 3 && secondApply.videos === 0 && secondApply.values === 0
      && secondApplyAudit.mode === 'readwrite' && secondApplyAudit.puts.length === 0);
}

function testWiring() {
  const offscreen = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
  const history = fs.readFileSync(path.join(ROOT, 'history.js'), 'utf8');
  check('offscreen exposes the repair RPC', offscreen.includes("case 'REPAIR_INVALID_CREDITS':")
    && offscreen.includes('WatchedDB.repairInvalidCredits({ dryRun: !!message.dryRun })'));
  check('background generic DB_RPC relay covers the new operation',
    background.includes("if (message.type === 'DB_RPC')") && background.includes('sendToOffscreenDb(message.op, message)'));
  const previewAt = history.indexOf("sendHistoryDbRpc('REPAIR_INVALID_CREDITS', { dryRun: true })");
  const zeroAt = history.indexOf('if (preview.values === 0)', previewAt);
  const confirmAt = history.indexOf('const confirmed = confirm(', zeroAt);
  const applyAt = history.indexOf("sendHistoryDbRpc('REPAIR_INVALID_CREDITS', { dryRun: false })", confirmAt);
  check('history contains the maintenance button and enforces dry-run, zero exit, confirm, apply order',
    html.includes('id="repairCredits"') && previewAt >= 0 && previewAt < zeroAt && zeroAt < confirmAt
      && confirmAt < applyAt && (history.match(/dryRun: false/g) || []).length === 1);
}

async function main() {
  testPlanner();
  await testRepairLoop();
  testWiring();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
