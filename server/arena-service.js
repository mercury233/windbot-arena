'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const path = require('path');
const {
    getPublicArenaSettings,
    validateAndMergeArenaSettings,
} = require('./arena-settings');
const {
    buildChallengeMatchups,
    buildRankingEntries,
    buildRegressionMatchups,
    inspectConfiguration,
    loadBotConfigText,
} = require('./bot-config');
const { normalizeRank } = require('./stats');

// 单独的 M 会进入随机队列；M#… 会创建可统计的普通 Match 房间，且需放入 WindBot 的 20 字符房名字段。
const PRIVATE_DUEL_ROOM_MIN = 100000000;
const PRIVATE_DUEL_ROOM_MAX = 999999999;
const MAX_WINDBOT_OUTPUT_LENGTH = 2000000;
const SCORE_POLL_MS = 15000;

function requestError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(signal.reason);
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function fetchWithTimeout(url, timeoutMs, signal, options) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    return fetch(url, { ...options, signal: combinedSignal });
}

function makeHttpUrl(host, port, pathname = '/') {
    const url = new URL('http://localhost');
    url.hostname = host;
    url.port = String(port);
    url.pathname = pathname;
    return url;
}

function sanitizeEnvironment() {
    const result = {};
    const actualNames = new Map();
    for (const [name, value] of Object.entries(process.env)) {
        const normalized = name.toUpperCase();
        if (actualNames.has(normalized)) {
            delete result[actualNames.get(normalized)];
        }
        result[name] = value;
        actualNames.set(normalized, name);
    }
    return result;
}

class ArenaService {
    constructor(runtimeConfig, database) {
        this.runtimeConfig = runtimeConfig;
        this.database = database;
        this.current = null;
        this.revisions = {
            active: 0,
            runs: 0,
            system: 0,
        };
        this.windbotOutputs = {
            current: { active: false, output: '', updatedAt: null },
            old: { active: false, output: '', updatedAt: null },
        };
    }

    initialize() {
        return this.database.markActiveRunsInterrupted();
    }

    inspectSystem() {
        const { settings } = this.database.getArenaSettings();
        const inspection = inspectConfiguration(settings);
        return {
            botConfigFingerprints: this.getBotConfigFingerprints(settings),
            configuration: inspection,
            endpoints: {
                web: `http://${this.runtimeConfig.listenHost}:${this.runtimeConfig.listenPort}`,
            },
            srvpro: {
                duelPort: settings.srvpro.duelPort,
                host: settings.srvpro.host,
                statusPort: settings.srvpro.statusPort,
            },
            windbots: Object.fromEntries(
                Object.entries(settings.windbots).map(([name, instance]) => [name, {
                    host: instance.mode === 'local' ? '127.0.0.1' : instance.host,
                    mode: instance.mode,
                    port: instance.port,
                }]),
            ),
        };
    }

    getBotConfigFingerprints(settings) {
        return Object.fromEntries(Object.entries(settings.windbots).map(([name, instance]) => {
            try {
                const content = loadBotConfigText(instance, name === 'current' ? '新版' : '旧版');
                return [name, crypto.createHash('sha256').update(content).digest('hex')];
            } catch {
                return [name, null];
            }
        }));
    }

    getSettings() {
        const record = this.database.getArenaSettings();
        return getPublicArenaSettings(record.settings, record.updatedAt);
    }

    getRevisions() {
        return { ...this.revisions };
    }

    async listRooms() {
        const { settings } = this.database.getArenaSettings();
        let rooms;
        try {
            rooms = await this.fetchRooms(settings.srvpro);
        } catch (error) {
            throw requestError(`无法查询 SRVPro 房间: ${error.message}`, 502);
        }
        return {
            fetchedAt: new Date().toISOString(),
            rooms: rooms.map((room) => ({
                id: String(room.roomid ?? ''),
                name: String(room.roomname ?? ''),
                players: Array.isArray(room.users)
                    ? room.users
                        .filter((user) => user && user.pos !== 7)
                        .slice(0, 2)
                        .map((user) => ({
                            name: String(user.name ?? ''),
                            status: user.status && typeof user.status === 'object'
                                ? {
                                    lp: user.status.lp ?? null,
                                    score: user.status.score ?? null,
                                }
                                : null,
                        }))
                    : [],
                status: String(room.istart ?? ''),
            })),
        };
    }

