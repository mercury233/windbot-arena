'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
    ArenaService,
    getRoomLaunchRate,
    SCHEDULE_POLL_MS,
    SCORE_POLL_MS,
    SETTLE_TIMEOUT_MS,
    WINDBOT_REQUEST_ATTEMPTS,
    WINDBOT_REQUEST_TIMEOUT_MS,
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

test('tag scheduler draws four candidates with replacement for every room', async () => {
    const launches = [];
    const database = {
        addEvent() {},
        recordLaunch(runId, matchupIds) {
            launches.push({ matchupIds, runId });
        },
        setRoomCount() {},
    };
    const service = new ArenaService({}, database);
    const context = makeSchedulingContext('tag', ['A']);
    service.getRoomCount = async () => 0;
    service.launchTagGroup = async (activeContext, entries) => {
        assert.equal(activeContext, context);
        assert.equal(entries.length, 4);
        assert.deepEqual(entries.map((entry) => entry.id), [1, 1, 1, 1]);
        if (launches.length === 20) {
            context.abortController.abort(new DOMException('测试结束', 'AbortError'));
            throw context.abortController.signal.reason;
        }
    };

    await assert.rejects(service.scheduleGames(context), /测试结束/);
    assert.equal(launches.length, 20);
    assert.ok(launches.every((launch) => launch.matchupIds.length === 4));
    assert.ok(launches.every((launch) => launch.matchupIds.every((id) => id === 1)));
    assert.equal(context.matchups.reduce((sum, entry) => sum + entry.launchedGames, 0), 80);
});

test('tag rooms use half of the configured launch rate', () => {
    const normal = makeSchedulingContext('ranking', ['A', 'B']);
    const tag = makeSchedulingContext('tag', ['A', 'B', 'C', 'D']);
    normal.settings.srvpro.roomsPerSecond = 5;
    tag.settings.srvpro.roomsPerSecond = 5;

    assert.equal(getRoomLaunchRate(normal), 5);
    assert.equal(getRoomLaunchRate(tag), 2.5);
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
    assert.equal(WINDBOT_REQUEST_ATTEMPTS, 3);
    assert.equal(WINDBOT_REQUEST_TIMEOUT_MS, 3 * 1000);
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

test('final result wait does not warn when its final score query completes the run', async () => {
    const events = [];
    const database = {
        addEvent(...args) { events.push(args); },
        setRoomCount() {},
    };
    const service = new ArenaService({}, database);
    const context = {
        abortController: new AbortController(),
        gamesPerMatchup: 1,
        id: 'complete-settling-run',
        latestObserved: new Map([[1, 0]]),
        matchups: [{ id: 1 }],
        settings: { srvpro: {} },
    };
    service.getRoomCount = async () => 0;
    service.queryScores = async () => {
        context.latestObserved.set(1, 1);
    };

    assert.equal(await service.waitForResults(context), true);
    assert.deepEqual(events, []);
    assert.deepEqual(service.getRevisions(), { active: 0, runs: 0, system: 0 });
});

test('pair launches use one duel password per pair and never reuse it', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        nextRoomNumber: 123456789,
        serverInstanceId: 'srvpro-instance',
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

test('tag launches send four randomly seated bots to one T room', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        kind: 'tag',
        nextRoomNumber: 223456789,
        settings: {
            srvpro: { duelPort: 7911, host: 'srvpro.lan', roomsPerSecond: 100 },
        },
    };
    const entries = ['A', 'B', 'C', 'D'].map((name, index) => ({
        competitors: [{
            deck: `${name}-deck`,
            dialog: null,
            endpointHost: `${name.toLowerCase()}.lan`,
            endpointPort: 2399 + index,
            rankName: name,
        }],
    }));
    const requests = [];
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        requests.push(new URL(url));
        return new Response(null, { status: 200 });
    };

    await service.launchTagGroup(activeContext, entries);

    assert.equal(requests.length, 4);
    assert.ok(requests.every((url) => url.searchParams.get('password') === 'T#223456789'));
    assert.deepEqual(
        requests.map((url) => url.searchParams.get('name')).sort(),
        ['A', 'B', 'C', 'D'],
    );
});

