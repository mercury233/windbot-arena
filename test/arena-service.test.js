'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ArenaService } = require('../server/arena-service');
const { createDefaultArenaSettings } = require('../server/arena-settings');

function makeSchedulingContext(kind, labels) {
    return {
        abortController: new AbortController(),
        gamesPerMatchup: 0,
        id: `${kind}-run`,
        kind,
        matchups: labels.map((label, index) => ({
            competitors: [{ rankName: label }],
            id: index + 1,
            label,
            launchedGames: 0,
        })),
        nextMatchupIndex: 0,
        settings: {
            scheduler: { pairDelayMs: 0, pairsPerTick: 1, pollMs: 1 },
            srvpro: { maxRooms: 1 },
        },
        totalGames: 0,
    };
}

test('ranking scheduler draws two distinct random entries and records one pair launch', async () => {
    const launches = [];
    const database = {
        addEvent() {},
        recordLaunch(runId, matchupIds) {
            launches.push({ matchupIds, runId });
        },
        setRoomCount() {},
    };
    const service = new ArenaService({}, database);
    const context = makeSchedulingContext('ranking', ['A', 'B', 'C']);
    service.getRoomCount = async () => 0;
    service.launchRankingPair = async (activeContext, entries) => {
        assert.equal(activeContext, context);
        assert.notEqual(entries[0].id, entries[1].id);
        if (launches.length === 19) {
            context.abortController.abort(new DOMException('测试结束', 'AbortError'));
        }
    };

    await assert.rejects(service.scheduleGames(context), /测试结束/);
    assert.equal(launches.length, 20);
    assert.ok(launches.every((launch) => launch.matchupIds.length === 2));
    assert.ok(launches.every((launch) => new Set(launch.matchupIds).size === 2));
    assert.equal(context.matchups.reduce((sum, entry) => sum + entry.launchedGames, 0), 40);
});

test('challenge scheduler rotates through every opponent until stopped', async () => {
    const launchedLabels = [];
    const database = {
        addEvent() {},
        recordLaunch() {},
        setRoomCount() {},
    };
    const service = new ArenaService({}, database);
    const context = makeSchedulingContext('challenge', ['A', 'B', 'C']);
    context.matchups.forEach((matchup) => {
        matchup.competitors.push({ rankName: `${matchup.label}-opponent` });
    });
    service.getRoomCount = async () => 0;
    service.launchMatchup = async (activeContext, matchup) => {
        assert.equal(activeContext, context);
        launchedLabels.push(matchup.label);
        if (launchedLabels.length === 6) {
            context.abortController.abort(new DOMException('测试结束', 'AbortError'));
        }
    };

    await assert.rejects(service.scheduleGames(context), /测试结束/);
    assert.deepEqual(launchedLabels, ['A', 'B', 'C', 'A', 'B', 'C']);
    assert.deepEqual(context.matchups.map((entry) => entry.launchedGames), [2, 2, 2]);
});

test('deck listing keeps current decks available without an old WindBot', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.windbots.current, {
        botConfText: '!Current\nName=Current Deck=Dragon Dialog=default',
        host: 'current.lan',
        mode: 'remote',
    });
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });

    assert.deepEqual(service.listDecks(), {
        currentDecks: [{ aiLevel: null, currentLabel: 'Current', deck: 'Dragon' }],
        regressionDecks: [],
    });
});

test('saving a remote bot.conf URL fetches and persists its content', async (context) => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpro, {
        accessKey: 'key',
        host: 'srvpro.lan',
        password: 'password',
        username: 'admin',
    });
    Object.assign(settings.windbots.current, {
        botConfText: '',
        botConfUrl: 'https://current.example.com/bot.conf',
        host: 'current.lan',
        mode: 'remote',
    });
    Object.assign(settings.windbots.old, {
        botConfText: '!Old\nName=Old Deck=Old Dialog=default',
        host: 'old.lan',
        mode: 'remote',
    });
    let savedSettings;
    let responseText = '!Current\nName=Current Deck=Dragon Dialog=default';
    const database = {
        getArenaSettings: () => ({ settings: savedSettings || settings }),
        saveArenaSettings(value) {
            savedSettings = structuredClone(value);
            return { settings: value, updatedAt: '2026-08-08T00:00:00.000Z' };
        },
    };
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        assert.equal(url, 'https://current.example.com/bot.conf');
        return new Response(responseText);
    };

    const service = new ArenaService({}, database);
    const result = await service.updateSettings(settings);
    assert.match(savedSettings.windbots.current.botConfText, /Deck=Dragon/);
    assert.match(result.settings.windbots.current.botConfText, /Deck=Dragon/);

    const unchanged = await service.refreshBotConfigs();
    assert.equal(unchanged.contentChanged, false);
    responseText += '\n# changed';
    const changed = await service.refreshBotConfigs();
    assert.equal(changed.contentChanged, true);
});
