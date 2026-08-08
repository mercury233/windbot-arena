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

test('pair launches use one private duel password per pair and never reuse it', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        nextPrivateRoomNumber: 123456789,
        settings: {
            scheduler: { pairDelayMs: 0 },
            srvpro: { duelPort: 7911, host: 'srvpro.lan' },
        },
    };
    const competitor = (name, port) => ({
        deck: `${name}-deck`,
        dialog: null,
        endpointHost: `${name}.lan`,
        endpointPort: port,
        rankName: name,
    });
    const matchup = {
        competitors: [competitor('current', 2399), competitor('old', 2400)],
        launchedGames: 0,
    };
    const rankingEntries = [
        { competitors: [competitor('alpha', 2399)] },
        { competitors: [competitor('beta', 2399)] },
    ];
    const requests = [];
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        requests.push(new URL(url));
        return new Response(null, { status: 200 });
    };

    await service.launchMatchup(activeContext, matchup);
    await service.launchMatchup(activeContext, matchup);
    await service.launchRankingPair(activeContext, rankingEntries);

    const passwords = requests.map((url) => url.searchParams.get('password'));
    assert.deepEqual(passwords, [
        'M#123456789',
        'M#123456789',
        'M#123456790',
        'M#123456790',
        'M#123456791',
        'M#123456791',
    ]);
    assert.ok(requests.every((url) => url.searchParams.get('host') === 'srvpro.lan'));
    assert.ok(requests.every((url) => url.searchParams.get('port') === '7911'));
});

test('pair launch closes its private room when a WindBot request fails', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        nextPrivateRoomNumber: 123456789,
        settings: {
            scheduler: { pairDelayMs: 0 },
            srvpro: {
                duelPort: 7911,
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    const matchup = {
        competitors: [
            {
                deck: 'current-deck',
                dialog: null,
                endpointHost: 'current.lan',
                endpointPort: 2399,
                rankName: 'current',
            },
            {
                deck: 'old-deck',
                dialog: null,
                endpointHost: 'old.lan',
                endpointPort: 2400,
                rankName: 'old',
            },
        ],
        launchedGames: 0,
    };
    const requests = [];
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        const requestUrl = new URL(url);
        requests.push(requestUrl);
        if (requestUrl.hostname === 'old.lan') {
            throw new DOMException('WindBot 请求超时', 'TimeoutError');
        }
        if (requestUrl.pathname === '/api/message') {
            return new Response("['kick ok', 'M#123456789']");
        }
        return new Response(null, { status: 200 });
    };

    await assert.rejects(service.launchMatchup(activeContext, matchup), /WindBot 请求超时/);
    const cleanupUrl = requests.at(-1);
    assert.equal(cleanupUrl.hostname, 'srvpro.lan');
    assert.equal(cleanupUrl.port, '7922');
    assert.equal(cleanupUrl.pathname, '/api/message');
    assert.equal(cleanupUrl.searchParams.get('username'), 'arena');
    assert.equal(cleanupUrl.searchParams.get('pass'), 'management-secret');
    assert.equal(cleanupUrl.searchParams.get('kick'), 'M#123456789');
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

test('run creation rejects incomplete settings before persisting a run', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.windbots.current, {
        botConfText: [
            '!Alpha',
            'Name=Alpha Deck=Alpha Dialog=default',
            '!Beta',
            'Name=Beta Deck=Beta Dialog=default',
        ].join('\n'),
        host: 'current.lan',
        mode: 'remote',
    });
    let createdRunCount = 0;
    const service = new ArenaService({}, {
        createRun() {
            createdRunCount++;
        },
        getArenaSettings: () => ({ settings }),
    });

    assert.throws(
        () => service.createRun({ decks: ['Alpha', 'Beta'], kind: 'ranking' }),
        (error) => error.statusCode === 400 && /SRVPro 地址未配置/.test(error.message),
    );
    assert.equal(createdRunCount, 0);
    assert.equal(service.current, null);
});

test('incomplete settings are persisted and returned for continued editing', async () => {
    const settings = createDefaultArenaSettings();
    settings.srvpro.rankPostPath = '';
    let savedSettings;
    const database = {
        getArenaSettings: () => ({ settings: savedSettings || settings }),
        saveArenaSettings(value) {
            savedSettings = structuredClone(value);
            return { settings: value, updatedAt: '2026-08-08T00:00:00.000Z' };
        },
    };
    const service = new ArenaService({}, database);

    const result = await service.updateSettings(settings);
    assert.equal(savedSettings.windbots.current.runtimeDir, '');
    assert.equal(savedSettings.srvpro.rankPostPath, '');
    assert.equal(result.settings.windbots.current.runtimeDir, '');
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

test('room inspection authenticates server-side and exposes only display fields', async (context) => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpro, {
        host: 'srvpro.lan',
        password: 'management-secret',
        statusPort: 7922,
        username: 'arena',
    });
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        assert.equal(url.hostname, 'srvpro.lan');
        assert.equal(url.searchParams.get('username'), 'arena');
        assert.equal(url.searchParams.get('pass'), 'management-secret');
        return Response.json({
            rooms: [{
                istart: 'Duel:2 Turn:10',
                roomid: '2937844',
                roomname: 'M,RANDOM#85468',
                users: [
                    { ip: '192.0.2.1', name: '新版', pos: 0, status: { lp: 8000, score: 1 } },
                    { ip: '192.0.2.2', name: '旧版', pos: 1, status: { lp: 8000, score: 0 } },
                    { ip: '192.0.2.3', name: '观战者', pos: 7, status: null },
                ],
            }],
        });
    };

    const result = await service.listRooms();
    assert.deepEqual(result.rooms, [{
        id: '2937844',
        name: 'M,RANDOM#85468',
        players: [
            { name: '新版', status: { lp: 8000, score: 1 } },
            { name: '旧版', status: { lp: 8000, score: 0 } },
        ],
        status: 'Duel:2 Turn:10',
    }]);
    assert.equal(JSON.stringify(result).includes('management-secret'), false);
    assert.equal(JSON.stringify(result).includes('192.0.2.1'), false);
});

test('WindBot output inspection distinguishes local and remote instances', () => {
    const settings = createDefaultArenaSettings();
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });
    service.appendWindBotOutput('current', 'Server started\n');

    assert.equal(service.getWindBotOutput('current').output, 'Server started\n');
    assert.equal(service.getWindBotOutput('current').available, true);
    settings.windbots.old.mode = 'remote';
    assert.deepEqual(service.getWindBotOutput('old'), {
        active: false,
        available: false,
        mode: 'remote',
        output: '',
        updatedAt: null,
    });
    assert.throws(() => service.getWindBotOutput('unknown'), (error) => error.statusCode === 404);
});

test('rank forwarding posts the original report with the production access key', async (context) => {
    const settings = createDefaultArenaSettings();
    settings.srvpro.accessKey = 'production-rank-key';
    settings.development = {
        rankForwardEnabled: true,
        rankForwardUrl: 'http://dev-arena.lan:3000/score/report',
    };
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });
    const rank = [['新-Dragon', { flee: 0, lose: 1, win: 2 }]];
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url, options) => {
        assert.equal(url, 'http://dev-arena.lan:3000/score/report');
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['X-WindBot-Arena-Forwarded'], '1');
        assert.equal(options.body.get('accesskey'), 'production-rank-key');
        assert.deepEqual(JSON.parse(options.body.get('rank')), rank);
        return new Response('ok');
    };

    assert.deepEqual(await service.forwardRankReport(rank), { forwarded: true });
});
