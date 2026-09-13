// 一括操作（キューに追加 / 後で見る）のライブ除外が、タイトルに "LIVE" を含む
// 通常動画まで落とさないことを確認する。
// Run: node tests/verify_bulk_live_filter.js
//
// 由来: 2026-09-09。関連動画サイドバーで「Wake Up, Girls！ FINAL LIVE 想い出のパレード」
// が19本表示されているのにボタンが (0) になっていた。原因は aria-label をカード全体へ
// 掛けていたこと（サムネイルのリンクの aria-label は動画タイトルそのもの）。
// ソース文字列の一致ではなく、出荷版の hasLiveBadge を切り出して実際に走らせる。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// verify_watch_later_panel_ui.js と同じ切り出し方。
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

// --- 最小DOM ------------------------------------------------------------------
// jsdom は入れていないので、hasLiveBadge が使う範囲（タグ名 / .class /
// [attr*="value"] のカンマ区切り、子孫検索のみ）だけを解釈する。
// 属性セレクタを自前で持つのが要点で、これが無いと「タイトルの aria-label に
// 当たってしまう」というバグ自体を再現できない。
function parseSimple(sel) {
  const s = sel.trim();
  let m = /^\[([a-zA-Z-]+)\*="([^"]*)"\]$/.exec(s);
  if (m) return { kind: 'attrContains', attr: m[1], value: m[2] };
  if (s.startsWith('.')) return { kind: 'class', value: s.slice(1) };
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) return { kind: 'tag', value: s.toLowerCase() };
  throw new Error('このテストの簡易マッチャが解釈できないセレクタ: ' + s);
}

function matches(node, part) {
  if (part.kind === 'tag') return node.tagName.toLowerCase() === part.value;
  if (part.kind === 'class') return node.classList.includes(part.value);
  const v = node.attrs[part.attr];
  return typeof v === 'string' && v.includes(part.value);
}

class El {
  constructor(tagName, { cls = '', attrs = {}, text = '', children = [] } = {}) {
    this.tagName = tagName;
    this.classList = cls ? cls.split(/\s+/) : [];
    this.attrs = attrs;
    this.ownText = text;
    this.children = children;
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  descendants() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
    return out;
  }
  querySelectorAll(selector) {
    const parts = selector.split(',').map(parseSimple);
    return this.descendants().filter((n) => parts.some((p) => matches(n, p)));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

// 実機の関連動画カード（新UI）の骨格。サムネイルのリンクが動画タイトルを
// aria-label に持つのが本件の肝。
function card({ title, badgeText = null, badgeLabel = null, oldLiveBadge = false }) {
  const children = [
    new El('a', { attrs: { href: '/watch?v=abc12345678', 'aria-label': title }, text: '' }),
    new El('span', { cls: 'yt-lockup-metadata-view-model__title', text: title }),
  ];
  if (badgeText !== null || badgeLabel !== null) {
    children.push(new El('badge-shape', {
      text: badgeText || '',
      attrs: badgeLabel ? { 'aria-label': badgeLabel } : {},
    }));
  }
  if (oldLiveBadge) children.push(new El('div', { cls: 'badge-style-type-live-now', text: '' }));
  return new El('yt-lockup-view-model', { children });
}

const hasLiveBadge = eval('(' + fn('hasLiveBadge', SRC) + ')');

// --- 1. 誤検出（今回の不具合そのもの） ----------------------------------------

check('タイトルに LIVE を含む通常動画をライブ扱いにしない',
  hasLiveBadge(card({ title: 'Polaris Wake Up, Girls！ FINAL LIVE 想い出のパレード at さいたまスーパーアリーナ' })) === false);

check('タイトルに「ライブ」を含む通常動画をライブ扱いにしない',
  hasLiveBadge(card({ title: '初ライブの舞台裏ドキュメント' })) === false);

check('LIVE ALBUM のような表記でも落とさない',
  hasLiveBadge(card({ title: 'Wake Up, Girls! LIVE ALBUM 試聴' })) === false);

check('バッジが付かない通常動画はライブではない',
  hasLiveBadge(card({ title: '7 Girls War (Instrumental)' })) === false);

// 退行検出力の実測: 修正前の判定（カード全体に aria-label を掛ける）を並べて走らせ、
// 上の fixture が本当にバグを踏むことを確かめる。ここが false になったら、fixture が
// 実機の構造からズレていて、同じバグが再発しても上の PASS はすり抜ける。
function legacyHasLiveBadge(card) {
  const liveBadge = card.querySelector(
    '.badge-style-type-live-now, [aria-label*="ライブ"], [aria-label*="LIVE"]'
  );
  if (liveBadge) return true;
  const badges = card.querySelectorAll('badge-shape, .badge-shape-wiz__text, .yt-badge-shape__text');
  for (const badge of badges) {
    if (/ライブ|live/i.test((badge.textContent || '').trim())) return true;
  }
  return false;
}

check('修正前の判定なら FINAL LIVE の通常動画を取りこぼしていた（fixture の検出力）',
  legacyHasLiveBadge(card({ title: 'Polaris Wake Up, Girls！ FINAL LIVE 想い出のパレード at さいたまスーパーアリーナ' })) === true);

// --- 2. 本物のライブは今までどおり除外する（退行防止） ------------------------

check('旧UIのライブバッジ（.badge-style-type-live-now）はライブ',
  hasLiveBadge(card({ title: '雑談配信', oldLiveBadge: true })) === true);

check('新UIのバッジ文言「ライブ配信中」はライブ',
  hasLiveBadge(card({ title: '雑談配信', badgeText: 'ライブ配信中' })) === true);

check('英語UIのバッジ文言 LIVE はライブ',
  hasLiveBadge(card({ title: 'Just chatting', badgeText: 'LIVE' })) === true);

check('バッジ側の aria-label だけにライブとあってもライブ',
  hasLiveBadge(card({ title: '雑談配信', badgeText: '', badgeLabel: 'ライブ配信中' })) === true);

// --- 3. 判定を1か所に寄せたままにする ----------------------------------------
// インライン版が復活すると、hasLiveBadge を直しても一括操作だけ取りこぼす。

const queueSrc = fn('findQueueableCards', SRC);
const wlSrc = fn('findWatchLaterableCards', SRC);

check('findQueueableCards は hasLiveBadge を使う', /hasLiveBadge\(card\)/.test(queueSrc));
check('findWatchLaterableCards は hasLiveBadge を使う', /hasLiveBadge\(card\)/.test(wlSrc));

check('カード全体に掛かる aria-label のライブ判定が残っていない',
  !/\[aria-label\*="(LIVE|ライブ)"\]/.test(SRC),
  SRC.match(/\[aria-label\*="(LIVE|ライブ)"\]/g)?.join(' / '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
