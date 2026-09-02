'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CATEGORY,
  MODE,
  normalizeText,
  matchCreditAliases,
  normalizeChannelPath,
  isTopicChannel,
  isSameChannel,
  matchProfileForQuery,
  classifyChannel,
  shouldShowCategory,
} = require('../official_search_filter_core.js');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const settings = {
  schemaVersion: 1,

  profiles: {
    fox: {
      id: 'fox',
      displayName: 'fox capture plan',

      aliases: [
        'フォックス・キャプチャー・プラン',
        'fox capture plan',
      ],

      channels: [
        {
          channelId: 'UC_OFFICIAL',
          canonicalPath: '/@foxcaptureplan',
          displayName: 'fox capture plan',
          enabled: true,
        },
        {
          channelId: 'UC_TOPIC',
          canonicalPath: '/channel/UC_TOPIC',
          displayName: 'fox capture plan - Topic',
          enabled: true,
        },
      ],
    },

    fox_long: {
      id: 'fox_long',
      displayName: 'fox capture plan orchestra',

      aliases: [
        'fox capture plan orchestra',
      ],

      channels: [],
    },
  },

  queryBindings: {
    'fox capture plan - topic': 'fox',
  },
};

test(
  'normalizeText: 全角英数字・大小文字・空白を正規化',
  () => {
    assert.strictEqual(
      normalizeText(' ＦＯＸ   Capture PLAN '),
      'fox capture plan'
    );
  }
);

test(
  'matchCreditAliases: 漢字名2名を「・」で分割',
  () => {
    assert.deepStrictEqual(
      matchCreditAliases(
        '田中太郎・鈴木花子',
        ['田中太郎', '鈴木花子']
      ),
      ['田中太郎', '鈴木花子']
    );
  }
);

test(
  'matchCreditAliases: カタカナ名の「・」は分割しない',
  () => {
    assert.deepStrictEqual(
      matchCreditAliases(
        'ジャン・ピエール',
        ['ジャン', 'ピエール', 'ジャン・ピエール']
      ),
      ['ジャン・ピエール']
    );
  }
);

test(
  'matchCreditAliases: 既存の「、」「／」「&」区切りを維持',
  () => {
    assert.deepStrictEqual(
      matchCreditAliases(
        '田中太郎、鈴木花子／佐藤一郎 & 高橋二郎',
        ['田中太郎', '鈴木花子', '佐藤一郎', '高橋二郎']
      ),
      ['田中太郎', '鈴木花子', '佐藤一郎', '高橋二郎']
    );
  }
);

test(
  'normalizeChannelPath: URLをpathへ正規化',
  () => {
    assert.strictEqual(
      normalizeChannelPath(
        'https://www.youtube.com/@FoxCapturePlan/?view=0'
      ),
      '/@foxcaptureplan'
    );
  }
);

test(
  'isTopicChannel: fox capture plan - Topic',
  () => {
    assert.strictEqual(
      isTopicChannel(
        'fox capture plan - Topic'
      ),
      true
    );
  }
);

test(
  'isTopicChannel: Release - Topic',
  () => {
    assert.strictEqual(
      isTopicChannel('Release - Topic'),
      true
    );
  }
);

test(
  'isTopicChannel: OfficialをTopicと誤判定しない',
  () => {
    assert.strictEqual(
      isTopicChannel(
        'fox capture plan Official'
      ),
      false
    );
  }
);

test(
  'isSameChannel: channelId一致',
  () => {
    assert.strictEqual(
      isSameChannel(
        {
          channelId: 'UC_A',
          canonicalPath: '/@old',
        },
        {
          channelId: 'UC_A',
          canonicalPath: '/@new',
        }
      ),
      true
    );
  }
);

test(
  'isSameChannel: IDが異なる場合はpath一致でもfalse',
  () => {
    assert.strictEqual(
      isSameChannel(
        {
          channelId: 'UC_A',
          canonicalPath: '/@same',
        },
        {
          channelId: 'UC_B',
          canonicalPath: '/@same',
        }
      ),
      false
    );
  }
);

test(
  'isSameChannel: IDがない場合はcanonical path',
  () => {
    assert.strictEqual(
      isSameChannel(
        {
          canonicalPath:
            'https://www.youtube.com/@FoxCapturePlan/',
        },
        {
          canonicalPath:
            '/@foxcaptureplan',
        }
      ),
      true
    );
  }
);

test(
  'matchProfileForQuery: queryBindingを優先',
  () => {
    assert.strictEqual(
      matchProfileForQuery(
        settings,
        'FOX CAPTURE PLAN - TOPIC'
      ).id,
      'fox'
    );
  }
);

test(
  'matchProfileForQuery: エイリアス完全一致',
  () => {
    assert.strictEqual(
      matchProfileForQuery(
        settings,
        'フォックス・キャプチャー・プラン'
      ).id,
      'fox'
    );
  }
);

test(
  'matchProfileForQuery: 最長エイリアス優先',
  () => {
    assert.strictEqual(
      matchProfileForQuery(
        settings,
        'fox capture plan orchestra live'
      ).id,
      'fox_long'
    );
  }
);

test(
  'matchProfileForQuery: 未検出',
  () => {
    assert.strictEqual(
      matchProfileForQuery(
        settings,
        'unrelated artist'
      ),
      null
    );
  }
);

