'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
    ArenaService,
    SCHEDULE_POLL_MS,
    SCORE_POLL_MS,
    SETTLE_TIMEOUT_MS,
} = require('../server/arena-service');
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
            srvpro: { maxRooms: 100, roomsPerSecond: 100 },
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
        if (launches.length === 20) {
            context.abortController.abort(new DOMException('测试结束', 'AbortError'));
            throw context.abortController.signal.reason;
        }
    };

    await assert.rejects(service.scheduleGames(context), /测试结束/);
    assert.equal(launches.length, 20);
    assert.ok(launches.every((launch) => launch.matchupIds.length === 2));
    assert.ok(launches.every((launch) => new Set(launch.matchupIds).size === 2));
    assert.equal(context.matchups.reduce((sum, entry) => sum + entry.launchedGames, 0), 40);
});

test('challenge scheduler rotates through opponents in list order and stops at the target', async () => {
    const launchedLabels = [];
    const database = {
        addEvent() {},
        recordLaunch() {},
        setRoomCount() {},
    };
    const service = new ArenaService({}, database);
    const context = makeSchedulingContext('challenge', ['A', 'B', 'C']);
    context.gamesPerMatchup = 2;
    context.totalGames = 6;
    context.matchups.forEach((matchup) => {
        matchup.competitors.push({ rankName: `${matchup.label}-opponent` });
    });
    service.getRoomCount = async () => 0;
    service.launchMatchup = async (activeContext, matchup) => {
        assert.equal(activeContext, context);
        launchedLabels.push(matchup.label);
    };

    await service.scheduleGames(context);
    assert.deepEqual(launchedLabels, ['A', 'B', 'C', 'A', 'B', 'C']);
    assert.deepEqual(context.matchups.map((entry) => entry.launchedGames), [2, 2, 2]);
});

test('scheduling and final result wait use fixed timing', () => {
    assert.equal(SCHEDULE_POLL_MS, 1000);
    assert.equal(SETTLE_TIMEOUT_MS, 10 * 60 * 1000);
});

test('final result wait queries scores before completing when SRVPro has no rooms', async () => {
    const events = [];
    const roomCounts = [];
    let scoreQueryCount = 0;
    const database = {
        addEvent(...args) { events.push(args); },
        setRoomCount(runId, roomCount) { roomCounts.push([runId, roomCount]); },
    };
    const service = new ArenaService({}, database);
    const context = {
        abortController: new AbortController(),
        gamesPerMatchup: 1,
        id: 'settling-run',
        latestObserved: new Map([[1, 0]]),
        matchups: [{ id: 1 }],
        settings: { srvpro: {} },
    };
    service.getRoomCount = async (activeContext) => {
        assert.equal(activeContext, context);
        return 0;
    };
    service.queryScores = async (activeContext, signal) => {
        assert.equal(activeContext, context);
        assert.equal(signal, context.abortController.signal);
        scoreQueryCount++;
    };

    assert.equal(await service.waitForResults(context), true);
    assert.equal(scoreQueryCount, 1);
    assert.deepEqual(roomCounts, [['settling-run', 0]]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].slice(0, 3), [
        'settling-run',
        'warning',
        'settle-empty-rooms',
    ]);
    assert.match(events[0][3], /可能有对局未被排行统计记录/);
    assert.deepEqual(service.getRevisions(), { active: 1, runs: 0, system: 0 });
});

test('pair launches use one private duel password per pair and never reuse it', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        nextPrivateRoomNumber: 123456789,
        settings: {
            srvpro: { duelPort: 7911, host: 'srvpro.lan', roomsPerSecond: 100 },
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
            srvpro: {
                duelPort: 7911,
                host: 'srvpro.lan',
                password: 'management-secret',
                roomsPerSecond: 100,
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

    await assert.rejects(
        service.launchMatchup(activeContext, matchup),
        /old 调用 WindBot 超时（5 秒）/,
    );
    const cleanupUrl = requests.at(-1);
    assert.equal(cleanupUrl.hostname, 'srvpro.lan');
    assert.equal(cleanupUrl.port, '7922');
    assert.equal(cleanupUrl.pathname, '/api/message');
    assert.equal(cleanupUrl.searchParams.get('username'), 'arena');
    assert.equal(cleanupUrl.searchParams.get('pass'), 'management-secret');
    assert.equal(cleanupUrl.searchParams.get('kick'), 'M#123456789');
});

test('reboot waits for SRVPro recovery when its response body is interrupted', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        id: 'reboot-run',
        settings: {
            srvpro: {
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => {
            throw new TypeError('terminated');
        },
    });
    let roomCheckCount = 0;
    service.getRoomCount = async () => {
        roomCheckCount++;
        if (roomCheckCount === 1) {
            throw new TypeError('fetch failed');
        }
        return 0;
    };

    await service.rebootServer(activeContext, 1);

    assert.equal(roomCheckCount, 3);
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
        oldDecks: [],
        regressionDecks: [],
    });
});

