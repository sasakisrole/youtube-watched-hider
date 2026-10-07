(function (root) {
  'use strict';
  // An exact video and previously observed value are required: remix credits
  // must never be inferred from the original song or from the remixer's name.
  var rules = [
    { videoId: 'KMvTTyBRffk', role: 'composer', before: "Banbado (Shiron Dub'n'Bado Remix)", value: 'mozell', url: 'https://mozeen.com/music/banbards/' },
    { videoId: 'L0KM98yjqZo', role: 'composer', before: 'Battle of Marion(ISK "Meteorite" Remix)', value: 'mozell', url: 'https://mozeen.com/music/battle_of_zakuaku/' },
    { videoId: 'XGpzjurA0ug', role: 'composer', before: '闇の彼方 (mozell remix)/Beyond Darkness (mozell remix)', value: 'zookun', url: 'https://www.youtube.com/watch?v=XGpzjurA0ug' },
    { videoId: 'rXcPRKriVsI', role: 'composer', before: 'ryo (supercell),藤原基央', value: 'ryo (supercell)', url: 'https://piapro.jp/t/xKGs' },
    { videoId: 'rXcPRKriVsI', role: 'lyricist', before: 'ryo (supercell),藤原基央', value: 'ryo (supercell)', url: 'https://piapro.jp/t/xKGs' },
    { videoId: 'rXcPRKriVsI', role: 'arranger', before: 'TAKU INOUE', value: 'ryo (supercell)', url: 'https://piapro.jp/t/xKGs' },
  ].map(function (rule) { return Object.freeze(rule); });
  Object.freeze(rules);

  function candidates(records, creditTarget) {
    var byId = new Map((records || []).map(function (record) { return [record.videoId, record]; }));
    return rules.filter(function (rule) {
      var record = byId.get(rule.videoId);
      return record && record[rule.role] === rule.before
        && creditTarget.effectiveRoleSource(record, rule.role) !== 'manual';
    }).map(function (rule) {
      return { videoId: rule.videoId, role: rule.role, value: rule.value,
        source: 'verified-correction', sourceDetail: rule.url, selected: false };
    });
  }

  var api = { rules: rules, candidates: candidates };
  if (root) root.CreditCorrections = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
