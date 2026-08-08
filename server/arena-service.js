'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const {
    getPublicArenaSettings,
    validateAndMergeArenaSettings,
} = require('./arena-settings');
const {
    buildRegressionMatchups,
    getRegressionCatalog,
    inspectConfiguration,
} = require('./bot-config');
const { normalizeRank } = require('./stats');

// “M”是 SRVPro 进入随机对战统计模式的协议值，不是房间密码或用户配置。
const MATCH_MODE_PASSWORD = 'M';

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

async function fetchWithTimeout(url, timeoutMs, signal) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    return fetch(url, { signal: combinedSignal });
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

class ArenaService extends EventEmitter {
    constructor(runtimeConfig, database) {
        super();
        this.runtimeConfig = runtimeConfig;
        this.database = database;
        this.current = null;
    }

    initialize() {
        return this.database.markActiveRunsInterrupted();
    }

    inspectSystem() {
        const { settings } = this.database.getArenaSettings();
        const inspection = inspectConfiguration(settings);
        return {
            activeRunId: this.current?.id || null,
            configuration: inspection,
            endpoints: {
                rankPost: settings.srvpro.rankPostPath,
                web: `http://${this.runtimeConfig.listenHost}:${this.runtimeConfig.listenPort}`,
            },
            storage: {
                database: this.runtimeConfig.databasePath,
            },
            latestRankAt: this.database.getLatestRankAt(),
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

    getSettings() {
        const record = this.database.getArenaSettings();
        return getPublicArenaSettings(record.settings, record.updatedAt);
    }

    updateSettings(input) {
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
        const saved = this.database.saveArenaSettings(settings);
        this.emitChange(null, 'settings');
        return getPublicArenaSettings(saved.settings, saved.updatedAt);
    }

    getRankAccessKey() {
        return this.database.getArenaSettings().settings.srvpro.accessKey;
    }

    getRankPostPath() {
        return this.database.getArenaSettings().settings.srvpro.rankPostPath;
    }

    listDecks() {
        const { settings } = this.database.getArenaSettings();
        return getRegressionCatalog(settings).map((item) => ({
            currentLabel: item.current.label,
            deck: item.deck,
            oldLabel: item.old.label,
        }));
    }

    createRegressionRun(input = {}) {
        if (this.current) {
            throw requestError('已有测试正在运行，请先停止当前测试', 409);
        }
        const gamesPerMatchup = Number(input.gamesPerMatchup);
        if (!Number.isInteger(gamesPerMatchup) || gamesPerMatchup < 1 || gamesPerMatchup > 10000) {
            throw requestError('每个对局组的局数必须是 1 到 10000 之间的整数');
        }
        if (input.decks !== undefined && !Array.isArray(input.decks)) {
            throw requestError('decks 必须是卡组名称数组');
        }
        if (input.decks?.some((deck) => typeof deck !== 'string' || deck.trim() === '')) {
            throw requestError('卡组名称不能为空');
        }

        const { settings } = this.database.getArenaSettings();
        let matchups;
        try {
            matchups = buildRegressionMatchups(settings, input.decks);
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
            },
            createdAt: new Date().toISOString(),
            gamesPerMatchup,
            id,
            kind: 'regression',
            matchups,
        });

        const context = {
            abortController: new AbortController(),
            children: [],
            finished: false,
            gamesPerMatchup,
            id,
            latestObserved: new Map(),
            matchups: matchups.map((matchup, index) => ({
                ...matchup,
                id: stored.matchups[index].id,
                launchedGames: 0,
            })),
            nextMatchupIndex: 0,
            settings,
            stopReason: null,
            totalGames: matchups.length * gamesPerMatchup,
        };
        this.current = context;
        this.emitChange(id, 'created');
        context.done = this.execute(context);
        return stored;
    }