test('system inspection omits server filesystem paths', () => {
    const settings = createDefaultArenaSettings();
    const service = new ArenaService({
        databasePath: 'F:\\secrets\\arena.sqlite',
        listenHost: '127.0.0.1',
        listenPort: 3000,
    }, {
        getArenaSettings: () => ({ settings }),
    });

    const result = service.inspectSystem();
    assert.equal('storage' in result, false);
    assert.equal(JSON.stringify(result).includes('arena.sqlite'), false);
});

test('state revisions separate static, history and active-run changes', () => {
    const service = new ArenaService({}, {});
    assert.deepEqual(service.getRevisions(), { active: 0, runs: 0, system: 0 });

    service.markChanged('settings');
    service.markChanged('created');
    service.markChanged('progress');
    service.markChanged('rank');
    service.markChanged('run-event');
    service.markChanged('schedule-error');
    service.markChanged('score-poll-error');

    assert.deepEqual(service.getRevisions(), { active: 6, runs: 1, system: 1 });
});

test('startup events update the active-run revision while WindBot is still starting', async () => {
    const eventTypes = [];
    const database = {
        addEvent(runId, level, eventType) {
            eventTypes.push(eventType);
        },
        setRunStatus() {},
    };
    const service = new ArenaService({}, database);
    const context = {
        abortController: new AbortController(),
        challengerVersion: 'old',
        children: [],
        finished: false,
        id: 'startup-run',
        kind: 'challenge',
        settings: {
            windbots: {
                current: { host: 'current.lan', mode: 'remote', port: 2399 },
                old: { host: 'old.lan', mode: 'remote', port: 2398 },
            },
        },
    };
    service.current = context;
    service.rebootServer = async () => {};
    service.pollScores = async () => {};
    service.scheduleGames = async () => {};
    let releaseWindBot;
    let reachedWindBot;
    const windBotReady = new Promise((resolve) => { releaseWindBot = resolve; });
    const windBotWaiting = new Promise((resolve) => { reachedWindBot = resolve; });
    let waitingWindBots = 0;
    service.waitForWindBot = async () => {
        waitingWindBots++;
        if (waitingWindBots === 2) {
            reachedWindBot();
        }
        await windBotReady;
    };

    const execution = service.execute(context);
    await windBotWaiting;

    assert.deepEqual(eventTypes, ['preparing', 'server-ready', 'remote-windbot', 'remote-windbot']);
    assert.deepEqual(service.getRevisions(), { active: 4, runs: 1, system: 0 });

    releaseWindBot();
    await execution;
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

test('challenge run defaults to 100 games per opponent and has a finite total', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpro, {
        host: 'srvpro.lan',
        password: 'secret',
        username: 'arena',
    });
    Object.assign(settings.windbots.current, {
        botConfText: [
            '!Alpha',
            'Name=Alpha Deck=Alpha Dialog=default',
            '!Beta',
            'Name=Beta Deck=Beta Dialog=default',
            '!Gamma',
            'Name=Gamma Deck=Gamma Dialog=default',
        ].join('\n'),
        host: 'current.lan',
        mode: 'remote',
    });
    Object.assign(settings.windbots.old, {
        botConfText: [
            '!Legacy Alpha',
            'Name=Alpha Deck=Alpha Dialog=legacy',
        ].join('\n'),
        host: 'old.lan',
        mode: 'remote',
    });
    let persistedRun;
    const service = new ArenaService({}, {
        createRun(run) {
            persistedRun = run;
            return {
                ...run,
                matchups: run.matchups.map((matchup, index) => ({ ...matchup, id: index + 1 })),
            };
        },
        getArenaSettings: () => ({ settings }),
    });
    service.execute = async () => {};

    service.createRun({ decks: ['Beta', 'Gamma'], kind: 'challenge', targetDeck: 'Alpha' });

    assert.equal(persistedRun.gamesPerMatchup, 100);
    assert.equal(service.current.totalGames, 200);

    service.current = null;
    service.createRun({
        decks: ['Beta', 'Gamma'],
        gamesPerMatchup: 25,
        kind: 'challenge',
        targetDeck: 'Alpha',
    });
    assert.equal(persistedRun.gamesPerMatchup, 25);
    assert.equal(service.current.totalGames, 50);

    service.current = null;
    service.createRun({
        challengerVersion: 'old',
        decks: ['Beta'],
        gamesPerMatchup: 10,
        kind: 'challenge',
        targetDeck: 'Alpha — Legacy Alpha',
    });
    assert.equal(persistedRun.config.challengerVersion, 'old');
    assert.equal(persistedRun.config.targetDeck, 'Alpha');
    assert.equal(persistedRun.matchups[0].competitors[0].endpointHost, 'old.lan');
    assert.equal(persistedRun.matchups[0].competitors[1].endpointHost, 'current.lan');
});

test('incomplete settings are persisted and returned for continued editing', async () => {
    const settings = createDefaultArenaSettings();
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
    assert.equal(savedSettings.srvpro.roomsPerSecond, 1);
    assert.equal('scheduler' in savedSettings, false);
    assert.equal(savedSettings.windbots.current.runtimeDir, '');
    assert.equal(result.settings.windbots.current.runtimeDir, '');
});