test(
  'classifyChannel: 登録済みはofficial',
  () => {
    assert.strictEqual(
      classifyChannel({
        profile: settings.profiles.fox,

        channel: {
          channelId: 'UC_TOPIC',
          displayName:
            'fox capture plan - Topic',
        },
      }),
      CATEGORY.OFFICIAL
    );
  }
);

test(
  'classifyChannel: クレジット一致はcredit-related',
  () => {
    assert.strictEqual(
      classifyChannel({
        profile: settings.profiles.fox,

        channel: {
          channelId: 'UC_OTHER',
          displayName:
            'Another Artist - Topic',
        },

        hasRelatedCredit: true,
      }),
      CATEGORY.CREDIT_RELATED
    );
  }
);

test(
  'classifyChannel: 未登録Topicはother-topic',
  () => {
    assert.strictEqual(
      classifyChannel({
        profile: settings.profiles.fox,

        channel: {
          channelId: 'UC_RELEASE',
          displayName:
            'Release - Topic',
        },
      }),
      CATEGORY.OTHER_TOPIC
    );
  }
);

test(
  'classifyChannel: 一般チャンネルはother',
  () => {
    assert.strictEqual(
      classifyChannel({
        profile: settings.profiles.fox,

        channel: {
          channelId: 'UC_FAN',
          displayName:
            'fan upload channel',
        },
      }),
      CATEGORY.OTHER
    );
  }
);

test(
  'classifyChannel: チャンネル未描画はpending',
  () => {
    assert.strictEqual(
      classifyChannel({
        profile: settings.profiles.fox,
        channel: null,
      }),
      CATEGORY.PENDING
    );
  }
);

const categories = Object.values(CATEGORY);

test(
  'officialモードの表示マトリクス',
  () => {
    const visible = categories.filter(
      (category) =>
        shouldShowCategory(
          category,
          MODE.OFFICIAL
        )
    );

    assert.deepStrictEqual(
      visible.sort(),
      [
        CATEGORY.OFFICIAL,
        CATEGORY.CREDIT_RELATED,
        CATEGORY.PENDING,
      ].sort()
    );
  }
);

test(
  'discoveryモードの表示マトリクス',
  () => {
    const visible = categories.filter(
      (category) =>
        shouldShowCategory(
          category,
          MODE.DISCOVERY
        )
    );

    assert.deepStrictEqual(
      visible.sort(),
      [
        CATEGORY.OFFICIAL,
        CATEGORY.CREDIT_RELATED,
        CATEGORY.OTHER_TOPIC,
        CATEGORY.PENDING,
      ].sort()
    );
  }
);

test(
  'allモードは全分類を表示',
  () => {
    assert.strictEqual(
      categories.every(
        (category) =>
          shouldShowCategory(
            category,
            MODE.ALL
          )
      ),
      true
    );
  }
);

async function verifyCreditLookupFailure() {
  const settingsTestPath = path.join(
    __dirname,
    'verify_official_search_filter_settings.js'
  );
  const settingsSource = fs.readFileSync(settingsTestPath, 'utf8');
  const helperSource = settingsSource.slice(
    0,
    settingsSource.lastIndexOf('\nasync function main() {')
  );
  const helpers = new Function(
    'require',
    '__dirname',
    `${helperSource}\nreturn { createStorageStub, boundSettings, makeRuntime, panel, settle };`
  )(require, __dirname);

  const successfulStorage = helpers.createStorageStub(
    helpers.boundSettings('official')
  );
  successfulStorage.chrome.runtime.sendMessage = (_message, callback) => {
    callback({ success: true, result: {} });
  };
  const successfulRuntime = helpers.makeRuntime(successfulStorage);
  await helpers.settle();
  await helpers.settle();
  const successfulPanel = helpers.panel(successfulRuntime);
  assert.match(
    successfulPanel.querySelector('[data-credit-candidate-list]').textContent,
    /未登録候補はありません/
  );
  successfulRuntime.context._ywhOfficialSearchFilter.cleanup();

  const failedStorage = helpers.createStorageStub(
    helpers.boundSettings('official')
  );
  failedStorage.chrome.runtime.sendMessage = (_message, callback) => {
    callback({ success: false, error: 'database unavailable' });
  };
  const failedRuntime = helpers.makeRuntime(failedStorage);
  try {
    await helpers.settle();
    await helpers.settle();
    const failedPanel = helpers.panel(failedRuntime);
    const status = failedPanel.querySelector('#ywh-osf-management-status');
    assert.strictEqual(status.dataset.status, 'error');
    assert.match(status.textContent, /候補を照会できませんでした/);
    assert.match(status.textContent, /database unavailable/);
    assert.doesNotMatch(
      failedPanel.querySelector('[data-credit-candidate-list]').textContent,
      /未登録候補はありません/
    );
    console.log('✓ DB/RPC失敗を候補0件と区別してエラー表示');
  } finally {
    failedRuntime.context._ywhOfficialSearchFilter.cleanup();
  }
}

verifyCreditLookupFailure()
  .then(() => {
    console.log('\nAll official search filter tests passed.');
  })
  .catch((error) => {
    console.error('✗ DB/RPC失敗時の回帰テスト');
    console.error(error);
    process.exitCode = 1;
  });