test('pair launch closes timed-out rooms and retries with a new password', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        nextRoomNumber: 123456789,
        serverInstanceId: 'srvpro-instance',
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
            return new Response("['kick ok', 'M#123456789']", {
                headers: { 'X-Server-Instance-ID': 'srvpro-instance' },
            });
        }
        return new Response(null, { status: 200 });
    };

    await assert.rejects(
        service.launchMatchup(activeContext, matchup),
        (error) => error.code === 'WINDBOT_UNAVAILABLE'
            && /WindBot 连续 3 个约战房间请求失败/.test(error.message),
    );
    const windBotPasswords = requests
        .filter((url) => url.hostname === 'current.lan' || url.hostname === 'old.lan')
        .map((url) => url.searchParams.get('password'));
    assert.deepEqual(windBotPasswords, [
        'M#123456789',
        'M#123456789',
        'M#123456790',
        'M#123456790',
        'M#123456791',
        'M#123456791',
    ]);
    const cleanupUrls = requests.filter((url) => url.pathname === '/api/message');
    assert.deepEqual(
        cleanupUrls.map((url) => url.searchParams.get('kick')),
        ['M#123456789', 'M#123456790', 'M#123456791'],
    );
    assert.ok(cleanupUrls.every((url) => url.hostname === 'srvpro.lan'));
    assert.ok(cleanupUrls.every((url) => url.port === '7922'));
    assert.ok(cleanupUrls.every((url) => url.searchParams.get('username') === 'arena'));
    assert.ok(cleanupUrls.every((url) => url.searchParams.get('pass') === 'management-secret'));
});

test('WindBot 404 distinguishes a missing challenger from other missing decks', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        kind: 'challenge',
        settings: {
            srvpro: { duelPort: 7911, host: 'srvpro.lan' },
        },
    };
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => new Response(null, { status: 404 });

    await assert.rejects(
        service.addBot(activeContext, {
            deck: 'MissingTarget',
            endpointHost: 'current.lan',
            endpointPort: 2399,
            rankName: 'target',
            source: 'target',
        }, 'M#123456789'),
        (error) => error.code === 'WINDBOT_DECK_NOT_FOUND'
            && error.message === '挑战者卡组“MissingTarget”在对应的 WindBot 中不存在',
    );
    await assert.rejects(
        service.addBot(activeContext, {
            deck: 'MissingOpponent',
            endpointHost: 'current.lan',
            endpointPort: 2399,
            rankName: '对手-MissingOpponent',
            source: 'opponent',
        }, 'M#123456790'),
        (error) => error.code === 'WINDBOT_DECK_NOT_FOUND'
            && error.message === '对手-MissingOpponent 使用的卡组“MissingOpponent”在对应的 WindBot 中不存在，请检查 bot.conf 与 WindBot 版本是否匹配',
    );
});

test('scheduler stops immediately when WindBot reports a missing deck', async () => {
    const events = [];
    const service = new ArenaService({}, {
        addEvent(...args) { events.push(args); },
        setRoomCount() {},
    });
    const context = makeSchedulingContext('challenge', ['MissingTarget']);
    context.gamesPerMatchup = 1;
    context.totalGames = 1;
    service.getRoomCount = async () => 0;
    let launchCount = 0;
    service.launchMatchup = async () => {
        launchCount++;
        const error = new Error('挑战者卡组不存在');
        error.code = 'WINDBOT_DECK_NOT_FOUND';
        throw error;
    };

    await assert.rejects(service.scheduleGames(context), /挑战者卡组不存在/);
    assert.equal(launchCount, 1);
    assert.deepEqual(events, []);
});

