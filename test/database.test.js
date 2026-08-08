'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ArenaDatabase } = require('../server/database');
const { normalizeRank } = require('../server/stats');

test('ArenaDatabase persists a run and applies rank statistics', (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbot-arena-db-'));
    const database = new ArenaDatabase(path.join(tempDir, 'arena.sqlite'));
    context.after(() => {
        database.close();
        fs.rmSync(tempDir, { force: true, recursive: true });
    });

    const settingsRecord = database.getArenaSettings();
    settingsRecord.settings.srvpro.host = 'srvpro.lan';
    database.saveArenaSettings(settingsRecord.settings);
    assert.equal(database.getArenaSettings().settings.srvpro.host, 'srvpro.lan');

    database.createRun({
        config: { duelServer: '127.0.0.1:7911' },
        createdAt: '2026-08-08T00:00:00.000Z',
        gamesPerMatchup: 10,
        id: 'run-1',
        kind: 'regression',
        matchups: [{
            aiLevel: 4,
            competitors: [
                {
                    botLabel: 'Dragon',
                    deck: 'Dragon',
                    dialog: null,
                    endpointHost: '127.0.0.1',
                    endpointPort: 2399,
                    executionMode: 'local',
                    rankName: '新-Dragon',
                    slot: 1,
                    source: 'current',
                },
                {
                    botLabel: 'Legacy Dragon',
                    deck: 'Dragon',
                    dialog: null,
                    endpointHost: 'windbot-old.lan',
                    endpointPort: 2398,
                    executionMode: 'remote',
                    rankName: '旧-Dragon',
                    slot: 2,
                    source: 'old',
                },
            ],
            label: 'Dragon',
        }],
    });
    const rawRank = [
        ['新-Dragon', { flee: 1, lose: 2, win: 7 }],
        ['旧-Dragon', { flee: 0, lose: 7, win: 3 }],
    ];
    database.recordRank('run-1', normalizeRank(rawRank), rawRank);
    database.addEvent('run-1', 'info', 'legacy-wording', '已创建 1 个对局组');
    const run = database.getRun('run-1');

    assert.equal(run.matchups[0].observedGames, 9);
    assert.equal(run.matchups[0].aiLevel, 4);
    assert.equal(run.matchups[0].competitors[1].endpointHost, 'windbot-old.lan');
    assert.equal(run.matchups[0].currentWinRate, 0.7);
    assert.equal(run.status, 'preparing');
    assert.equal(run.startedAt, null);
    assert.equal(run.events.at(-1).message, '已创建 1 个卡组');
    assert.equal(database.listRuns()[0].deckName, 'Dragon');
    assert.equal(database.listRuns()[0].matchupCount, 1);
    database.createRun({
        config: {},
        createdAt: '2026-08-08T01:00:00.000Z',
        gamesPerMatchup: 0,
        id: 'run-2',
        kind: 'ranking',
        matchups: [],
    });
    assert.equal(database.getRunCount(), 2);
    assert.equal(database.listRuns(1, 0)[0].id, 'run-2');
    assert.equal(database.listRuns(1, 1)[0].id, 'run-1');
    const unmatchedRankAt = database.recordRank(null, normalizeRank(rawRank), rawRank);
    assert.equal(database.getLatestRankAt(), unmatchedRankAt);

    const indexes = database.db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name);
    assert.ok(indexes.includes('idx_matchups_run_id'));
    const plan = database.db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT * FROM matchups WHERE run_id = ? ORDER BY ordinal
    `).all('run-1');
    assert.match(plan.map((row) => row.detail).join(' '), /idx_matchups_run_id/);
});

test('ArenaDatabase derives challenge results from each opponent ranking', (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbot-arena-challenge-db-'));
    const database = new ArenaDatabase(path.join(tempDir, 'arena.sqlite'));
    context.after(() => {
        database.close();
        fs.rmSync(tempDir, { force: true, recursive: true });
    });
    const competitor = (deck, rankName, slot, source) => ({
        botLabel: rankName,
        deck,
        dialog: 'default',
        endpointHost: '127.0.0.1',
        endpointPort: 2399,
        executionMode: 'local',
        rankName,
        slot,
        source,
    });
    database.createRun({
        config: { targetDeck: 'Albaz' },
        createdAt: '2026-08-08T00:00:00.000Z',
        gamesPerMatchup: 0,
        id: 'challenge-1',
        kind: 'challenge',
        matchups: [
            {
                aiLevel: 4,
                competitors: [
                    competitor('Albaz', 'Albaz', 1, 'target'),
                    competitor('Dragon', 'Dragon Bot', 2, 'opponent'),
                ],
                label: 'Dragon',
            },
            {
                aiLevel: 2,
                competitors: [
                    competitor('Albaz', 'Albaz', 1, 'target'),
                    competitor('Spellbook', 'Spellbook Bot', 2, 'opponent'),
                ],
                label: 'Spellbook',
            },
        ],
    });
    const rawRank = [
        ['Albaz', { flee: 1, lose: 8, win: 11 }],
        ['Dragon Bot', { flee: 1, lose: 7, win: 3 }],
        ['Spellbook Bot', { flee: 0, lose: 4, win: 5 }],
    ];
    database.recordRank('challenge-1', normalizeRank(rawRank), rawRank);
    const run = database.getRun('challenge-1');

    const inferredTarget = run.matchups[0].competitors[0];
    assert.deepEqual(
        {
            flee: inferredTarget.flee,
            games: inferredTarget.games,
            lose: inferredTarget.lose,
            win: inferredTarget.win,
        },
        { flee: 0, games: 10, lose: 3, win: 7 },
    );
    assert.equal(run.matchups[0].currentWinRate, 0.7);
    assert.equal(run.matchups[1].currentWinRate, 4 / 9);
    assert.equal(run.observedGames, 19);
});

test('ArenaDatabase records an event when an active run is marked interrupted', (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbot-arena-interrupted-db-'));
    const database = new ArenaDatabase(path.join(tempDir, 'arena.sqlite'));
    context.after(() => {
        database.close();
        fs.rmSync(tempDir, { force: true, recursive: true });
    });
    database.createRun({
        config: {},
        createdAt: '2026-08-08T00:00:00.000Z',
        gamesPerMatchup: 0,
        id: 'interrupted-1',
        kind: 'ranking',
        matchups: [],
    });

    assert.equal(database.markActiveRunsInterrupted(), 1);
    assert.equal(database.markActiveRunsInterrupted(), 0);
    const run = database.getRun('interrupted-1');
    assert.equal(run.status, 'interrupted');
    assert.equal(run.stopReason, 'Arena 服务进程已重新启动');
    assert.equal(run.events.length, 2);
    assert.equal(run.events.at(-1).level, 'warning');
    assert.equal(run.events.at(-1).message, 'Arena 服务进程已重新启动，任务已中断');
    assert.equal(run.events.at(-1).type, 'interrupted');
});

test('ArenaDatabase represents unlimited ranking entries and counts launched pairs once', (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbot-arena-ranking-db-'));
    const database = new ArenaDatabase(path.join(tempDir, 'arena.sqlite'));
    context.after(() => {
        database.close();
        fs.rmSync(tempDir, { force: true, recursive: true });
    });
    const competitor = (deck, rankName) => ({
        botLabel: deck,
        deck,
        dialog: 'default',
        endpointHost: '127.0.0.1',
        endpointPort: 2399,
        executionMode: 'local',
        rankName,
        slot: 1,
        source: 'current',
    });
    const run = database.createRun({
        config: {},
        createdAt: '2026-08-08T00:00:00.000Z',
        gamesPerMatchup: 0,
        id: 'ranking-1',
        kind: 'ranking',
        matchups: [
            { aiLevel: 4, competitors: [competitor('Dragon', '排001')], label: 'Dragon' },
            { aiLevel: 2, competitors: [competitor('Spellbook', '排002')], label: 'Spellbook' },
        ],
    });
    database.recordLaunch('ranking-1', run.matchups.map((item) => item.id));
    const rawRank = [
        ['排001', { flee: 1, lose: 3, win: 6 }],
        ['排002', { flee: 0, lose: 6, win: 3 }],
    ];
    database.recordRank('ranking-1', normalizeRank(rawRank), rawRank);
    const updated = database.getRun('ranking-1');

    assert.equal(updated.totalGames, 0);
    assert.equal(updated.launchedGames, 1);
    assert.deepEqual(updated.matchups.map((item) => item.launchedGames), [1, 1]);
    assert.equal(updated.matchups[0].observedGames, 9);
    assert.equal(updated.matchups[0].currentWinRate, 2 / 3);
    assert.equal(updated.observedGames, 9);
});
