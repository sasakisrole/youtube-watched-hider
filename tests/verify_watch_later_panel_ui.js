// Watch Later まとめて削除ダイアログの操作部分（件数欄のホイール増減・全件削除ボタン）。
// Run: node tests/verify_watch_later_panel_ui.js
//
// 出荷版 history.js から attachWheelStepper と startWatchLaterBatch を切り出して
// 実際に走らせる。削除は取り消せないので、「何件を START へ渡したか」を実行時の
// postMessage から読む（ソース文字列の一致では、渡す値が入れ替わっても通ってしまう）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'history.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// verify_watch_later_batch_behavior.js と同じ切り出し方。波括弧を数えるのは関数の
// 範囲を取るためだけで、判定はすべて実行時の呼び出しから取る。
function fn(name, src) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let d = 0, q = '', line = false, block = false, tpl = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (tpl) { if (c === '\\') i++; else if (c === '`') tpl = false; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '`') { tpl = true; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced function: ' + name);
}

// --- 1. 件数欄のホイール増減 ---------------------------------------------------

function makeInput({ value = '5', min = '1', max = '24', step = '1' } = {}) {
  const input = {
    value, min, max, step,
    handlers: {}, options: {}, dispatched: [],
    addEventListener(type, handler, options) { this.handlers[type] = handler; this.options[type] = options; },
    dispatchEvent(event) { this.dispatched.push(event.type); return true; },
  };
  return input;
}

function wheel(deltaY) {
  const event = { deltaY, defaultPrevented: false };
  event.preventDefault = () => { event.defaultPrevented = true; };
  return event;
}

const attachWheelStepper = eval('(' + fn('attachWheelStepper', SRC) + ')');
// Event はページのグローバル。テストでは型だけあれば足りる。
global.Event = class { constructor(type) { this.type = type; } };

const stepper = makeInput();
attachWheelStepper(stepper);
check('ホイールの購読は passive:false（そうでないと preventDefault が効かずページも一緒に動く）',
  stepper.options.wheel && stepper.options.wheel.passive === false,
  JSON.stringify(stepper.options.wheel));

let ev = wheel(-100);
stepper.handlers.wheel(ev);
check('上へ回すと1増える', stepper.value === '6', stepper.value);
check('ページのスクロールは止める', ev.defaultPrevented === true);
check('値が変わったら input イベントを出す', stepper.dispatched.join(',') === 'input', stepper.dispatched.join(','));

stepper.handlers.wheel(wheel(120));
stepper.handlers.wheel(wheel(120));
check('下へ回すと1ずつ減る', stepper.value === '4', stepper.value);

const atMax = makeInput({ value: '24', max: '24' });
attachWheelStepper(atMax);
ev = wheel(-100);
atMax.handlers.wheel(ev);
check('max を超えない（一覧に無い動画を消しに行かせない）', atMax.value === '24', atMax.value);
check('頭打ちのときは input イベントを出さない', atMax.dispatched.length === 0);

const atMin = makeInput({ value: '1', min: '1' });
attachWheelStepper(atMin);
atMin.handlers.wheel(wheel(120));
check('min を下回らない', atMin.value === '1', atMin.value);

const stepped = makeInput({ value: '10', step: '5', max: '100' });
attachWheelStepper(stepped);
stepped.handlers.wheel(wheel(-100));
check('step を尊重する', stepped.value === '15', stepped.value);

const horizontal = makeInput();
attachWheelStepper(horizontal);
ev = wheel(0);
horizontal.handlers.wheel(ev);
check('横スクロール（deltaY=0）では値を触らずページも止めない',
  horizontal.value === '5' && ev.defaultPrevented === false);

// --- 2. 全件削除ボタン ---------------------------------------------------------

check('history.html に全件削除ボタンがある', /id="wlPanelRunAll"/.test(HTML));
check('全件削除ボタンは取り消せない操作の見た目（wl-danger）を使う',
  /<button[^>]*id="wlPanelRunAll"[^>]*class="[^"]*wl-danger|class="[^"]*wl-danger[^"]*"[^>]*id="wlPanelRunAll"/.test(HTML));
check('一覧を開くたびに全件ボタンの件数表示を作り直す',
  /wlPanelRunAll\.textContent = `全\$\{rows\.length\}件を削除`/.test(SRC));
check('全件ボタンは一覧の件数をそのまま渡す（欄の値を経由しない）',
  /wlPanelRunAll\.addEventListener\('click',[\s\S]{0,160}?startWatchLaterBatch\(armedWatchLaterBatch \? armedWatchLaterBatch\.rows\.length : 0\)/.test(SRC));

// 実際に走らせて START へ乗る limit を読む。ここが一覧の件数と食い違うと、
// 「全件」と言いながら5件しか消さない／一覧に無い動画まで巻き込む事故になる。
function runBatch(requestedLimit, rows) {
  const sent = [];
  const btn = () => ({ disabled: false });
  const scope = {
    armedWatchLaterBatch: { syncSessionId: 'S1', rows, truncated: false },
    armedWatchLaterTarget: null,
    wlPanelDeleting: false,
    wlPanelStatus: { textContent: '' },
    wlPanelRun: btn(), wlPanelRunAll: btn(), wlPanelCancel: btn(),
    bulkRemoveWatchLaterBtn: btn(), removeOneWatchLaterBtn: btn(),
    confirmed: null,
    confirm: (text) => { scope.confirmed = text; return true; },
    beginMaintenance: () => true,
    endMaintenance: () => {},
    showJobMessage: () => {},
    armWatchLaterBatch: () => {},
    closeWatchLaterPanel: () => {},
    describeBatchStop: (s) => s,
    setTimeout: () => 0,
    clearTimeout: () => {},
    chrome: {
      runtime: {
        connect: () => ({
          postMessage: (msg) => sent.push(msg),
          disconnect: () => {},
          onMessage: { addListener: () => {} },
          onDisconnect: { addListener: () => {} },
        }),
      },
    },
  };
  const names = Object.keys(scope);
  const body = fn('startWatchLaterBatch', SRC);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, body + '; return startWatchLaterBatch;');
  make(...names.map((k) => scope[k]))(requestedLimit);
  return { sent, scope };
}

const rows24 = Array.from({ length: 24 }, (_, i) => ({ videoId: 'v' + i, title: 't' + i }));

let r = runBatch(rows24.length, rows24);
check('全件指定なら START の limit が一覧の件数と一致する',
  r.sent.length === 1 && r.sent[0].type === 'START' && r.sent[0].limit === 24,
  JSON.stringify(r.sent[0]));
check('全件指定でも渡す videoIds は一覧そのもの', r.sent[0].videoIds.length === 24);
check('全件のときは確認ダイアログでそれと分かる', /一覧の全24件を削除します/.test(r.scope.confirmed), r.scope.confirmed);

r = runBatch('5', rows24);
check('欄の値（文字列）でも数として扱う', r.sent[0].limit === 5, String(r.sent[0].limit));
check('一部削除のときは「一覧の全」と書かない', /^「後で見る」から5件を削除します/.test(r.scope.confirmed), r.scope.confirmed);

r = runBatch(999, rows24);
check('一覧の件数を超える指定は一覧の件数で頭打ちにする', r.sent[0].limit === 24, String(r.sent[0].limit));

r = runBatch(0, rows24);
check('0以下の指定でも1件未満にはしない', r.sent[0].limit === 1, String(r.sent[0].limit));

r = runBatch(rows24.length, rows24);
check('実行中は全件ボタンも押せなくする（二重実行の防止）', r.scope.wlPanelRunAll.disabled === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
