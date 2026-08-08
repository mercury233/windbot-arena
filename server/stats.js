'use strict';

function calculateStats(raw) {
    const win = Number(raw?.win) || 0;
    const lose = Number(raw?.lose) || 0;
    const flee = Number(raw?.flee) || 0;
    const combo = Number(raw?.combo) || 0;
    // SRVPro 在异常断开时独立累加 flee，它不是与胜负互斥的第三种赛果。
    const games = win + lose;
    return {
        combo,
        flee,
        games,
        lose,
        win,
    };
}

function normalizeRank(rank) {
    if (!Array.isArray(rank)) {
        throw new Error('rank 不是数组');
    }
    return rank.map((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            throw new Error(`rank[${index}] 不是 [名称, 统计]`);
        }
        if (!entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) {
            throw new Error(`rank[${index}] 的统计不是对象`);
        }
        return [entry[0], calculateStats(entry[1])];
    });
}

module.exports = { calculateStats, normalizeRank };
