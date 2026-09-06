// 履歴の1件削除（× ボタン）の取り消し猶予。
// Run: node tests/verify_history_delete_undo.js
//
// この機能で一番まずいのは「取り消したのにDBからは消えている」と
// 「取り消していないのにDBから消えていない」の2方向。どちらもソースの字面では
// 判定できないので、出荷版 history.js の該当ブロックをそのまま実行して、
// DELETE_VIDEO が実際に何件・どのIDで送られたかを見る。
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

const START = '// 絞り込み中に母数が見えなくなるので、全体の件数を横に添える';
const END = '// Build a single video row element';
const startIdx = SRC.indexOf(START);
const endIdx = SRC.indexOf(END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.log('  FAIL 削除ブロックを切り出せませんでした（目印のコメントが変わった？）');
  process.exit(1);
}
const BLOCK = SRC.slice(startIdx, endIdx);

// 実行環境をまるごと差し替える。allData / sortedCache は splice で書き換えるので
// 呼び出し側から同じ配列を覗ける。renderedCount は再代入されるので getter で読む。
function setup({ all, sorted, renderedCount = 100, filtered = false } = {}) {
  const state = {
    sent: [], jobMessages: [], renders: 0,
    timers: new Map(), nextTimer: 1,
    lastError: null, deleteResult: { success: true },
    listeners: {},
  };
  const el = () => ({ hidden: false, textContent: '', isConnected: true, removed: false,
    remove() { this.removed = true; this.isConnected = false; } });
  state.totalCountEl = el();
  state.totalCountOfEl = el();
  state.undoToast = el();
  state.undoToastText = el();
  state.undoToastBtn = { handlers: {}, addEventListener(t, h) { this.handlers[t] = h; } };

  const scope = {
    allData: all,
    sortedCache: sorted,
    renderedCount,
    totalCountEl: state.totalCountEl,
    totalCountOfEl: state.totalCountOfEl,
    undoToast: state.undoToast,
    undoToastText: state.undoToastText,
    undoToastBtn: state.undoToastBtn,
    render: () => { state.renders++; },
    showJobMessage: (msg, opts) => { state.jobMessages.push({ msg, opts }); },
    setTimeout: (fn) => { const id = state.nextTimer++; state.timers.set(id, fn); return id; },
    clearTimeout: (id) => { state.timers.delete(id); },
    window: { addEventListener: (type, fn) => { state.listeners[type] = fn; } },
    chrome: {
      runtime: {
        get lastError() { return state.lastError; },
        sendMessage: (msg, cb) => {
          state.sent.push(msg);
          if (cb) cb(state.deleteResult);
        },
      },
    },
  };
  const names = Object.keys(scope);
  const api = 'return { deleteVideo, restoreDelete, commitDelete, updateTotalCount, '
    + 'getPending: () => pendingDeletes, getRenderedCount: () => renderedCount };';
  // eslint-disable-next-line no-new-func
  const built = new Function(...names, BLOCK + '\n' + api)(...names.map((k) => scope[k]));
  state.filtered = filtered;
  return { ...built, state, scope };
}

function makeVideos(n) {
  return Array.from({ length: n }, (_, i) => ({ videoId: 'v' + i, title: 't' + i }));
}
function makeRow() {
  return { hidden: false, isConnected: true, removed: false,
    remove() { this.removed = true; this.isConnected = false; } };
}

// --- 削除を押した直後 ------------------------------------------------------

let all = makeVideos(10);
let sorted = all.slice();
let ctx = setup({ all, sorted, renderedCount: 10 });
let row = makeRow();
ctx.deleteVideo(all[3], row);

check('押した直後は DELETE_VIDEO を送らない（猶予の間はDBを触らない）',
  ctx.state.sent.length === 0, JSON.stringify(ctx.state.sent));
check('行は消さずに隠す', row.hidden === true && row.removed === false);
check('一覧の配列からは外す', sorted.length === 9 && all.length === 9 && !sorted.includes(ctx.state.dummy));
check('外したのは押した動画', !sorted.some((v) => v.videoId === 'v3'));
check('件数表示を更新する', ctx.state.totalCountEl.textContent === '9', ctx.state.totalCountEl.textContent);
check('取り消しトーストを出す', ctx.state.undoToast.hidden === false
  && ctx.state.undoToastText.textContent === '1件を履歴から削除しました',
  ctx.state.undoToastText.textContent);
check('描画済み件数も一緒に詰める（詰めないと次の100件で1件飛ぶ）',
  ctx.getRenderedCount() === 9, String(ctx.getRenderedCount()));

// --- 取り消し --------------------------------------------------------------

ctx.state.undoToastBtn.handlers.click();
check('取り消すと元の位置へ戻る', sorted.length === 10 && sorted[3].videoId === 'v3',
  sorted.map((v) => v.videoId).join(','));
check('取り消すと allData にも戻る', all.length === 10 && all[3].videoId === 'v3');
check('取り消すと行が再び見える', row.hidden === false);
check('取り消しても DELETE_VIDEO は送られない', ctx.state.sent.length === 0);
check('取り消すとトーストが消える', ctx.state.undoToast.hidden === true);
check('取り消すと描画済み件数も戻る', ctx.getRenderedCount() === 10, String(ctx.getRenderedCount()));
check('取り消したらタイマーも解除する', ctx.state.timers.size === 0, String(ctx.state.timers.size));