test('scheduler stops immediately after WindBot is confirmed unavailable', async () => {
    const events = [];
    const service = new ArenaService({}, {
        addEvent(...args) { events.push(args); },
        setRoomCount() {},
    });
    const context = makeSchedulingContext('challenge', ['Unavailable']);
    context.gamesPerMatchup = 1;
    context.totalGames = 1;
    service.getRoomCount = async () => 0;
    service.launchMatchup = async () => {
        const error = new Error('新版 WindBot 连续 3 次请求不可用');
        error.code = 'WINDBOT_UNAVAILABLE';
        throw error;
    };

    await assert.rejects(
        service.scheduleGames(context),
        (error) => error.code === 'WINDBOT_UNAVAILABLE',
    );
    assert.deepEqual(events, []);
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
    const observedInstances = [];
    service.fetchRoomCount = async () => {
        if (observedInstances.length === 0) {
            observedInstances.push('before-reboot');
            return { count: 0, serverInstanceId: 'before-reboot' };
        }
        if (observedInstances.length === 1) {
            observedInstances.push('unavailable');
            throw new TypeError('fetch failed');
        }
        observedInstances.push('after-reboot');
        return { count: 0, serverInstanceId: 'after-reboot' };
    };

    await service.rebootServer(activeContext, 1);

    assert.deepEqual(observedInstances, [
        'before-reboot',
        'unavailable',
        'after-reboot',
        'after-reboot',
    ]);
    assert.equal(activeContext.serverInstanceId, 'after-reboot');
});

test('room queries abort the task when the SRVPro instance changes', async () => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        serverInstanceId: 'expected-instance',
        settings: { srvpro: {} },
    };
    service.fetchRoomCount = async () => ({
        count: 0,
        serverInstanceId: 'restarted-instance',
    });

    await assert.rejects(
        service.getRoomCount(activeContext),
        (error) => error.code === 'SRVPRO_INSTANCE_CHANGED'
            && /服务可能在任务运行期间重启/.test(error.message),
    );
    assert.equal(activeContext.abortController.signal.aborted, true);
    assert.equal(
        activeContext.abortController.signal.reason.code,
        'SRVPRO_INSTANCE_CHANGED',
    );
});

test('room counts use the lightweight SRVPro endpoint', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        serverInstanceId: 'expected-instance',
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
    global.fetch = async (url) => {
        assert.equal(url.pathname, '/api/getroomscount');
        assert.equal(url.searchParams.get('username'), 'arena');
        assert.equal(url.searchParams.get('pass'), 'management-secret');
        return Response.json({
            count: 3,
            serverInstanceId: 'expected-instance',
        });
    };

    assert.equal(await service.getRoomCount(activeContext), 3);
});

test('SRVPro room count timeout reports the endpoint and startup guidance', async (context) => {
    const service = new ArenaService({}, {});
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    await assert.rejects(
        service.fetchRoomCount({
            host: '127.0.0.1',
            password: 'management-secret',
            statusPort: 7922,
            username: 'arena',
        }),
        (error) => error.message === 'SRVPro 房间计数 API 请求超时（5 秒）：http://127.0.0.1:7922/api/getroomscount；请确认 SRVPro 已启动且管理端口可访问'
            && error.cause?.name === 'TimeoutError'
            && !error.message.includes('management-secret'),
    );
});

