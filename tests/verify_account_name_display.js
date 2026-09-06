// Verifies that a percent-encoded YouTube handle is shown decoded, without
// changing the stored value (a changed stored value would make the saved and the
// freshly-read account look different and fire the account-change confirmation).
// Run: node tests/verify_account_name_display.js
// Sensitivity: node tests/verify_account_name_display.js --control
//   (--control makes displayAccountName return its input; REQ-1/REQ-2 must fail.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTROL = process.argv.includes('--control');

let src = fs.readFileSync(path.join(ROOT, 'analyzer.js'), 'utf8');

const START = '  function displayAccountName(value) {';
const END = '\n  function appendCell(row, value) {';
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) throw new Error('displayAccountName not found');
let unit = src.slice(start, end);
if (CONTROL) unit = '  function displayAccountName(value) { return String(value || ""); }';

// eslint-disable-next-line no-new-func
const displayAccountName = new Function(`${unit}\nreturn displayAccountName;`)();

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// REQ-1: a Japanese handle in the shape YouTube actually delivers (percent-encoded
// path segment) renders as readable text. The value here is a synthetic stand-in.
check('REQ-1 日本語ハンドルがデコードして表示される',
  displayAccountName('@%E3%81%AB%E3%81%BB%E3%82%93%E3%81%94-abc') === '@にほんご-abc');

// REQ-2: any percent-encoded non-ASCII name decodes, not just that one.
check('REQ-2 他のエンコード名もデコードされる',
  displayAccountName('%E3%83%86%E3%82%B9%E3%83%88') === 'テスト');

// REQ-3: plain ASCII handles pass through untouched.
check('REQ-3 ASCIIのハンドルはそのまま',
  displayAccountName('@plain-handle') === '@plain-handle');

// REQ-4: a malformed percent sequence must not throw; show the raw text instead.
check('REQ-4 壊れた % 列でも落ちず、生の文字列を返す',
  displayAccountName('@broken-%E3%81') === '@broken-%E3%81');

// REQ-5: empty/undefined stay empty rather than becoming "undefined".
check('REQ-5 空・未定義は空文字のまま',
  displayAccountName('') === '' && displayAccountName(undefined) === ''
    && displayAccountName(null) === '');

// REQ-6: a literal percent that is not an escape is left alone.
check('REQ-6 エスケープでない % を壊さない',
  displayAccountName('100% pure') === '100% pure');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