    async execute(context) {
        const { signal } = context.abortController;
        try {
            this.database.setRunStatus(context.id, 'preparing', {
                startedAt: new Date().toISOString(),
            });
            this.database.addEvent(context.id, 'info', 'preparing', '正在重启 SRVPro 并清理旧对局');
            this.emitChange(context.id, 'preparing');
            await this.rebootServer(context);
            this.database.addEvent(context.id, 'info', 'server-ready', 'SRVPro 已重启并恢复服务');

            const instances = [
                ['新版', context.settings.windbots.current],
                ['旧版', context.settings.windbots.old],
            ];
            const readiness = instances.map(([label, instance]) => {
                const endpointHost = instance.mode === 'local' ? '127.0.0.1' : instance.host;
                const child = instance.mode === 'local'
                    ? this.startWindBot(context, label, instance)
                    : null;
                if (instance.mode === 'remote') {
                    this.database.addEvent(
                        context.id,
                        'info',
                        'remote-windbot',
                        `${label}使用远程 WindBot ${endpointHost}:${instance.port}`,
                    );
                }
                return this.waitForWindBot(label, endpointHost, instance.port, child, signal);
            });
            await Promise.all(readiness);

            this.database.setRunStatus(context.id, 'running');
            this.database.addEvent(context.id, 'info', 'running', '两套 WindBot 已就绪，开始创建对局');
            this.emitChange(context.id, 'running');
            await this.scheduleGames(context);

            this.database.setRunStatus(context.id, 'settling');
            this.database.addEvent(context.id, 'info', 'settling', '对局已全部创建，正在等待排行统计回报');
            this.emitChange(context.id, 'settling');
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

    startWindBot(context, label, instance) {
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
        child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
        child.stderr.on('data', (data) => process.stderr.write(`[${label}:错误] ${data}`));
        child.on('error', (error) => {
            child.startError = error;
        });
        child.on('exit', (code, signal) => {
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

    async getRoomCount(context) {
        const srvpro = context.settings.srvpro;
        const url = makeHttpUrl(srvpro.host, srvpro.statusPort, '/api/getrooms');
        url.searchParams.set('username', srvpro.username);
        url.searchParams.set('pass', srvpro.password);
        const response = await fetchWithTimeout(url, 5000, context.abortController.signal);
        if (!response.ok) {
            throw new Error(`房间 API 返回 HTTP ${response.status}`);
        }
        const body = await response.json();
        if (!Array.isArray(body.rooms)) {
            throw new Error('房间 API 响应中没有 rooms 数组');
        }
        return body.rooms.length;
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

    async addBot(context, competitor) {
        const srvpro = context.settings.srvpro;
        const url = makeHttpUrl(competitor.endpointHost, competitor.endpointPort);
        url.searchParams.set('name', competitor.rankName);
        url.searchParams.set('host', srvpro.host);
        url.searchParams.set('port', String(srvpro.duelPort));
        url.searchParams.set('password', MATCH_MODE_PASSWORD);
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

    async launchMatchup(context, matchup) {
        const scheduler = context.settings.scheduler;
        const players = matchup.launchedGames % 2 === 0
            ? matchup.competitors
            : [...matchup.competitors].reverse();
        await this.addBot(context, players[0]);
        if (scheduler.pairDelayMs > 0) {
            await sleep(scheduler.pairDelayMs, context.abortController.signal);
        }
        await this.addBot(context, players[1]);
        if (scheduler.pairDelayMs > 0) {
            await sleep(scheduler.pairDelayMs, context.abortController.signal);
        }
    }

    async scheduleGames(context) {
        const { scheduler, srvpro } = context.settings;
        let consecutiveErrors = 0;
        let launchedGames = 0;
        while (launchedGames < context.totalGames) {
            try {
                const roomCount = await this.getRoomCount(context);
                this.database.setRoomCount(context.id, roomCount);
                const availableRooms = Math.max(0, srvpro.maxRooms - roomCount);
                const toLaunch = Math.min(
                    availableRooms,
                    scheduler.pairsPerTick,
                    context.totalGames - launchedGames,
                );

                for (let index = 0; index < toLaunch; index++) {
                    let matchupIndex = -1;
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
                    const matchup = context.matchups[matchupIndex];
                    await this.launchMatchup(context, matchup);
                    matchup.launchedGames++;
                    launchedGames++;
                    context.nextMatchupIndex = (matchupIndex + 1) % context.matchups.length;
                    this.database.incrementLaunched(context.id, matchup.id);
                    this.emitChange(context.id, 'progress');
                }
                consecutiveErrors = 0;
            } catch (error) {
                if (context.abortController.signal.aborted) {
                    throw context.abortController.signal.reason;
                }
                consecutiveErrors++;
                this.database.addEvent(context.id, 'warning', 'schedule-error', error.message);
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
            this.emitChange(null, 'rank');
            return { matchedRunId: null, receivedAt };
        }

        const rankMap = new Map(normalized);
        for (const matchup of context.matchups) {
            const observed = matchup.competitors.map(
                (competitor) => rankMap.get(competitor.rankName)?.games || 0,
            );
            context.latestObserved.set(matchup.id, Math.min(...observed));
        }
        this.emitChange(context.id, 'rank');
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
            this.emitChange(runId, 'stopping');
        }
        return this.database.getRun(runId);
    }

    async finish(context, status, reason, error = null) {
        if (context.finished) {
            return;
        }
        context.finished = true;
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
        this.emitChange(context.id, status);
    }

    emitChange(runId, reason) {
        this.emit('change', { reason, runId });
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

module.exports = { ArenaService, requestError };