test('SRVPro connection refusal exposes the network error code without credentials', async (context) => {
    const service = new ArenaService({}, {});
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => {
        const cause = new Error('connect ECONNREFUSED 127.0.0.1:7922');
        cause.code = 'ECONNREFUSED';
        throw new TypeError('fetch failed', { cause });
    };

    await assert.rejects(
        service.fetchRoomCount({
            host: '127.0.0.1',
            password: 'management-secret',
            statusPort: 7922,
            username: 'arena',
        }),
        (error) => /SRVPro 房间计数 API 请求失败：http:\/\/127\.0\.0\.1:7922\/api\/getroomscount/.test(error.message)
            && /目标拒绝连接（ECONNREFUSED）/.test(error.message)
            && /请确认 SRVPro 已启动且管理端口配置正确/.test(error.message)
            && !error.message.includes('management-secret'),
    );
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

test('run deletion only accepts terminal history and updates its revision', () => {
    const records = new Map([
        ['finished-run', { id: 'finished-run', status: 'completed' }],
        ['active-run', { id: 'active-run', status: 'running' }],
    ]);
    const service = new ArenaService({}, {
        deleteRun(runId) {
            return records.delete(runId);
        },
        getRun(runId) {
            return records.get(runId) || null;
        },
    });

    assert.equal(service.deleteRun('finished-run').id, 'finished-run');
    assert.deepEqual(service.getRevisions(), { active: 0, runs: 1, system: 0 });
    assert.throws(() => service.deleteRun('active-run'), { statusCode: 409 });
    assert.throws(() => service.deleteRun('missing-run'), { statusCode: 404 });
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
    context.srvproId = 'srvpro-1';
    service.contexts.set(context.srvproId, context);
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

test('runtime infrastructure loss is interrupted while startup unavailability is failed', async () => {
    const executeWithError = async (error, duringStartup = false) => {
        const statuses = [];
        const service = new ArenaService({}, {
            addEvent() {},
            setRunStatus() {},
        });
        const context = {
            abortController: new AbortController(),
            challengerVersion: 'current',
            children: [],
            finished: false,
            id: `classification-${error.code || 'startup'}`,
            kind: 'ranking',
            settings: {
                srvpro: {},
                windbots: {
                    current: { host: 'current.lan', mode: 'remote', port: 2399 },
                },
            },
            srvproId: 'srvpro-1',
        };
        service.contexts.set(context.srvproId, context);
        service.rebootServer = async () => {};
        service.waitForWindBot = async () => {
            if (duringStartup) {
                throw error;
            }
        };
        service.pollScores = async () => {};
        service.scheduleGames = async () => { throw error; };
        service.finish = async (activeContext, status, reason, storedError) => {
            assert.equal(activeContext, context);
            statuses.push({ reason, status, storedError });
        };

        await service.execute(context);
        return statuses[0];
    };

    const instanceChanged = new Error('SRVPro 实例已变化');
    instanceChanged.code = 'SRVPRO_INSTANCE_CHANGED';
    assert.deepEqual(await executeWithError(instanceChanged), {
        reason: '测试中断: SRVPro 实例已变化',
        status: 'interrupted',
        storedError: undefined,
    });

    const windBotUnavailable = new Error('新版 WindBot 连续 3 次请求不可用');
    windBotUnavailable.code = 'WINDBOT_UNAVAILABLE';
    assert.deepEqual(await executeWithError(windBotUnavailable), {
        reason: '测试中断: 新版 WindBot 连续 3 次请求不可用',
        status: 'interrupted',
        storedError: undefined,
    });

    const startupUnavailable = new Error('新版 WindBot HTTP 服务没有就绪');
    assert.deepEqual(await executeWithError(startupUnavailable, true), {
        reason: '测试失败: 新版 WindBot HTTP 服务没有就绪',
        status: 'failed',
        storedError: '新版 WindBot HTTP 服务没有就绪',
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
    assert.equal(service.contexts.size, 0);
});

test('challenge run defaults to 100 games per opponent and has a finite total', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
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
    assert.equal(service.contexts.get('srvpro-1').totalGames, 200);

    service.contexts.clear();
    service.createRun({
        decks: ['Beta', 'Gamma'],
        gamesPerMatchup: 25,
        kind: 'challenge',
        targetDeck: 'Alpha',
    });
    assert.equal(persistedRun.gamesPerMatchup, 25);
    assert.equal(service.contexts.get('srvpro-1').totalGames, 50);

    service.contexts.clear();
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

test('tag run keeps all selected candidates and runs without a target game count', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
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
            '!Delta',
            'Name=Delta Deck=Delta Dialog=default',
            '!Epsilon',
            'Name=Epsilon Deck=Epsilon Dialog=default',
        ].join('\n'),
        host: 'current.lan',
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

    service.createRun({
        decks: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'],
        kind: 'tag',
    });

    assert.equal(persistedRun.gamesPerMatchup, 0);
    assert.deepEqual(
        persistedRun.matchups.map((entry) => entry.label),
        ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'],
    );
    assert.equal(service.contexts.get('srvpro-1').totalGames, 0);
});

test('run context keeps persisted matchup ids aligned when stored rows are sorted', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
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
        ].join('\n'),
        host: 'current.lan',
        mode: 'remote',
    });
    const service = new ArenaService({}, {
        createRun(run) {
            return {
                ...run,
                matchups: [
                    { ...run.matchups[1], id: 202 },
                    { ...run.matchups[0], id: 101 },
                ],
            };
        },
        getArenaSettings: () => ({ settings }),
    });
    service.execute = async () => {};

    service.createRun({ decks: ['Beta', 'Alpha'], kind: 'ranking' });

    assert.deepEqual(
        service.contexts.get('srvpro-1').matchups.map((matchup) => [matchup.label, matchup.id]),
        [['Beta', 101], ['Alpha', 202]],
    );
});

test('different SRVPro instances can run concurrently while each instance stays exclusive', () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
        host: 'srvpro-1.lan',
        password: 'first-secret',
        username: 'arena',
    });
    settings.srvpros.push({
        ...settings.srvpros[0],
        host: 'srvpro-2.lan',
        id: 'srvpro-2',
        name: 'SRVPro 2',
        password: 'second-secret',
        statusPort: 8922,
    });
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
    const createdRuns = [];
    const service = new ArenaService({}, {
        createRun(run) {
            createdRuns.push(run);
            return {
                ...run,
                matchups: run.matchups.map((matchup, index) => ({ ...matchup, id: index + 1 })),
            };
        },
        getArenaSettings: () => ({ settings }),
    });
    service.execute = async () => {};

    service.createRun({ decks: ['Alpha', 'Beta'], kind: 'ranking', srvproId: 'srvpro-1' });
    service.createRun({ decks: ['Alpha', 'Beta'], kind: 'ranking', srvproId: 'srvpro-2' });

    assert.equal(service.contexts.size, 2);
    assert.deepEqual(createdRuns.map((run) => run.srvproId), ['srvpro-1', 'srvpro-2']);
    assert.deepEqual(createdRuns.map((run) => run.config.srvproName), ['SRVPro 1', 'SRVPro 2']);
    assert.equal(JSON.stringify(createdRuns).includes('first-secret'), false);
    assert.equal(JSON.stringify(createdRuns).includes('second-secret'), false);
    assert.throws(
        () => service.createRun({ decks: ['Alpha', 'Beta'], kind: 'ranking', srvproId: 'srvpro-1' }),
        (error) => error.statusCode === 409 && /SRVPro 1 已有测试正在运行/.test(error.message),
    );
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
    assert.equal(savedSettings.srvpros[0].roomsPerSecond, 1);
    assert.equal('scheduler' in savedSettings, false);
    assert.equal(savedSettings.windbots.current.runtimeDir, '');
    assert.equal(result.settings.windbots.current.runtimeDir, '');
});

