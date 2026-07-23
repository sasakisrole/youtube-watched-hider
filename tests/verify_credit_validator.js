// Regression verification for W7GG credit validation / parser hardening.
// Run: node tests/verify_credit_validator.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CT = require(path.join(ROOT, 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function loadParser() {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const start = source.indexOf('function cleanCreditLine');
  const end = source.indexOf('async function fetchCreditsFromWatch', start);
  if (start < 0 || end < 0) throw new Error('credit parser block not found');
  const block = source.slice(start, end);
  return new Function('self', `${block}\nreturn { parseCreditsFromDescription, cleanCreditLine };`)({ CreditTarget: CT });
}

function loadAnalyzerValidator() {
  const source = fs.readFileSync(path.join(ROOT, 'analyzer.js'), 'utf8');
  const match = source.match(/  function isCleanCreditName\(name\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error('isCleanCreditName not found');
  return new Function('window', `${match[0]}\nreturn isCleanCreditName;`)({ CreditTarget: CT });
}

function makeFakeIndexedDb(record) {
  const db = {
    transaction() {
      const tx = {};
      const store = {
        get() {
          const request = {};
          setImmediate(() => {
            request.result = record;
            if (request.onsuccess) request.onsuccess();
            setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
          });
          return request;
        },
        put(value) { Object.assign(record, value); },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  return {
    open() {
      const request = {};
      setImmediate(() => {
        request.result = db;
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
  };
}

async function verifyDbBoundary() {
  const record = {
    videoId: 'db-boundary',
    composer: 'Existing Composer',
    lyricist: '',
    arranger: '',
    creditsRaw: '',
  };
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const fakeGlobal = { CreditTarget: CT };
  const watchedDb = new Function('indexedDB', 'globalThis', `${dbSource}\nreturn WatchedDB;`)(makeFakeIndexedDb(record), fakeGlobal);
  const didUpdate = await watchedDb.updateCredits('db-boundary', {
    composer: '//www.youtube.com/playlist?list=bad',
    lyricist: 'Calliope Mori',
    arranger: 'Copyright Control',
    creditsRaw: 'Song · LITE',
  }, true, 'topic');
  check('DB save boundary updates at least one valid field', didUpdate === true);
  check('DB save boundary rejects invalid composer even with force', record.composer === 'Existing Composer');
  check('DB save boundary accepts valid blank lyricist', record.lyricist === 'Calliope Mori');
  check('DB save boundary rejects rights placeholder arranger', record.arranger === '');
  check('DB save boundary preserves Topic evidence in creditsRaw', record.creditsRaw === 'Song · LITE');
  const secondUpdate = await watchedDb.updateCredits('db-boundary', {
    composer: 'New Person',
  }, true, 'general');
  check('DB keeps existing non-empty role even with force', record.composer === 'Existing Composer');
  check('DB reports no update when only an existing role was offered', secondUpdate === false);
  check('DB keeps existing source when no role was updated', record.creditsSource === 'topic');
}

async function run() {
  console.log('isValidCreditValue');
  const rejected = [
    '//bit.ly/credit',
    '//www.youtube.com/playlist?list=bad',
    '//music.apple.com/jp/album/example',
    'www.example.com/credits',
    'bit.ly',
    't.co/credit',
    'music.apple.com/album/example',
    'youtube.com/playlist?list=bad',
    '@handle_only',
    'Copyright Control',
    'Copyright Control, toe',
    'All Rights Reserved',
    '中恵 光城 Compose/Arrange：RD-Sounds',
    'Lyrics: Alice',
    'Reboot"',
    'A'.repeat(61),
    'Alice\u0007Bob',
    'Alice\n',
    '////',
    { name: 'Alice' },
  ];
  rejected.forEach((value) => check(`reject ${JSON.stringify(value)}`, CT.isValidCreditValue(value) === false));
  ['Alice', 'RD-Sounds', 'Calliope Mori', '織田あすか (Elements Garden)', '藤永龍太郎'].forEach((value) => {
    check(`accept ${JSON.stringify(value)}`, CT.isValidCreditValue(value) === true);
  });

  console.log('Topic channel helpers');
  check('English Topic is recognized case-insensitively', CT.isTopicChannelName('  Artist - tOpIc  ') === true);
  check('Japanese Topic is recognized', CT.isTopicChannelName('バンド - トピック') === true);
  check('NFKC full-width Topic suffix is recognized', CT.isTopicChannelName('Ａｒｔｉｓｔ － Ｔｏｐｉｃ') === true);
  check('ordinary channel is not Topic', CT.isTopicChannelName('Artist Official') === false);
  check('English Topic suffix is stripped', CT.stripTopicChannelSuffix(' Artist - Topic ') === 'Artist');
  check('Japanese Topic suffix is stripped', CT.stripTopicChannelSuffix(' バンド - トピック ') === 'バンド');

  const { parseCreditsFromDescription } = loadParser();
  console.log('description parser');
  let parsed = parseCreditsFromDescription('作詞：Alice 作曲・編曲：Bob');
  check('multi-label Japanese line splits all roles', eq(parsed, {
    composer: 'Bob', lyricist: 'Alice', arranger: 'Bob', creditsRaw: '',
  }));

  parsed = parseCreditsFromDescription('Lyrics: A / Compose & Arrange: B');
  check('multi-label English line splits around slash', eq(parsed, {
    composer: 'B', lyricist: 'A', arranger: 'B', creditsRaw: '',
  }));

  parsed = parseCreditsFromDescription('Words & Music: A');
  check('Words & Music fills composer and lyricist', parsed.composer === 'A' && parsed.lyricist === 'A' && parsed.arranger === '');
  parsed = parseCreditsFromDescription('作曲・編曲：X');
  check('作曲・編曲 fills two roles', parsed.composer === 'X' && parsed.arranger === 'X');
  parsed = parseCreditsFromDescription('作編曲：X');
  check('作編曲 fills two roles', parsed.composer === 'X' && parsed.arranger === 'X');
  parsed = parseCreditsFromDescription('Compose & Arrange: X');
  check('Compose & Arrange fills two roles', parsed.composer === 'X' && parsed.arranger === 'X');

  const pollutedLines = [
    'Composer: //bit.ly/credit',
    'Lyrics: //www.youtube.com/playlist?list=bad',
    'Arrange: //music.apple.com/jp/album/example',
    'Composer: www.example.com/credits',
    'Composer: @handle_only',
    'Composer: Copyright Control',
    'Lyrics: All Rights Reserved',
    `Composer: ${'A'.repeat(61)}`,
    'Composer: Reboot"',
  ];
  pollutedLines.forEach((line) => {
    const value = parseCreditsFromDescription(line);
    check(`parser rejects ${JSON.stringify(line)}`, !value.composer && !value.lyricist && !value.arranger);
  });

  parsed = parseCreditsFromDescription([
    'Music Video: Directed by Alice',
    'Music: Listen here on Spotify',
    'Author: Alice',
  ].join('\n'));
  check('broad Music/Author labels do not create credits', !parsed.composer && !parsed.lyricist && !parsed.arranger);

  parsed = parseCreditsFromDescription('Provided to YouTube by Example\nSong · LITE · LITE');
  check('Topic repeated name stays raw-only', eq(parsed, {
    composer: '', lyricist: '', arranger: '', creditsRaw: 'LITE',
  }));
  parsed = parseCreditsFromDescription('Provided to YouTube by Example\nInstrumental · Singer · Singer');
  check('Instrumental Topic does not infer a lyricist', parsed.lyricist === '' && parsed.composer === '' && parsed.arranger === '' && parsed.creditsRaw === 'Singer');

  console.log('§5.3 valid explicit-label regressions');
  const validFixtures = [
    ['RAISE A SUILEN / Roselia', '作詞：織田あすか (Elements Garden)', 'lyricist', '織田あすか (Elements Garden)'],
    ['夏川椎菜', 'Composed by: 山田竜平', 'composer', '山田竜平'],
    ['MyGO!!!!!', '編曲：長谷川大介', 'arranger', '長谷川大介'],
    ['Calliope Mori', 'Lyrics: Calliope Mori', 'lyricist', 'Calliope Mori'],
    ['BLACK SHOUT', '作曲：上松範康 (Elements Garden)', 'composer', '上松範康 (Elements Garden)'],
    ['THE FIRST TAKE', 'Arranged by: Tatsuya Shibata', 'arranger', 'Tatsuya Shibata'],
  ];
  validFixtures.forEach(([label, description, role, expected]) => {
    check(`${label} explicit ${role} remains accepted`, parseCreditsFromDescription(description)[role] === expected);
  });

  const isCleanCreditName = loadAnalyzerValidator();
  console.log('Analyzer boundary');
  ['//www.youtube.com/x', 'www.example.com/x', 'bit.ly', 'Copyright Control', '作曲：Alice', 'Compose & Arrange: Bob'].forEach((value) => {
    check(`Analyzer rejects ${JSON.stringify(value)}`, isCleanCreditName(value) === false);
  });
  check('Analyzer accepts a clean credit name', isCleanCreditName('藤永龍太郎') === true);

  console.log('shared validator wiring');
  const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const analyzerSource = fs.readFileSync(path.join(ROOT, 'analyzer.js'), 'utf8');
  check('parser calls shared validator', backgroundSource.includes('self.CreditTarget.isValidCreditValue(valuePart)'));
  check('DB calls shared validator', dbSource.includes('globalThis.CreditTarget.isValidCreditValue(v)'));
  check('Analyzer calls shared validator', analyzerSource.includes('window.CreditTarget.isValidCreditValue(name)'));
  check('service worker loads shared utility', backgroundSource.includes("importScripts('credit_target.js')"));
  const offscreenSource = fs.readFileSync(path.join(ROOT, 'offscreen.html'), 'utf8');
  check('offscreen loads shared utility before DB', offscreenSource.indexOf('credit_target.js') < offscreenSource.indexOf('db.js'));

  await verifyDbBoundary();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