// --- 猶予が切れたら実削除 --------------------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted, renderedCount: 10 });
row = makeRow();
ctx.deleteVideo(all[0], row);
[...ctx.state.timers.values()][0]();
check('猶予が切れたら DELETE_VIDEO を1回だけ送る',
  ctx.state.sent.length === 1 && ctx.state.sent[0].type === 'DELETE_VIDEO'
  && ctx.state.sent[0].videoId === 'v0', JSON.stringify(ctx.state.sent));
check('実削除が通ったら行をDOMから外す', row.removed === true);
check('実削除後はトーストを閉じる', ctx.state.undoToast.hidden === true);
check('実削除後は取り消し待ちが残らない', ctx.getPending().length === 0);

// --- 実削除に失敗したら戻す ------------------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted, renderedCount: 10 });
ctx.state.deleteResult = { success: false, error: 'boom' };
row = makeRow();
ctx.deleteVideo(all[2], row);
[...ctx.state.timers.values()][0]();
check('削除に失敗したら一覧へ戻す（消えたように見えたまま残らない）',
  sorted.length === 10 && sorted[2].videoId === 'v2' && row.hidden === false);
check('削除に失敗したら理由を出す',
  ctx.state.jobMessages.length === 1
  && /履歴から削除できませんでした/.test(ctx.state.jobMessages[0].msg)
  && ctx.state.jobMessages[0].opts.state === 'error',
  JSON.stringify(ctx.state.jobMessages));
check('失敗した行はDOMから外さない', row.removed === false);

// --- タブを閉じたとき ------------------------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted, renderedCount: 10 });
const rows = [makeRow(), makeRow()];
ctx.deleteVideo(all.find((v) => v.videoId === 'v1'), rows[0]);
ctx.deleteVideo(all.find((v) => v.videoId === 'v5'), rows[1]);
check('複数消すとトーストは件数をまとめて出す',
  ctx.state.undoToastText.textContent === '2件を履歴から削除しました',
  ctx.state.undoToastText.textContent);
check('pagehide を購読している（タイマーごと消える経路）', typeof ctx.state.listeners.pagehide === 'function');
ctx.state.listeners.pagehide();
check('タブを閉じるときは猶予中の分をまとめて送る',
  ctx.state.sent.length === 2
  && ctx.state.sent.map((m) => m.videoId).sort().join(',') === 'v1,v5',
  JSON.stringify(ctx.state.sent));
check('送ったら取り消し待ちを空にする（二重送信の防止）', ctx.getPending().length === 0);
check('送ったらタイマーも解除する', ctx.state.timers.size === 0);

// --- 複数の取り消しは新しい順に戻す ----------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted, renderedCount: 10 });
ctx.deleteVideo(all.find((v) => v.videoId === 'v2'), makeRow());
ctx.deleteVideo(all.find((v) => v.videoId === 'v7'), makeRow());
ctx.state.undoToastBtn.handlers.click();
check('2件まとめて取り消しても並び順が元どおりになる',
  sorted.map((v) => v.videoId).join(',') === 'v0,v1,v2,v3,v4,v5,v6,v7,v8,v9',
  sorted.map((v) => v.videoId).join(','));

// --- 猶予中に検索・並べ替えが走った場合 ------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted, renderedCount: 10 });
row = makeRow();
ctx.deleteVideo(all[4], row);
row.isConnected = false; // render() で作り直されて、隠しておいた行はもう画面に無い
ctx.state.undoToastBtn.handlers.click();
check('行が作り直されていたら描画し直す（戻したのに一覧へ出ない、を防ぐ）',
  ctx.state.renders === 1, String(ctx.state.renders));

// --- 件数表示 --------------------------------------------------------------

all = makeVideos(10); sorted = all.slice();
ctx = setup({ all, sorted });
ctx.updateTotalCount();
check('絞り込んでいないときは全体件数を重ねて出さない',
  ctx.state.totalCountOfEl.textContent === '', ctx.state.totalCountOfEl.textContent);

all = makeVideos(10); sorted = all.slice(0, 3);
ctx = setup({ all, sorted });
ctx.updateTotalCount();
check('絞り込み中は母数が読める',
  ctx.state.totalCountEl.textContent === '3' && ctx.state.totalCountOfEl.textContent === '（全10件）',
  ctx.state.totalCountOfEl.textContent);

// --- 画面側の下ごしらえ ----------------------------------------------------

check('トーストと取り消しボタンが history.html にある',
  /id="undoToast"/.test(HTML) && /id="undoToastBtn"/.test(HTML));
check('隠した行が display:flex で見えたままにならない',
  /\.video-row\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(HTML));
check('キーボードで削除ボタンへ到達したとき見える',
  /\.video-row:focus-within \.delete-btn \{ opacity: 1; \}/.test(HTML)
  && /\.delete-btn:focus-visible \{[\s\S]{0,200}?opacity: 1;/.test(HTML));
check('押せないボタンの title が読めるよう pointer-events を落としていない',
  !/\.sort-btn:disabled \{[^}]*pointer-events:\s*none/.test(HTML));
check('「先頭へ戻る」がある', /id="backToTop"/.test(HTML) && /window\.scrollTo\(\{ top: 0/.test(SRC));
check('英語のまま残っている画面文言がない',
  !/'Remove from history'|'Detected via YouTube seekbar'|'Imported from YouTube history'|'Could not load data\./.test(SRC));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