test('saving a remote bot.conf URL fetches and persists its content', async (context) => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
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
    Object.assign(settings.srvpros[0], {
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
            enableHalfwayWatch: false,
            serverInstanceId: 'room-inspection-instance',
            rooms: [{
                istart: 'Duel:2 Turn:10',
                roomid: '2937844',
                roommode: 2,
                roomname: 'T#85468',
                users: [
                    { ip: '192.0.2.1', name: '新版', pos: 0, status: { lp: 8000, score: 1 } },
                    { ip: '192.0.2.2', name: '旧版', pos: 1, status: { lp: 8000, score: 0 } },
                    { ip: '192.0.2.4', name: '队友', pos: 2, status: { lp: 8000, score: 1 } },
                    { ip: '192.0.2.5', name: '对手', pos: 3, status: { lp: 8000, score: 0 } },
                    { ip: '192.0.2.3', name: '观战者', pos: 7, status: null },
                ],
            }],
        });
    };

    const result = await service.listRooms();
    assert.equal(result.enableHalfwayWatch, false);
    assert.deepEqual(result.rooms, [{
        id: '2937844',
        mode: 2,
        name: 'T#85468',
        players: [
            { name: '新版', position: 0, status: { lp: 8000, score: 1 } },
            { name: '旧版', position: 1, status: { lp: 8000, score: 0 } },
            { name: '队友', position: 2, status: { lp: 8000, score: 1 } },
            { name: '对手', position: 3, status: { lp: 8000, score: 0 } },
        ],
        status: 'Duel:2 Turn:10',
    }]);
    assert.equal(JSON.stringify(result).includes('management-secret'), false);
    assert.equal(JSON.stringify(result).includes('192.0.2.1'), false);
});

test('room inspection recognizes the legacy password-error room before new fields', async (context) => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
        host: 'srvpro.lan',
        password: 'wrong-secret',
        username: 'arena',
    });
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
    });
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async () => Response.json({
        rooms: [{ roomid: '0', roomname: '密码错误', needpass: 'true' }],
    });

    await assert.rejects(
        service.listRooms(),
        /SRVPro 管理账号或密码错误/,
    );
});