    getWindBotOutput(name) {
        if (!['current', 'old'].includes(name)) {
            throw requestError('未知的 WindBot 实例', 404);
        }
        const { settings } = this.database.getArenaSettings();
        const instance = settings.windbots[name];
        if (instance.mode === 'remote') {
            return {
                active: false,
                available: false,
                mode: 'remote',
                output: '',
                updatedAt: null,
            };
        }
        return {
            ...this.windbotOutputs[name],
            available: true,
            mode: 'local',
        };
    }

    appendWindBotOutput(name, output) {
        const entry = this.windbotOutputs[name];
        entry.output = `${entry.output}${output}`.slice(-MAX_WINDBOT_OUTPUT_LENGTH);
        entry.updatedAt = new Date().toISOString();
    }

    async updateSettings(input) {
        if (this.current) {
            throw requestError('测试运行期间不能修改系统配置', 409);
        }
        const record = this.database.getArenaSettings();
        let settings;
        try {
            settings = validateAndMergeArenaSettings(input, record.settings);
        } catch (error) {
            throw requestError(error.message);
        }
        await this.fetchRemoteBotConfigs(settings);
        const saved = this.database.saveArenaSettings(settings);
        this.markChanged('settings');
        return getPublicArenaSettings(saved.settings, saved.updatedAt);
    }

