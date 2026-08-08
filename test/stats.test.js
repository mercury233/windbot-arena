'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateStats, normalizeRank } = require('../server/stats');

test('calculateStats normalizes the raw SRVPro counters', () => {
    assert.deepEqual(calculateStats({ combo: 3, flee: 1, lose: 2, win: 7 }), {
        combo: 3,
        flee: 1,
        games: 10,
        lose: 2,
        win: 7,
    });
});

test('normalizeRank validates and normalizes ranking tuples', () => {
    const rank = normalizeRank([['新-Dragon', { flee: '1', lose: 2, win: 4 }]]);
    assert.equal(rank[0][0], '新-Dragon');
    assert.equal(rank[0][1].games, 7);
    assert.throws(() => normalizeRank([{ name: 'invalid' }]), /不是 \[名称, 统计\]/);
});