test('halfway watch updates SRVPro without storing a second Arena setting', async () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
        host: 'srvpro.lan',
        password: 'management-secret',
        username: 'arena',
    });
    const service = new ArenaService({}, {
        getArenaSettings: () => ({ settings }),
        saveArenaSettings() {
            assert.fail('实时中途观战状态不应写入 Arena 设置');
        },
    });
    const calls = [];
    service.setSrvproHalfwayWatch = async (srvpro, enabled) => {
        calls.push({ enabled, id: srvpro.id });
        return 'server-instance';
    };

    const result = await service.updateHalfwayWatch('srvpro-1', false);

    assert.deepEqual(calls, [{ enabled: false, id: 'srvpro-1' }]);
    assert.equal(result.enableHalfwayWatch, false);
});

test('halfway watch request uses the authenticated SRVPro API', async (context) => {
    const service = new ArenaService({}, {});
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        assert.equal(url.pathname, '/api/halfwaywatch');
        assert.equal(url.searchParams.get('username'), 'arena');
        assert.equal(url.searchParams.get('pass'), 'management-secret');
        assert.equal(url.searchParams.get('enabled'), 'true');
        return Response.json({
            enableHalfwayWatch: true,
            serverInstanceId: 'halfwaywatch-setting-instance',
        });
    };

    const serverInstanceId = await service.setSrvproHalfwayWatch({
        host: 'srvpro.lan',
        password: 'management-secret',
        statusPort: 7922,
        username: 'arena',
    }, true);

    assert.equal(serverInstanceId, 'halfwaywatch-setting-instance');
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

test('local WindBot stderr errors are recorded for running tag tasks', () => {
    const events = [];
    const service = new ArenaService({}, {
        addEvent(...args) { events.push(args); },
    });
    const makeContext = (id, kind, mode, running = true) => ({
        id,
        kind,
        running,
        settings: { windbots: { current: { mode } } },
    });
    service.contexts.set('local-tag', makeContext('local-tag', 'tag', 'local'));
    service.contexts.set('remote-tag', makeContext('remote-tag', 'tag', 'remote'));
    service.contexts.set('ranking', makeContext('ranking', 'ranking', 'local'));
    service.contexts.set('starting-tag', makeContext('starting-tag', 'tag', 'local', false));

    service.scanWindBotErrors('current', '[26-08-13 12:00:00] Invalid card selec');
    assert.deepEqual(events, []);
    service.scanWindBotErrors(
        'current',
        'tion, using a legal fallback.\r\nContext: Instance=1, Bot=Alpha\r\n',
    );
    service.scanWindBotErrors('current', '[26-08-13 12:00:01] Tick Error\r\n');
    service.scanWindBotErrors('old', '[26-08-13 12:00:02] Old error\r\n');

    assert.deepEqual(events, [
        [
            'local-tag',
            'error',
            'windbot-output-error',
            'WindBot 输出错误: Invalid card selection, using a legal fallback.',
        ],
        ['local-tag', 'error', 'windbot-output-error', 'WindBot 输出错误: Tick Error'],
    ]);
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
    service.startWindBot('current', '新版', {
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

test('local WindBot exit interrupts running tasks but not tasks still starting', (context) => {
    const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        stderr: new PassThrough(),
        stdout: new PassThrough(),
    });
    const originalSpawn = childProcess.spawn;
    context.after(() => { childProcess.spawn = originalSpawn; });
    childProcess.spawn = () => child;
    const service = new ArenaService({}, {});
    const makeContext = (id, running) => ({
        abortController: new AbortController(),
        challengerVersion: 'current',
        id,
        kind: 'ranking',
        running,
        settings: { windbots: { current: { mode: 'local' } } },
    });
    const runningContext = makeContext('running-task', true);
    const startingContext = makeContext('starting-task', false);
    service.contexts.set('srvpro-1', runningContext);
    service.contexts.set('srvpro-2', startingContext);
    service.startWindBot('current', '新版', {
        port: 2399,
        runtimeDir: 'F:\\WindBot',
    });

    child.emit('exit', 1, null);

    assert.equal(runningContext.abortController.signal.aborted, true);
    assert.equal(
        runningContext.abortController.signal.reason.code,
        'WINDBOT_UNAVAILABLE',
    );
    assert.equal(startingContext.abortController.signal.aborted, false);
});

test('shared local WindBot stays alive until the last concurrent run finishes', async () => {
    const service = new ArenaService({}, {
        addEvent() {},
        setRunStatus() {},
    });
    let killCount = 0;
    service.localWindbots.set('current', {
        exitCode: null,
        kill() { killCount++; },
    });
    const makeContext = (id, srvproId) => ({
        abortController: new AbortController(),
        finished: false,
        id,
        srvproId,
    });
    const first = makeContext('run-1', 'srvpro-1');
    const second = makeContext('run-2', 'srvpro-2');
    service.contexts.set(first.srvproId, first);
    service.contexts.set(second.srvproId, second);

    await service.finish(first, 'completed', 'done');
    assert.equal(killCount, 0);
    assert.equal(service.contexts.size, 1);

    await service.finish(second, 'completed', 'done');
    assert.equal(killCount, 1);
    assert.equal(service.contexts.size, 0);
});

test('score polling reads the SRVPro ranking every 15 seconds', async (context) => {
    assert.equal(SCORE_POLL_MS, 15000);
    const received = [];
    const service = new ArenaService({}, { addEvent() {} });
    const activeContext = {
        abortController: new AbortController(),
        finished: false,
        id: 'poll-run',
        serverInstanceId: 'score-instance',
        settings: {
            srvpro: {
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    activeContext.srvproId = 'srvpro-1';
    service.contexts.set(activeContext.srvproId, activeContext);
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    global.fetch = async (url) => {
        assert.equal(url.hostname, 'srvpro.lan');
        assert.equal(url.port, '7922');
        assert.equal(url.pathname, '/api/getscores');
        assert.equal(url.searchParams.has('type'), false);
        assert.equal(url.searchParams.get('username'), 'arena');
        assert.equal(url.searchParams.get('pass'), 'management-secret');
        return Response.json({
            serverInstanceId: 'score-instance',
            scores: [{ combo: 3, flee: 1, lose: 2, name: '新-Dragon', win: 4 }],
        });
    };
    service.receiveRank = (receivedContext, rank) => {
        assert.equal(receivedContext, activeContext);
        received.push(rank);
        activeContext.abortController.abort(new DOMException('done', 'AbortError'));
    };

    await service.pollScores(activeContext, 1);
    assert.deepEqual(received, [
        [['新-Dragon', { combo: 3, flee: 1, lose: 2, win: 4 }]],
    ]);
});

test('score queries reject data from a restarted SRVPro instance', async (context) => {
    const service = new ArenaService({}, {});
    const activeContext = {
        abortController: new AbortController(),
        finished: false,
        id: 'poll-run',
        serverInstanceId: 'expected-instance',
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
    global.fetch = async () => Response.json({
        scores: [{ combo: 0, flee: 0, lose: 0, name: '新-Dragon', win: 1 }],
        serverInstanceId: 'restarted-instance',
    });
    let rankRecorded = false;
    service.receiveRank = () => { rankRecorded = true; };

    await assert.rejects(
        service.queryScores(activeContext, activeContext.abortController.signal),
        (error) => error.code === 'SRVPRO_INSTANCE_CHANGED',
    );
    assert.equal(rankRecorded, false);
    assert.equal(activeContext.abortController.signal.aborted, true);
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
        serverInstanceId: 'score-instance',
        settings: {
            srvpro: {
                host: 'srvpro.lan',
                password: 'management-secret',
                statusPort: 7922,
                username: 'arena',
            },
        },
    };
    activeContext.srvproId = 'srvpro-1';
    service.contexts.set(activeContext.srvproId, activeContext);
    const originalFetch = global.fetch;
    context.after(() => { global.fetch = originalFetch; });
    let requestCount = 0;
    global.fetch = async () => {
        requestCount++;
        if (requestCount === 1) {
            throw new TypeError('fetch failed');
        }
        return Response.json({
            scores: [],
            serverInstanceId: 'score-instance',
        });
    };
    service.receiveRank = (receivedContext, rank) => {
        assert.equal(receivedContext, activeContext);
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
    activeContext.srvproId = 'srvpro-1';
    service.contexts.set(activeContext.srvproId, activeContext);
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
    assert.equal(service.contexts.size, 0);
});