    async fetchRemoteBotConfigs(settings) {
        const sources = Object.entries(settings.windbots)
            .filter(([, instance]) => instance.mode === 'remote' && instance.botConfUrl)
            .map(async ([name, instance]) => {
                let response;
                try {
                    response = await fetchWithTimeout(instance.botConfUrl, 10000);
                } catch (error) {
                    throw requestError(
                        `${name === 'current' ? '新版' : '旧版'} bot.conf URL 获取失败: ${error.message}`,
                        502,
                    );
                }
                if (!response.ok) {
                    throw requestError(
                        `${name === 'current' ? '新版' : '旧版'} bot.conf URL 返回 HTTP ${response.status}`,
                        502,
                    );
                }
                const contentLength = Number(response.headers.get('content-length'));
                if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
                    throw requestError(`${name === 'current' ? '新版' : '旧版'} bot.conf 超过 2 MB`, 502);
                }
                let content;
                try {
                    content = await response.text();
                } catch (error) {
                    throw requestError(
                        `${name === 'current' ? '新版' : '旧版'} bot.conf URL 读取失败: ${error.message}`,
                        502,
                    );
                }
                if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
                    throw requestError(`${name === 'current' ? '新版' : '旧版'} bot.conf 超过 2 MB`, 502);
                }
                if (!content.trim()) {
                    throw requestError(`${name === 'current' ? '新版' : '旧版'} bot.conf URL 返回了空内容`, 502);
                }
                return [name, content, content !== instance.botConfText];
            });
        const fetched = await Promise.all(sources);
        for (const [name, content] of fetched) {
            settings.windbots[name].botConfText = content;
        }
        return {
            changedCount: fetched.filter(([, , changed]) => changed).length,
            fetchedCount: fetched.length,
        };
    }

    async refreshBotConfigs() {
        if (this.current) {
            throw requestError('测试运行期间不能刷新 bot.conf', 409);
        }
        const record = this.database.getArenaSettings();
        const settings = structuredClone(record.settings);
        const { changedCount, fetchedCount } = await this.fetchRemoteBotConfigs(settings);
        if (fetchedCount > 0) {
            this.database.saveArenaSettings(settings);
        }
        const inspection = inspectConfiguration(settings);
        this.markChanged('decks');
        return {
            botConfigFingerprints: this.getBotConfigFingerprints(settings),
            configuration: inspection,
            contentChanged: changedCount > 0,
            fetchedRemoteCount: fetchedCount,
        };
    }

    listDecks() {
        const { settings } = this.database.getArenaSettings();
        const inspection = inspectConfiguration(settings);
        return {
            currentDecks: inspection.currentDecks,
            regressionDecks: inspection.decks,
        };
    }

    createRun(input = {}) {
        if (this.current) {
            throw requestError('已有测试正在运行，请先停止当前测试', 409);
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw requestError('测试配置必须是对象');
        }
        const kind = input.kind || 'regression';
        if (!['challenge', 'ranking', 'regression'].includes(kind)) {
            throw requestError('不支持的测试类型');
        }
        if (input.decks !== undefined && !Array.isArray(input.decks)) {
            throw requestError('decks 必须是卡组名称数组');
        }
        if (input.decks?.some((deck) => typeof deck !== 'string' || deck.trim() === '')) {
            throw requestError('卡组名称不能为空');
        }
        if (
            kind === 'challenge'
            && (typeof input.targetDeck !== 'string' || input.targetDeck.trim() === '')
        ) {
            throw requestError('挑战卡组名称不能为空');
        }
        let gamesPerMatchup = 0;
        if (kind === 'regression') {
            gamesPerMatchup = Number(input.gamesPerMatchup);
            if (!Number.isInteger(gamesPerMatchup) || gamesPerMatchup < 1 || gamesPerMatchup > 10000) {
                throw requestError('每个卡组的局数必须是 1 到 10000 之间的整数');
            }
        }

        const { settings } = this.database.getArenaSettings();
        const modeConfiguration = inspectConfiguration(settings).modes[kind];
        if (!modeConfiguration.valid) {
            throw requestError(`系统配置未完成：${modeConfiguration.issues.join('；')}`);
        }
        let matchups;
        let normalizedTargetDeck = null;
        try {
            if (kind === 'challenge') {
                matchups = buildChallengeMatchups(settings, input.targetDeck, input.decks);
                normalizedTargetDeck = matchups[0].competitors[0].deck;
            } else if (kind === 'ranking') {
                matchups = buildRankingEntries(settings, input.decks);
            } else {
                matchups = buildRegressionMatchups(settings, input.decks);
            }
        } catch (error) {
            throw requestError(error.message);
        }
        const id = crypto.randomUUID();
        const stored = this.database.createRun({
            config: {
                duelServer: `${settings.srvpro.host}:${settings.srvpro.duelPort}`,
                windbots: Object.fromEntries(
                    Object.entries(settings.windbots).map(([name, instance]) => [name, {
                        endpoint: `${instance.mode === 'local' ? '127.0.0.1' : instance.host}:${instance.port}`,
                        mode: instance.mode,
                    }]),
                ),
                selection: input.decks?.length ? 'selected' : 'all',
                targetDeck: normalizedTargetDeck,
            },
            createdAt: new Date().toISOString(),
            gamesPerMatchup,
            id,
            kind,
            matchups,
        });

        const context = {
            abortController: new AbortController(),
            children: [],
            finished: false,
            gamesPerMatchup,
            id,
            kind,
            latestObserved: new Map(),
            matchups: matchups.map((matchup, index) => ({
                ...matchup,
                id: stored.matchups[index].id,
                launchedGames: 0,
            })),
            nextMatchupIndex: 0,
            nextPrivateRoomNumber: crypto.randomInt(
                PRIVATE_DUEL_ROOM_MIN,
                PRIVATE_DUEL_ROOM_MAX + 1,
            ),
            settings,
            stopReason: null,
            totalGames: kind === 'regression' ? matchups.length * gamesPerMatchup : 0,
        };
        this.current = context;
        this.markChanged('created');
        context.done = this.execute(context);
        return stored;
    }

    createRegressionRun(input = {}) {
        return this.createRun({ ...input, kind: 'regression' });
    }

    async execute(context) {
        const { signal } = context.abortController;
        try {
            this.database.addEvent(context.id, 'info', 'preparing', '正在重启 SRVPro 并清理旧对局');
            this.markChanged('preparing');
            await this.rebootServer(context);
            this.database.addEvent(context.id, 'info', 'server-ready', 'SRVPro 已重启并恢复服务');
            this.markChanged('run-event');

            const instances = [['current', '新版', context.settings.windbots.current]];
            if (context.kind === 'regression') {
                instances.push(['old', '旧版', context.settings.windbots.old]);
            }
            const readiness = instances.map(([name, label, instance]) => {
                const endpointHost = instance.mode === 'local' ? '127.0.0.1' : instance.host;
                const child = instance.mode === 'local'
                    ? this.startWindBot(context, name, label, instance)
                    : null;
                if (instance.mode === 'remote') {
                    this.database.addEvent(
                        context.id,
                        'info',
                        'remote-windbot',
                        `${label}使用远程 WindBot ${endpointHost}:${instance.port}`,
                    );
                    this.markChanged('run-event');
                }
                return this.waitForWindBot(label, endpointHost, instance.port, child, signal);
            });
            await Promise.all(readiness);

            this.database.setRunStatus(context.id, 'running');
            this.database.addEvent(
                context.id,
                'info',
                'running',
                `${context.kind === 'regression' ? '两套' : '新版'} WindBot 已就绪，开始创建对局`,
            );
            this.markChanged('running');
            context.scorePoller = this.pollScores(context);
            await this.scheduleGames(context);

            if (context.kind !== 'regression') {
                throw new Error('无限测试的调度意外结束');
            }
            this.database.setRunStatus(context.id, 'settling');
            this.database.addEvent(context.id, 'info', 'settling', '对局已全部创建，正在等待排行统计');
            this.markChanged('settling');
            const fullyObserved = await this.waitForResults(context);
            if (!fullyObserved) {
                this.database.addEvent(context.id, 'warning', 'settle-timeout', '等待排行统计超时，已保留现有结果');
            }
            await this.finish(context, 'completed', '测试已完成');
        } catch (error) {
            if (isAbortError(error) && context.stopReason) {
                await this.finish(context, 'stopped', context.stopReason);
                return;
            }
            const message = error?.message || String(error);
            await this.finish(context, 'failed', `测试失败: ${message}`, message);
        }
    }

    startWindBot(context, name, label, instance) {
        const child = childProcess.spawn(path.join(instance.runtimeDir, 'WindBot.exe'), [
            'ServerMode=True',
            `ServerPort=${instance.port}`,
            'Chat=False',
        ], {
            cwd: instance.runtimeDir,
            env: sanitizeEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        context.children.push(child);
        this.windbotOutputs[name] = {
            active: true,
            output: '',
            updatedAt: new Date().toISOString(),
        };
        // .NET Framework WindBot 在 Windows 重定向输出时使用系统中文代码页，而不是 UTF-8。
        const captureOutput = (stream, outputPrefix, logPrefix, destination) => {
            const decoder = new TextDecoder('gbk');
            const write = (output) => {
                if (!output) {
                    return;
                }
                this.appendWindBotOutput(name, `${outputPrefix}${output}`);
                destination.write(`${logPrefix}${output}`);
            };
            stream.on('data', (data) => write(decoder.decode(data, { stream: true })));
            stream.on('end', () => write(decoder.decode()));
        };
        captureOutput(child.stdout, '', `[${label}] `, process.stdout);
        captureOutput(child.stderr, '[错误] ', `[${label}:错误] `, process.stderr);
        child.on('error', (error) => {
            child.startError = error;
            this.appendWindBotOutput(name, `\n[启动失败] ${error.message}\n`);
        });
        child.on('exit', (code, signal) => {
            this.windbotOutputs[name].active = false;
            this.appendWindBotOutput(name, `\n[进程已退出] code=${code}, signal=${signal || 'none'}\n`);
            console.log(`[${label}] WindBot 已退出: code=${code}, signal=${signal}`);
        });
        return child;
    }

    async waitForWindBot(label, host, port, child, signal) {
        const deadline = Date.now() + 15000;
        const url = makeHttpUrl(host, port);
        while (Date.now() < deadline) {
            if (child?.startError) {
                throw child.startError;
            }
            if (child && child.exitCode !== null) {
                throw new Error(`${label} WindBot 在 HTTP 服务就绪前退出，code=${child.exitCode}`);
            }
            try {
                await fetchWithTimeout(url, 1000, signal);
                return;
            } catch (error) {
                if (signal.aborted) {
                    throw signal.reason;
                }
                await sleep(250, signal);
            }
        }
        throw new Error(`${label} WindBot HTTP 服务在 15 秒内没有就绪: ${host}:${port}`);
    }

    async fetchRooms(srvpro, signal) {
        const url = makeHttpUrl(srvpro.host, srvpro.statusPort, '/api/getrooms');
        url.searchParams.set('username', srvpro.username);
        url.searchParams.set('pass', srvpro.password);
        const response = await fetchWithTimeout(url, 5000, signal);
        if (!response.ok) {
            throw new Error(`房间 API 返回 HTTP ${response.status}`);
        }
        const body = await response.json();
        if (!Array.isArray(body.rooms)) {
            throw new Error('房间 API 响应中没有 rooms 数组');
        }
        if (body.rooms.some((room) => room?.roomid === '0' && room?.roomname === '密码错误')) {
            throw new Error('SRVPro 管理账号或密码错误');
        }
        return body.rooms;
    }

    async pollScores(context, intervalMs = SCORE_POLL_MS) {
        const { signal } = context.abortController;
        while (!signal.aborted && !context.finished && this.current === context) {
            try {
                const srvpro = context.settings.srvpro;
                const url = makeHttpUrl(srvpro.host, srvpro.statusPort, '/api/getscores');
                url.searchParams.set('type', 'private');
                url.searchParams.set('username', srvpro.username);
                url.searchParams.set('pass', srvpro.password);
                const response = await fetchWithTimeout(url, 5000, signal);
                if (!response.ok) {
                    throw new Error(`排行 API 返回 HTTP ${response.status}`);
                }
                const body = await response.json();
                if (body?.type !== 'private' || !Array.isArray(body.scores)) {
                    throw new Error('排行 API 响应格式无效');
                }
                const rank = body.scores.map((score, index) => {
                    if (!score || typeof score !== 'object' || Array.isArray(score)) {
                        throw new Error(`排行 API 的 scores[${index}] 不是对象`);
                    }
                    if (typeof score.name !== 'string') {
                        throw new Error(`排行 API 的 scores[${index}].name 不是字符串`);
                    }
                    return [score.name, {
                        combo: score.combo,
                        flee: score.flee,
                        lose: score.lose,
                        win: score.win,
                    }];
                });
                if (!signal.aborted && !context.finished && this.current === context) {
                    this.receiveRank(rank);
                }
            } catch (error) {
                if (signal.aborted || isAbortError(error)) {
                    return;
                }
                this.database.addEvent(
                    context.id,
                    'warning',
                    'score-poll-error',
                    `查询 SRVPro 排行失败: ${error.message}`,
                );
                this.markChanged('score-poll-error');
            }
            try {
                await sleep(intervalMs, signal);
            } catch (error) {
                if (signal.aborted || isAbortError(error)) {
                    return;
                }
                throw error;
            }
        }
    }

    async getRoomCount(context) {
        const rooms = await this.fetchRooms(
            context.settings.srvpro,
            context.abortController.signal,
        );
        return rooms.length;
    }

    async rebootServer(context) {
        const srvpro = context.settings.srvpro;
        const url = makeHttpUrl(srvpro.host, srvpro.statusPort, '/api/message');
        url.searchParams.set('username', srvpro.username);
        url.searchParams.set('pass', srvpro.password);
        url.searchParams.set('reboot', context.id);

        let rebootAccepted = false;
        let response;
        let body;
        try {
            response = await fetchWithTimeout(url, 10000, context.abortController.signal);
            body = await response.text();
        } catch (error) {
            if (context.abortController.signal.aborted) {
                throw context.abortController.signal.reason;
            }
        }
        if (response) {
            if (!response.ok || body.includes('密码错误') || body.includes('reboot fail')) {
                throw new Error(`服务端拒绝重启: HTTP ${response.status} ${body}`);
            }
            if (!body.includes('reboot ok')) {
                throw new Error(`无法确认服务端重启: ${body}`);
            }
            rebootAccepted = true;
        }

        const deadline = Date.now() + 120000;
        let consecutiveSuccesses = 0;
        let sawUnavailable = false;
        await sleep(1000, context.abortController.signal);
        while (Date.now() < deadline) {
            try {
                await this.getRoomCount(context);
                consecutiveSuccesses++;
                if ((rebootAccepted || sawUnavailable) && consecutiveSuccesses >= 2) {
                    return;
                }
            } catch (error) {
                if (context.abortController.signal.aborted) {
                    throw context.abortController.signal.reason;
                }
                sawUnavailable = true;
                consecutiveSuccesses = 0;
            }
            await sleep(1000, context.abortController.signal);
        }
        throw new Error('服务端在重启后 120 秒内没有恢复');
    }

    nextPrivateDuelPassword(context) {
        const roomNumber = context.nextPrivateRoomNumber
            ?? crypto.randomInt(PRIVATE_DUEL_ROOM_MIN, PRIVATE_DUEL_ROOM_MAX + 1);
        context.nextPrivateRoomNumber = roomNumber === PRIVATE_DUEL_ROOM_MAX
            ? PRIVATE_DUEL_ROOM_MIN
            : roomNumber + 1;
        return `M#${roomNumber}`;
    }

    async addBot(context, competitor, password) {
        const srvpro = context.settings.srvpro;
        const url = makeHttpUrl(competitor.endpointHost, competitor.endpointPort);
        url.searchParams.set('name', competitor.rankName);
        url.searchParams.set('host', srvpro.host);
        url.searchParams.set('port', String(srvpro.duelPort));
        url.searchParams.set('password', password);
        url.searchParams.set('deck', competitor.deck);
        url.searchParams.set('chat', 'false');
        if (competitor.dialog) {
            url.searchParams.set('dialog', competitor.dialog);
        }
        const response = await fetchWithTimeout(url, 5000, context.abortController.signal);
        if (!response.ok) {
            throw new Error(`${competitor.rankName} 启动请求返回 HTTP ${response.status}`);
        }
    }

    async closePrivateDuelRoom(context, password) {
        const srvpro = context.settings.srvpro;
        const url = makeHttpUrl(srvpro.host, srvpro.statusPort, '/api/message');
        url.searchParams.set('username', srvpro.username);
        url.searchParams.set('pass', srvpro.password);
        url.searchParams.set('kick', password);
        const response = await fetchWithTimeout(url, 5000);
        const body = await response.text();
        if (!response.ok || body.includes('密码错误')) {
            throw new Error(`SRVPro 拒绝关闭房间: HTTP ${response.status} ${body}`);
        }
        if (!body.includes('kick ok') && !body.includes('room not found')) {
            throw new Error(`无法确认 SRVPro 已关闭房间: ${body}`);
        }
    }

    async launchPair(context, players) {
        const scheduler = context.settings.scheduler;
        const password = this.nextPrivateDuelPassword(context);
        try {
            await this.addBot(context, players[0], password);
            if (scheduler.pairDelayMs > 0) {
                await sleep(scheduler.pairDelayMs, context.abortController.signal);
            }
            await this.addBot(context, players[1], password);
            if (scheduler.pairDelayMs > 0) {
                await sleep(scheduler.pairDelayMs, context.abortController.signal);
            }
        } catch (error) {
            try {
                await this.closePrivateDuelRoom(context, password);
            } catch (cleanupError) {
                if (!isAbortError(error)) {
                    throw new Error(
                        `${error.message}；关闭约战房间失败: ${cleanupError.message}`,
                        { cause: error },
                    );
                }
            }
            throw error;
        }
    }

    async launchMatchup(context, matchup) {
        const players = matchup.launchedGames % 2 === 0
            ? matchup.competitors
            : [...matchup.competitors].reverse();
        await this.launchPair(context, players);
    }

    async launchRankingPair(context, entries) {
        const players = entries.map((entry) => entry.competitors[0]);
        if (Math.random() < 0.5) {
            players.reverse();
        }
        await this.launchPair(context, players);
    }

    async scheduleGames(context) {
        const { scheduler, srvpro } = context.settings;
        let consecutiveErrors = 0;
        let launchedGames = 0;
        while (context.kind !== 'regression' || launchedGames < context.totalGames) {
            try {
                const roomCount = await this.getRoomCount(context);
                this.database.setRoomCount(context.id, roomCount);
                const availableRooms = Math.max(0, srvpro.maxRooms - roomCount);
                const toLaunch = Math.min(
                    availableRooms,
                    scheduler.pairsPerTick,
                    context.kind === 'regression'
                        ? context.totalGames - launchedGames
                        : scheduler.pairsPerTick,
                );

                for (let index = 0; index < toLaunch; index++) {
                    if (context.kind === 'ranking') {
                        const firstIndex = Math.floor(Math.random() * context.matchups.length);
                        let secondIndex = Math.floor(Math.random() * (context.matchups.length - 1));
                        if (secondIndex >= firstIndex) {
                            secondIndex++;
                        }
                        const entries = [context.matchups[firstIndex], context.matchups[secondIndex]];
                        await this.launchRankingPair(context, entries);
                        entries.forEach((entry) => { entry.launchedGames++; });
                        launchedGames++;
                        this.database.recordLaunch(context.id, entries.map((entry) => entry.id));
                        this.markChanged('progress');
                        continue;
                    }

                    let matchupIndex = context.nextMatchupIndex;
                    if (context.kind === 'regression') {
                        matchupIndex = -1;
                        for (let offset = 0; offset < context.matchups.length; offset++) {
                            const candidate = (context.nextMatchupIndex + offset) % context.matchups.length;
                            if (context.matchups[candidate].launchedGames < context.gamesPerMatchup) {
                                matchupIndex = candidate;
                                break;
                            }
                        }
                        if (matchupIndex === -1) {
                            break;
                        }
                    }
                    const matchup = context.matchups[matchupIndex];
                    await this.launchMatchup(context, matchup);
                    matchup.launchedGames++;
                    launchedGames++;
                    context.nextMatchupIndex = (matchupIndex + 1) % context.matchups.length;
                    this.database.recordLaunch(context.id, [matchup.id]);
                    this.markChanged('progress');
                }
                consecutiveErrors = 0;
            } catch (error) {
                if (context.abortController.signal.aborted) {
                    throw context.abortController.signal.reason;
                }
                consecutiveErrors++;
                this.database.addEvent(context.id, 'warning', 'schedule-error', error.message);
                this.markChanged('schedule-error');
                if (consecutiveErrors >= 10) {
                    throw new Error('连续 10 次无法查询房间或创建 bot，已停止调度');
                }
            }
            await sleep(scheduler.pollMs, context.abortController.signal);
        }
    }

    async waitForResults(context) {
        const { scheduler } = context.settings;
        const deadline = Date.now() + scheduler.settleMinutes * 60 * 1000;
        while (Date.now() < deadline) {
            const complete = context.matchups.every(
                (matchup) => (context.latestObserved.get(matchup.id) || 0) >= context.gamesPerMatchup,
            );
            if (complete) {
                return true;
            }
            await sleep(Math.min(scheduler.pollMs, 5000), context.abortController.signal);
        }
        return false;
    }

    receiveRank(rank) {
        const normalized = normalizeRank(rank);
        const context = this.current;
        const receivedAt = this.database.recordRank(context?.id || null, normalized, rank);
        if (!context) {
            this.markChanged('rank');
            return { matchedRunId: null, receivedAt };
        }

        const rankMap = new Map(normalized);
        for (const matchup of context.matchups) {
            const observed = matchup.competitors.map(
                (competitor) => rankMap.get(competitor.rankName)?.games || 0,
            );
            context.latestObserved.set(matchup.id, Math.min(...observed));
        }
        this.markChanged('rank');
        return { matchedRunId: context.id, receivedAt };
    }

    stopRun(runId, reason = '用户从 Web 界面停止了测试') {
        if (!this.current || this.current.id !== runId) {
            throw requestError('该测试当前不在运行', 409);
        }
        const context = this.current;
        if (!context.stopReason) {
            context.stopReason = reason;
            this.database.setRunStatus(runId, 'stopping');
            this.database.addEvent(runId, 'warning', 'stopping', reason);
            context.abortController.abort(new DOMException(reason, 'AbortError'));
            this.markChanged('stopping');
        }
        return this.database.getRun(runId);
    }

    async finish(context, status, reason, error = null) {
        if (context.finished) {
            return;
        }
        context.finished = true;
        if (!context.abortController.signal.aborted) {
            context.abortController.abort(new DOMException('任务已结束', 'AbortError'));
        }
        await context.scorePoller;
        for (const child of context.children) {
            if (child.exitCode === null) {
                child.kill();
            }
        }
        this.database.setRunStatus(context.id, status, {
            error,
            finishedAt: new Date().toISOString(),
            stopReason: reason,
        });
        this.database.addEvent(
            context.id,
            status === 'failed' ? 'error' : 'info',
            status,
            reason,
        );
        if (this.current === context) {
            this.current = null;
        }
        this.markChanged(status);
    }

    markChanged(reason) {
        if (reason === 'settings' || reason === 'decks') {
            this.revisions.system++;
            return;
        }
        this.revisions.active++;
        if (
            reason !== 'progress'
            && reason !== 'rank'
            && reason !== 'run-event'
            && reason !== 'schedule-error'
            && reason !== 'score-poll-error'
        ) {
            this.revisions.runs++;
        }
    }

    async shutdown() {
        const context = this.current;
        if (!context) {
            return;
        }
        this.stopRun(context.id, 'Arena 服务正在关闭');
        await context.done;
    }
}

module.exports = { ArenaService, SCORE_POLL_MS, requestError };
