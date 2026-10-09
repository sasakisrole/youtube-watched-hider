// A limited enrichment run spends its slots on videos that can still produce a
// result; videos in MusicBrainz cooldown only fill what is left.
// Run: node tests/verify_enrich_credits_cooldown_slots.js
const fs = require('fs');
const path = require('path');
const CreditTarget = require(path.join(__dirname, '..', 'credit_target.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');

const window = { CreditTarget };
const document = { createElement: () => ({}), getElementById: () => null, addEventListener() {} };
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'chrome', 'fetch', src)(window, document, {}, async () => ({}));
const hooks = window.EnrichCreditsTestHooks;

let pass = 0, fail = 0;
function check(name, ok) { if (ok) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } }

const now = Date.UTC(2026, 9, 9);
function video(id, channel, cooled) {
  const record = { videoId: id, title: 'Song ' + id, channel, composer: 'Someone', lyricist: '', arranger: 'Someone', creditsRaw: 'hint' };
  if (cooled) {
    record.mbLookup = { status: 'no-roles', checkedAt: now - 1000, nextEligibleAt: now + 86400000,
      queryFingerprint: CreditTarget.mbQueryFingerprint(CreditTarget.stripTopicChannelSuffix(channel), record.title),
      missingRoles: ['lyricist'], attempts: 0 };
  }
  return record;
}
const big = Array.from({ length: 5 }, (_, i) => video('cool' + i, 'Big - Topic', true));
const small = [video('due1', 'Small - Topic', false), video('due2', 'Small - Topic', false)];
const groups = new Map([['Big - Topic', big], ['Small - Topic', small]]);
const due = hooks.createMbDueCheck(null, false, now);

check('cooled videos are not due and fresh ones are', !due('Big - Topic', big[0]) && due('Small - Topic', small[0]));
const limited = hooks.limitEnrichmentGroupsByDue(groups, 3, due);
check('a limit is spent on due videos before cooled ones',
  JSON.stringify(Array.from(limited.entries()).map(([c, v]) => [c, v.map((r) => r.videoId)]))
    === JSON.stringify([['Big - Topic', ['cool0']], ['Small - Topic', ['due1', 'due2']]]));
check('an unlimited run keeps every video in the original order', hooks.limitEnrichmentGroupsByDue(groups, null, due) === groups);
check('a rule channel always counts as due', hooks.createMbDueCheck(new Set(['Big - Topic']), false, now)('Big - Topic', big[0]));
check('ignoring the cooldown makes cooled videos due', hooks.createMbDueCheck(null, true, now)('Big - Topic', big[0]));
const withRole = { ...big[0], arranger: '' };
check('a newly missing role makes a cooled video due again', due('Big - Topic', withRole));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