test('saving a remote bot.conf URL fetches and persists its content', async (context) => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpro, {
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

test('local WindBot output is decoded from the Windows Chinese code page', (context) => {
    const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        stderr: new PassThrough(),
        stdout: new PassThrough(),
    });
    const originalSpawn = childProcess.spawn;
    const originalStderrWrite = process.stderr.write;
    let loggedOutput = '';
    context.after(() => {
        childProcess.spawn = originalSpawn;
        process.stderr.write = originalStderrWrite;
    });
    childProcess.spawn = () => child;
    process.stderr.write = (output) => {
        loggedOutput += String(output);
        return true;
    };
    const settings = createDefaultArenaSettings();
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });
    service.startWindBot({ children: [] }, 'current', '新版', {
        port: 2399,
        runtimeDir: 'F:\\WindBot',
    });

    const encoded = Buffer.from('bedcbef8b7c3cecaa1a3', 'hex');
    child.stderr.write(encoded.subarray(0, 1));
    child.stderr.write(encoded.subarray(1));

    assert.match(service.getWindBotOutput('current').output, /\[错误\] 拒绝访问。/);
    assert.match(loggedOutput, /\[新版:错误\] 拒绝访问。/);
    assert.doesNotMatch(loggedOutput, /�/);
});

test('score polling reads the private SRVPro ranking every 15 seconds', async (context) => {
    assert.equal(SCORE_POLL_MS, 15000);
    const received = [];
    const service = new ArenaService({}, { addEvent() {} });
    const activeContext = {
        abortController: new AbortController(),
        finished: false,
        id: 'poll-run',
        settings: {
            srvpro: {
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    service.current = activeContext;
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        assert.equal(url.hostname, 'srvpro.lan');
        assert.equal(url.port, '7922');
        assert.equal(url.pathname, '/api/getscores');
        assert.equal(url.searchParams.get('type'), 'private');
        assert.equal(url.searchParams.get('username'), 'arena');
        assert.equal(url.searchParams.get('pass'), 'management-secret');
        return Response.json({
            scores: [{ combo: 3, flee: 1, lose: 2, name: '新-Dragon', win: 4 }],
            type: 'private',
        });
    };
    service.receiveRank = (rank) => {
        received.push(rank);
        activeContext.abortController.abort(new DOMException('done', 'AbortError'));
    };

    await service.pollScores(activeContext, 1);
    assert.deepEqual(received, [
        [['新-Dragon', { combo: 3, flee: 1, lose: 2, win: 4 }]],
    ]);
});

test('score polling continues after a transient query failure', async (context) => {
    const events = [];
    const received = [];
    const service = new ArenaService({}, {
        addEvent(...args) { events.push(args); },
    });
    const activeContext = {
        abortController: new AbortController(),
        finished: false,
        id: 'poll-run',
        settings: {
            srvpro: {
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    service.current = activeContext;
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    let requestCount = 0;
    global.fetch = async () => {
        requestCount++;
        if (requestCount === 1) {
            throw new TypeError('fetch failed');
        }
        return Response.json({ scores: [], type: 'private' });
    };
    service.receiveRank = (rank) => {
        received.push(rank);
        activeContext.abortController.abort(new DOMException('done', 'AbortError'));
    };

    await service.pollScores(activeContext, 1);
    assert.equal(requestCount, 2);
    assert.deepEqual(received, [[]]);
    assert.equal(events[0][2], 'score-poll-error');
    assert.deepEqual(service.getRevisions(), { active: 1, runs: 0, system: 0 });
});

test('manual stop queries scores once more after the regular poller exits', async () => {
    const events = [];
    const order = [];
    const statuses = [];
    const database = {
        addEvent(...args) {
            events.push(args);
        },
        getRun: () => ({ id: 'manual-stop-run' }),
        setRunStatus(runId, status) {
            statuses.push([runId, status]);
        },
    };
    const service = new ArenaService({}, database);
    const abortController = new AbortController();
    const activeContext = {
        abortController,
        children: [],
        finished: false,
        id: 'manual-stop-run',
        stopReason: null,
    };
    activeContext.scorePoller = new Promise((resolve) => {
        abortController.signal.addEventListener('abort', () => {
            order.push('poller-exited');
            resolve();
        }, { once: true });
    });
    service.current = activeContext;
    service.queryScores = async (context) => {
        assert.equal(context, activeContext);
        assert.equal(abortController.signal.aborted, true);
        order.push('final-query');
    };

    service.stopRun(activeContext.id);
    await service.finish(activeContext, 'stopped', activeContext.stopReason);

    assert.deepEqual(order, ['poller-exited', 'final-query']);
    assert.deepEqual(statuses.map((entry) => entry[1]), ['stopping', 'stopped']);
    assert.deepEqual(events.map((entry) => entry[2]), ['stopping']);
    assert.equal(service.current, null);
});
