#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const html = read('whatsnew.html');
const source = read('whatsnew.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
const digest = text => createHash('sha256').update(text).digest('hex');

// Minimal DOM for this page: parse the actual HTML, including unbound text nodes,
// rather than constructing test elements from data-i18n (which misses omissions).
class Element {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.hidden = Object.hasOwn(attrs, 'hidden');
    this.className = attrs.class || '';
  }
  appendChild(child) { this.children.push(child); return child; }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(value) { this.children = value === '' ? [] : [String(value)]; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setAttribute(key, value) { this.attrs[key] = value; }
}

function parse(markup) {
  const root = new Element('document');
  const stack = [root];
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      assert.strictEqual(stack.pop().tag, token.match(/^<\/([\w-]+)/)[1]);
    } else if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)[1];
      const attrs = Object.fromEntries([...token.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      if (/\shidden(?:\s|>)/.test(token)) attrs.hidden = '';
      const node = stack.at(-1).appendChild(new Element(tag, attrs));
      if (!['meta', 'link', 'br', 'hr', 'input', 'img'].includes(tag)) stack.push(node);
    } else stack.at(-1).appendChild(token);
  }
  assert.strictEqual(stack.length, 1);
  const elements = [];
  function visit(node) {
    if (typeof node === 'string') return;
    elements.push(node);
    node.children.forEach(visit);
  }
  visit(root);
  return {
    root, elements,
    documentElement: elements.find(e => e.tag === 'html'),
    createElement: tag => new Element(tag),
    getElementById: id => elements.find(e => e.attrs.id === id),
    querySelectorAll: selector => elements.filter(e => Object.hasOwn(e.attrs, selector.slice(1, -1))),
  };
}

function textOf(node, { includeHidden = false, omitReleaseBodies = false } = {}) {
  if (typeof node === 'string') return node;
  if ((!includeHidden && node.hidden) || ['style', 'script'].includes(node.tag)) return '';
  if (omitReleaseBodies && ['release', 'older'].includes(node.className)) {
    // Only release prose is exempt. Still scan its version/date heading.
    return textOf(node.children[0], { includeHidden, omitReleaseBodies });
  }
  return node.children.map(c => textOf(c, { includeHidden, omitReleaseBodies })).join('');
}

const releases = Array.from({ length: 10 }, (_, i) => ({
  version: `1.0.${9 - i}`, date: '2026-09-27',
  summary: `更新内容${i}`, points: [`変更点${i}`],
}));

function runPage(language, count, markup = html, script = source, messages) {
  const document = parse(markup);
  const context = { document, YWH_WHATSNEW: releases.slice(0, count) };
  if (language !== 'noChrome') {
    context.chrome = { runtime: { getManifest: () => ({ version: '2.3.4' }) } };
    if (language !== 'noI18n') context.chrome.i18n = {
      getUILanguage: () => language,
      getMessage(key, args = []) {
        const entry = (messages || (language.startsWith('en') ? en : ja))[key];
        if (!entry) return '';
        return entry.message.replace(/\$([\w]+)\$/g, (_, name) => {
          const content = entry.placeholders[name.toLowerCase()].content;
          return content.replace(/\$(\d+)/g, (__, n) => args[Number(n) - 1]);
        });
      },
    };
  }
  vm.runInNewContext(script, context);
  return document;
}

function normalized(document) {
  return textOf(document.root).replace(/\s+/g, ' ').trim();
}

