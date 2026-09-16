/* ===== items.js — 六種道具與橡皮筋分配 =====
 * 效果的實際套用在 rules.js；這裡只負責「有哪些道具」與「誰抽到什麼」。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Items = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ITEMS = {
    juice: {
      id: 'juice', name: '果汁加速', kind: 'good', color: '#FF9E3D',
      hint: '喝一口就衝出去，3 秒內變快而且不怕減速地形。',
      duration: 3.0, power: 0.55
    },
    shield: {
      id: 'shield', name: '泡泡護盾', kind: 'good', color: '#7FD8F5',
      hint: '6 秒內幫你擋掉一次壞道具，擋下來泡泡就破掉。',
      duration: 6.0
    },
    hop: {
      id: 'hop', name: '葉子小飛', kind: 'good', color: '#8FD14F',
      hint: '踩著葉子飄 1.2 秒，泥巴、草地、黏液通通踩不到你。',
      duration: 1.2
    },
    goo: {
      id: 'goo', name: '黏黏點點', kind: 'bad', color: '#B57BD8',
      hint: '在身後留下三攤黏液，後面的人踩到會黏住 1.5 秒。',
      duration: 1.5, power: 0.5, blobs: 3, life: 14
    },
    web: {
      id: 'web', name: '蜘蛛絲', kind: 'bad', color: '#C9CFD8',
      hint: '朝前面最近的人射出蜘蛛絲，黏到的人慢 1.2 秒，你自己往前竄一小段。',
      duration: 1.2, power: 0.55, range: 900, pull: 0.35
    },
    tiny: {
      id: 'tiny', name: '縮小咒', kind: 'bad', color: '#F06292',
      hint: '讓現在的第一名縮小 4 秒，變小就跑不快了。',
      duration: 4.0, power: 0.25
    }
  };

  const ALL = Object.keys(ITEMS);
  const GOOD = ALL.filter(id => ITEMS[id].kind === 'good');

  /* 名次越後面越容易抽到強力道具，讓落後的人還有戲唱（規劃書 §4.2） */
  const TABLE = {
    lead:   { juice: 10, shield: 30, hop: 15, goo: 40, web: 5,  tiny: 0 },
    middle: { juice: 25, shield: 20, hop: 20, goo: 15, web: 15, tiny: 5 },
    back:   { juice: 30, shield: 10, hop: 15, goo: 5,  web: 20, tiny: 20 }
  };

  /**
   * 抽一個道具。
   * @param {object} rng   rng.js 產生的亂數（可注入 seed）
   * @param {number} rank  名次，1 是第一名
   * @param {number} total 場上人數
   * @param {boolean} allowBad 是否允許負面道具（幼幼班或設定關閉時為 false）
   */
  function draw(rng, rank, total, allowBad) {
    let band = 'middle';
    if (rank <= 1) band = 'lead';
    else if (total > 2 && rank > total - Math.max(1, Math.floor(total / 3))) band = 'back';

    const weights = TABLE[band];
    const pool = [];
    for (const id of ALL) {
      if (!allowBad && ITEMS[id].kind === 'bad') continue;
      const w = weights[id];
      if (w > 0) pool.push({ v: id, w: w });
    }
    /* 關掉負面道具又剛好整排權重為 0（第一名）時，退回三種好道具平均抽 */
    if (!pool.length) for (const id of GOOD) pool.push({ v: id, w: 1 });
    return rng.weighted(pool);
  }

  return { ITEMS, ALL, GOOD, TABLE, draw };
});
