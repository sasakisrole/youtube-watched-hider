// Verifies that the "使い方と更新情報" page opens once on a fresh install and never
// on an update, so existing users do not get a tab opened under them.
// Run: node tests/verify_first_run_guide.js
// Sensitivity: node tests/verify_first_run_guide.js --control
//   (--control removes the tabs.create call; REQ-1 must fail. REQ-3/4/5 stay
//    green by design: they assert the update path is untouched.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTROL = process.argv.includes('--control');

let src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
if (CONTROL) {
  src = src.replace("    chrome.tabs.create({ url: chrome.runtime.getURL('whatsnew.html') });\n", '');
}

// background.js is a service worker; slice out just the onInstalled registration
// rather than evaluating the whole file (top-level chrome.* calls would throw).
const START = 'chrome.runtime.onInstalled.addListener(';
const END = '\nchrome.runtime.onStartup.addListener(';
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) throw new Error('onInstalled listener not found');
const unit = src.slice(start, end);

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function run(reason) {
  const calls = { tabs: [], set: [], get: [] };
  let listener = null;
  const chromeStub = {
    runtime: {
      onInstalled: { addListener: (fn) => { listener = fn; } },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        set: (v) => calls.set.push(v),
        get: (k, cb) => { calls.get.push(k); cb({}); },
      },
    },
    tabs: { create: (opts) => calls.tabs.push(opts) },
  };
  const scheduleDailyBackup = () => {};
  const createContextMenus = () => {};
  const ensureOffscreenDocument = () => Promise.resolve();
  const consoleStub = { warn() {}, log() {} };

  // eslint-disable-next-line no-new-func
  new Function(
    'chrome', 'scheduleDailyBackup', 'createContextMenus', 'ensureOffscreenDocument', 'console',
    unit,
  )(chromeStub, scheduleDailyBackup, createContextMenus, ensureOffscreenDocument, consoleStub);

  if (!listener) throw new Error('listener was not registered');
  listener({ reason });
  return calls;
}

const install = run('install');
const update = run('update');
const chromeUpdate = run('chrome_update');

// REQ-1: a fresh install opens the guide exactly once.
check('REQ-1 新規インストールで使い方ページが1回だけ開く',
  install.tabs.length === 1
    && install.tabs[0].url === 'chrome-extension://test/whatsnew.html');

// REQ-2: the existing migration flag write is untouched.
check('REQ-2 新規インストールの既存処理（移行フラグ）が残っている',
  install.set.length === 1 && install.set[0].migrationV135Done === true);

// REQ-3: an update must not steal a tab from an existing user.
check('REQ-3 更新ではタブを開かない（既存利用者に影響しない）',
  update.tabs.length === 0);

// REQ-4: the update path still performs its migration-flag check.
check('REQ-4 更新時の移行フラグ確認が残っている',
  update.get.length === 1 && update.get[0] === 'migrationV135Done');

// REQ-5: other reasons (browser update etc.) stay silent too.
check('REQ-5 chrome_update などその他の理由でも何も開かない',
  chromeUpdate.tabs.length === 0 && chromeUpdate.set.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