function verify() {
  assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort(), 'locale key sets differ');
  for (const [key, value] of Object.entries(en)) {
    assert(!japanese.test(value.message), `Japanese in English message: ${key}`);
  }
  const initial = parse(html);
  for (const element of initial.elements) {
    const key = element.attrs['data-i18n'];
    if (!key) continue;
    assert(key.startsWith('whatsnew_') && ja[key] && en[key], `missing whatsnew key: ${key}`);
    assert.strictEqual(element.textContent.trim(), ja[key].message, `Japanese fallback: ${key}`);
  }

  const guide = require('../whatsnew.js');
  // SHA-256 of the original GUIDE at lane-3 entry; guards every word and its order.
  assert.strictEqual(digest(JSON.stringify(guide.GUIDE)), '6d82751fd89a32f592d400374d974a68326db24819a17b8901e93058716f0207');
  assert.strictEqual(guide.GUIDE_EN.length, guide.GUIDE.length);
  for (const item of guide.GUIDE_EN) {
    assert(!japanese.test(JSON.stringify(item)), `Japanese in English GUIDE: ${item.task}`);
    for (const label of item.uiText) {
      assert([item.task, item.where, ...item.steps, item.caution || ''].some(s => s.includes(label)),
        `English uiText is not quoted in its guide: ${label}`);
    }
  }

  // Visible text snapshots captured from the unmodified HTML + renderer, with the
  // same fixtures. Normalize whitespace only; retain wording, punctuation, order.
  const baseline = {
    noChrome: {
      0: 'fa524f717927b447844bcb1b6379edcb3138826d89fe1c7c4ef15b0536ad70ab',
      1: 'ba1a31285dbd01d8e6edec7e100982bd6c4141608c2a331301197f73df446503',
      8: '49c6c6fcb40549749072e8cd0dc5584415bdcf3395a62fb066f8d4a8e0bba508',
      9: 'ccf12e5aabd9920dc79c29f3a2f29f906d31c835f3dbc545f0f98c03ab9291b9',
      10: '00312cc2a83d4c07be5edebb2e78bff9f6b86788c59d81cd2c9fc887f381cf5f',
    },
    ja: {
      0: 'ba8988af83a4abb900fb4b5dc5a31975e8cb1a5a78541dca559a77eb9539628c',
      1: '0783a79c70c47beb4b2d95afafd4777fdc1b5e4150f361af20dc155c148939e8',
      8: 'b0aedd18dca1731798d2db57b52bd69fe071147bdfa8ea2be05289798327d621',
      9: '85e969f90eb500e9da1c15571762fc06d0de9cbcc08ef540cd1e83eae26df720',
      10: '9f204be769f98814b22d5d4c758d57c924a637e3948f52858135fb2d7af45c0c',
    },
  };
  for (const language of ['noChrome', 'noI18n', 'ja', 'ja-JP']) {
    for (const count of [0, 1, 8, 9, 10]) {
      const doc = runPage(language, count);
      const family = language === 'noChrome' ? 'noChrome' : 'ja';
      assert.strictEqual(digest(normalized(doc)), baseline[family][count], `${language}/${count}: Japanese display changed`);
      assert(doc.getElementById('releaseLanguageNote').hidden);
      assert.strictEqual(doc.documentElement.lang, 'ja');
    }
  }
  // Missing translation keys must retain the original Japanese fallbacks.
  assert.strictEqual(normalized(runPage('ja', 10, html, source, {})), normalized(runPage('ja', 10)));

  // Check static text before the renderer replaces loading/summary fallbacks.
  const staticContext = vm.createContext({
    document: parse(html), module: { exports: {} },
    chrome: { i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message || '' } },
  });
  vm.runInContext(source, staticContext);
  vm.runInContext('applyStaticWhatsnewI18n()', staticContext);
  assert(!japanese.test(textOf(staticContext.document.root, { includeHidden: true })),
    'untranslated initial static text');

  for (const language of ['en', 'en-US', 'en-GB']) {
    for (const count of [0, 1, 8, 9, 10]) {
      const doc = runPage(language, count);
      assert.strictEqual(doc.documentElement.lang, 'en');
      assert(!japanese.test(textOf(doc.root, { includeHidden: true, omitReleaseBodies: true })),
        `${language}/${count}: untranslated page text`);
      const note = doc.getElementById('releaseLanguageNote');
      assert.strictEqual(note.hidden, false);
      assert.strictEqual(note.textContent, 'Release notes are available in Japanese only.');
      for (const element of doc.elements) {
        for (const attr of ['title', 'placeholder', 'aria-label']) {
          assert(!japanese.test(element.attrs[attr] || ''), `untranslated ${attr}`);
        }
      }
      assert.strictEqual(doc.getElementById('features').children.length, guide.GUIDE_EN.length);
      assert.strictEqual(doc.getElementById('currentVersion').textContent, 'v2.3.4');
      const recent = doc.getElementById('recent');
      if (count === 0) assert.strictEqual(recent.textContent, 'Could not load release notes.');
      else {
        const date = new Date('2026-09-27T00:00:00Z').toLocaleDateString(language,
          { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
        assert.strictEqual(recent.children[0].children[0].children[1].textContent, date);
        assert.strictEqual(recent.children[0].children[1].textContent, releases[0].summary);
        assert.strictEqual(recent.children[0].children[2].children[0].textContent, releases[0].points[0]);
      }
      if (count > 8) {
        assert.strictEqual(doc.getElementById('olderSummary').textContent,
          `Show ${count - 8} older release${count === 9 ? '' : 's'}`);
        assert.strictEqual(doc.getElementById('older').children[0].children[1].textContent, releases[8].summary);
      }
      assert.strictEqual(doc.getElementById('olderWrap').hidden, count <= 8);
    }
  }
  console.log('PASS whatsnew i18n: static coverage, English GUIDE, ja snapshots, fallbacks, locale keys, release prose, dates, pluralization (35 render scenarios)');
}

if (require.main === module) verify();
module.exports = { runPage, normalized, digest };
