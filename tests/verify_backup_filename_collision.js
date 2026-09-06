// Verifies that "今すぐバックアップ" never overwrites an earlier backup taken the
// same day, while the daily auto backup stays a single overwritten file.
// Run: node tests/verify_backup_filename_collision.js
// Sensitivity: node tests/verify_backup_filename_collision.js --control
//   (--control reverts the source-level branch to the old always-overwrite form;
//    REQ-1 / REQ-2 / REQ-4 must fail.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTROL = process.argv.includes('--control');

let src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
if (CONTROL) {
  src = src
    .replace("filename: isManual ? getManualBackupFilename() : getBackupFilename(),", 'filename: getBackupFilename(),')
    .replace("conflictAction: isManual ? 'uniquify' : 'overwrite',", "conflictAction: 'overwrite',");
}

// background.js is a service worker with top-level chrome.* registrations, so
// slice out only the three units under test instead of evaluating the whole file.
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`end marker not found after ${startMarker}`);
  return src.slice(start, end);
}

const unit = [
  slice('function getManualBackupFilename()', '// Generate backup filename with date'),
  slice('function getBackupFilename()', '// Returns a promise with the backup result'),
  slice('async function performAutoBackup(', '\n// Context menu click handler'),
].join('\n');

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Build an isolated environment whose only observable effect is the argument
// handed to downloadExportJson.
function makeEnv() {
  const downloads = [];
  const env = {
    downloads,
    storageLocalGet: async () => ({ autoBackup: true }),
    storageLocalSet: async () => {},
    summarizeBackupError: () => 'error',
    downloadExportJson: async (args) => { downloads.push(args); return { success: true, count: 1 }; },
    console: { log() {}, warn() {} },
  };
  const factory = new Function(
    'storageLocalGet', 'storageLocalSet', 'downloadExportJson', 'summarizeBackupError', 'console',
    `${unit}\nreturn performAutoBackup;`,
  );
  env.performAutoBackup = factory(
    env.storageLocalGet, env.storageLocalSet, env.downloadExportJson, env.summarizeBackupError, env.console,
  );
  return env;
}

async function run() {
  const auto = makeEnv();
  await auto.performAutoBackup({ source: 'auto' });
  const autoCall = auto.downloads[0];

  const manual = makeEnv();
  await manual.performAutoBackup({ source: 'backup-now', respectEnabled: false });
  const manualCall = manual.downloads[0];

  // REQ-1: the manual backup must not be allowed to replace an existing file.
  check('REQ-1 「今すぐバックアップ」は uniquify で既存ファイルを上書きしない',
    manualCall.conflictAction === 'uniquify');

  // REQ-2: its filename carries the time, so two runs on one day differ even
  // before the browser's own uniquify suffix is applied.
  check('REQ-2 手動バックアップ名は時刻まで含む',
    /^yt-watched-backup-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(manualCall.filename));

  // REQ-3: the daily automatic backup keeps one file per day (23MB x 365 would
  // otherwise accumulate), so it stays date-named and overwriting.
  check('REQ-3 自動バックアップは日付名・上書きのまま',
    autoCall.conflictAction === 'overwrite'
      && /^yt-watched-backup-\d{4}-\d{2}-\d{2}\.json$/.test(autoCall.filename));

  // REQ-4: the two paths must not collide with each other either.
  check('REQ-4 手動と自動でファイル名が衝突しない',
    manualCall.filename !== autoCall.filename);

  // REQ-5: the disabled guard still applies to the automatic path only.
  const disabled = makeEnv();
  disabled.performAutoBackup = new Function(
    'storageLocalGet', 'storageLocalSet', 'downloadExportJson', 'summarizeBackupError', 'console',
    `${unit}\nreturn performAutoBackup;`,
  )(async () => ({ autoBackup: false }), async () => {}, disabled.downloadExportJson, () => 'e', { log() {}, warn() {} });
  const off = await disabled.performAutoBackup({ source: 'auto' });
  const offManual = await disabled.performAutoBackup({ source: 'backup-now', respectEnabled: false });
  check('REQ-5 自動が無効でも「今すぐ」は実行される',
    off.reason === 'disabled' && offManual.success === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

run().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
