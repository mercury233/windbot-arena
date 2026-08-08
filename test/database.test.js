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
    const run = database.getRun('run-1');

    assert.equal(run.matchups[0].observedGames, 10);
    assert.equal(run.matchups[0].aiLevel, 4);
    assert.equal(run.matchups[0].competitors[1].endpointHost, 'windbot-old.lan');
    assert.equal(run.matchups[0].currentWinRate, 0.7);
    assert.equal(database.listRuns()[0].matchupCount, 1);
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
