'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const scriptDir = __dirname;
const settings = require('./settings.js');
const booleanOptions = new Set([
    'dry-run',
    'help',
    'list-decks',
]);
const valueOptions = new Set(['deck', 'games']);

function parseArguments(args) {
    const values = {};
    const positional = [];

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!argument.startsWith('--')) {
            positional.push(argument);
            continue;
        }

        const equalIndex = argument.indexOf('=');
        const name = argument.substring(2, equalIndex === -1 ? undefined : equalIndex);
        if (booleanOptions.has(name)) {
            values[name] = true;
        } else if (!valueOptions.has(name)) {
            throw new Error(`无法识别的参数: --${name}`);
        } else if (equalIndex !== -1) {
            values[name] = argument.substring(equalIndex + 1);
        } else {
            index++;
            if (index >= args.length || args[index].startsWith('--')) {
                throw new Error(`参数 --${name} 缺少值`);
            }
            values[name] = args[index];
        }
    }

    if (positional.length > 2) {
        throw new Error(`无法识别的位置参数: ${positional.slice(2).join(' ')}`);
    }
    if (positional.length >= 1 && values.deck === undefined) {
        values.deck = positional[0];
    }
    if (positional.length === 2 && values.games === undefined) {
        values.games = positional[1];
    }

    return values;
}

function readPositiveInteger(value, defaultValue, optionName) {
    if (value === undefined) {
        return defaultValue;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${optionName} 必须是正整数`);
    }
    return parsed;
}

function makeRunId() {
    return new Date().toISOString().replace(/\D/g, '').substring(2, 14);
}

function sanitizeFileName(value) {
    return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function loadBotsFromConf(confPath) {
    if (!fs.existsSync(confPath)) {
        throw new Error(`bot.conf 不存在: ${confPath}`);
    }

    const bots = new Map();
    const blocks = fs.readFileSync(confPath, 'utf8').split(/(?=^!)/m);
    for (const block of blocks) {
        const match = block.match(
            /^!([^\r\n]+)[\s\S]*?^Name=\S+\s+Deck=(?:'([^']+)'|(\S+))\s+Dialog=(\S+)/m,
        );
        if (!match || /^\s*AI_LV1(?:\s|$)/m.test(block) || /\bSELECT_DECKFILE\b/.test(block)) {
            continue;
        }

        const deck = match[2] || match[3];
        bots.set(deck, {
            deck,
            dialog: match[4],
            label: match[1],
        });
    }
    return bots;
}

function showHelp() {
    console.log(`
用法:
  node test-ai.js
  node test-ai.js all 100
  node test-ai.js Dragunity
  node test-ai.js Dragunity 500
  node test-ai.js --deck Dragunity --games 500

参数:
  第一个参数 / --deck       Deck 名称；不填或填 all 时运行新旧版本的全部交集
  第二个参数 / --games      每个卡组的对局数；全部卡组默认 100，单卡组默认 500
  --dry-run                 只校验配置，不启动进程或发送请求
  --list-decks              列出两份 bot.conf 中可用的共同 Deck
  --help                    显示本说明

全部卡组模式会轮流创建各卡组对局，避免单一卡组占满房间。结果会写入
test-ai-results/<run-id>-<deck 或 all>.jsonl。Ctrl+C 会停止调度，
关闭本脚本启动的 WindBot 进程，并保留已经收到的统计。正式运行前会
通过管理 API 重启 SRVPro，清空旧房间和旧统计。排行榜名称固定使用
“新/旧-bot.conf 显示名称”，不会随运行次数新增榜单项目。
`.trim());
}

function buildOptions(raw) {
    const runId = makeRunId();
    const allDecks = !raw.deck || raw.deck.toLowerCase() === 'all';
    const deck = allDecks ? null : raw.deck;
    const resultName = `${sanitizeFileName(runId)}-${sanitizeFileName(deck || 'all')}.jsonl`;

    return {
        ...settings,
        allDecks,
        currentDir: path.resolve(settings.currentDir),
        deck,
        dryRun: raw['dry-run'] === true,
        gamesPerDeck: readPositiveInteger(raw.games, allDecks ? 100 : 500, 'games'),
        oldDir: path.resolve(settings.oldDir),
        outputPath: path.join(scriptDir, 'test-ai-results', resultName),
        runId,
    };
}

function validateOptions(options, currentBots, oldBots) {
    if (options.currentPort === options.oldPort) {
        throw new Error('新版和旧版 WindBot HTTP 端口不能相同');
    }

    for (const [label, runtimeDir] of [
        ['新版', options.currentDir],
        ['旧版', options.oldDir],
    ]) {
        const exePath = path.join(runtimeDir, 'WindBot.exe');
        if (!fs.existsSync(exePath)) {
            throw new Error(`${label}程序不存在: ${exePath}`);
        }
    }

    let botPairs;
    if (options.allDecks) {
        botPairs = [...currentBots.values()]
            .filter((bot) => oldBots.has(bot.deck))
            .map((current) => ({ current, old: oldBots.get(current.deck) }));
    } else {
        const current = currentBots.get(options.deck);
        const old = oldBots.get(options.deck);
        if (!current || !old) {
            throw new Error(
                `Deck="${options.deck}" 不同时存在于两份可用 bot.conf 列表中；` +
                '使用 --list-decks 查看名称',
            );
        }
        botPairs = [{ current, old }];
    }

    if (botPairs.length === 0) {
        throw new Error('新旧版本之间没有可运行的共同卡组');
    }

    options.matchups = botPairs.map((pair) => {
        let currentDialog = pair.current.dialog;
        let oldDialog = pair.old.dialog;
        if (!fs.existsSync(path.join(options.currentDir, 'Dialogs', `${currentDialog}.json`))) {
            currentDialog = null;
        }
        if (!fs.existsSync(path.join(options.oldDir, 'Dialogs', `${oldDialog}.json`))) {
            oldDialog = null;
        }

        return {
            currentDialog,
            currentLabel: pair.current.label,
            deck: pair.current.deck,
            newName: `新-${pair.current.label}`,
            oldDialog,
            oldLabel: pair.old.label,
            oldName: `旧-${pair.old.label}`,
        };
    });

    const rankNames = options.matchups.flatMap((matchup) => [matchup.newName, matchup.oldName]);
    if (new Set(rankNames).size !== rankNames.length) {
        throw new Error('两份 bot.conf 生成了重复的排行榜名称');
    }
    if (rankNames.some((name) => [...name].length > 20)) {
        throw new Error('bot.conf 中存在加版本前缀后超过 20 个字符的机器人名称');
    }
    if (rankNames.length > settings.maxRankNames) {
        throw new Error(`共同卡组会生成 ${rankNames.length} 个机器人名称，超过排行榜 ${settings.maxRankNames} 条限制`);
    }
    options.totalGames = options.matchups.length * options.gamesPerDeck;
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
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

function startWindBot(label, runtimeDir, port) {
    const exePath = path.join(runtimeDir, 'WindBot.exe');
    const child = childProcess.spawn(exePath, [
        'ServerMode=True',
        `ServerPort=${port}`,
        'Chat=False',
    ], {
        cwd: runtimeDir,
        env: sanitizeEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
    child.stderr.on('data', (data) => process.stderr.write(`[${label}:错误] ${data}`));
    child.on('exit', (code, signal) => {
        console.log(`[${label}] WindBot 已退出: code=${code}, signal=${signal}`);
    });
    return child;
}

async function waitForWindBot(label, port, child) {
    const deadline = Date.now() + 15000;
    const url = `http://127.0.0.1:${port}/`;
    while (Date.now() < deadline) {
        if (child && child.exitCode !== null) {
            throw new Error(`${label} WindBot 在 HTTP 服务就绪前退出，code=${child.exitCode}`);
        }
        try {
            await fetchWithTimeout(url, 1000);
            console.log(`[${label}] HTTP 服务已就绪: ${url}`);
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error(`${label} WindBot HTTP 服务在 15 秒内没有就绪: ${url}`);
}

function calculateStats(stats) {
    if (!stats) {
        return null;
    }

    const win = Number(stats.win) || 0;
    const lose = Number(stats.lose) || 0;
    const flee = Number(stats.flee) || 0;
    const combo = Number(stats.combo) || 0;
    const games = win + lose + flee;
    return {
        combo,
        flee,
        games,
        lose,
        strictWinRate: games === 0 ? 0 : win / games,
        win,
        winRate: win + lose === 0 ? 0 : win / (win + lose),
    };
}

function formatPercentage(value) {
    return `${(value * 100).toFixed(2)}%`;
}

function printComparison(options, rank) {
    const rankMap = new Map(rank);
    const comparisons = options.matchups.map((matchup) => ({
        current: calculateStats(rankMap.get(matchup.newName)),
        deck: matchup.deck,
        newName: matchup.newName,
        old: calculateStats(rankMap.get(matchup.oldName)),
        oldName: matchup.oldName,
    }));
    const visible = comparisons.filter((comparison) => comparison.current || comparison.old);
    if (visible.length === 0) {
        console.log(`[统计] 已收到 ${rank.length} 个榜单项目，尚未出现本次新旧 bot`);
        return comparisons;
    }

    console.log('');
    console.log(`统计时间 ${new Date().toLocaleString()}`);
    console.log('卡组                              新胜/负/逃  旧胜/负/逃  新版严格胜率  胜方占比  进度');
    for (const comparison of visible) {
        const current = comparison.current || calculateStats({});
        const old = comparison.old || calculateStats({});
        const decidedGames = current.win + old.win;
        const headToHead = decidedGames === 0 ? 0 : current.win / decidedGames;
        const progress = Math.min(current.games, old.games);
        console.log(
            `${comparison.deck.padEnd(33)} ` +
            `${`${current.win}/${current.lose}/${current.flee}`.padStart(9)}  ` +
            `${`${old.win}/${old.lose}/${old.flee}`.padStart(9)}  ` +
            `${formatPercentage(current.strictWinRate).padStart(12)}  ` +
            `${formatPercentage(headToHead).padStart(8)}  ` +
            `${String(progress).padStart(3)}/${options.gamesPerDeck}`,
        );
    }

    const totals = visible.reduce((result, comparison) => {
        for (const side of ['current', 'old']) {
            const stats = comparison[side];
            if (!stats) {
                continue;
            }
            result[side].win += stats.win;
            result[side].lose += stats.lose;
            result[side].flee += stats.flee;
            result[side].games += stats.games;
        }
        return result;
    }, {
        current: { flee: 0, games: 0, lose: 0, win: 0 },
        old: { flee: 0, games: 0, lose: 0, win: 0 },
    });
    const totalDecidedGames = totals.current.win + totals.old.win;
    const totalHeadToHead = totalDecidedGames === 0 ? 0 : totals.current.win / totalDecidedGames;
    const totalStrictWinRate = totals.current.games === 0
        ? 0
        : totals.current.win / totals.current.games;
    console.log(
        `合计：新版 ${totals.current.win}/${totals.current.lose}/${totals.current.flee}，` +
        `旧版 ${totals.old.win}/${totals.old.lose}/${totals.old.flee}，` +
        `新版严格胜率 ${formatPercentage(totalStrictWinRate)}，胜方占比 ${formatPercentage(totalHeadToHead)}`,
    );
    console.log('');
    return comparisons;
}

function appendResult(outputPath, record) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function createRankServer(options, state) {
    return http.createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(405, { Allow: 'POST' });
            response.end('POST required');
            return;
        }

        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                const form = new URLSearchParams(body);
                if (options.accessKey && form.get('accesskey') !== options.accessKey) {
                    response.writeHead(403);
                    response.end('invalid accesskey');
                    console.warn('[统计] 拒绝了 accesskey 不匹配的 POST');
                    return;
                }

                const rankText = form.get('rank');
                if (!rankText) {
                    throw new Error('缺少 rank 字段');
                }
                const rank = JSON.parse(rankText);
                if (!Array.isArray(rank)) {
                    throw new Error('rank 不是数组');
                }

                state.latestRank = rank;
                state.latestStats = printComparison(options, rank);
                appendResult(options.outputPath, {
                    at: new Date().toISOString(),
                    stats: state.latestStats,
                    type: 'rank',
                });
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('ok');
            } catch (error) {
                console.error(`[统计] 无法解析 POST: ${error.message}`);
                response.writeHead(400);
                response.end('invalid payload');
            }
        });
    });
}

async function getRoomCount(options) {
    const url = new URL(`http://${options.host}:${options.statusPort}/api/getrooms`);
    url.searchParams.set('username', options.username);
    url.searchParams.set('pass', options.password);
    const response = await fetchWithTimeout(url, 5000);
    if (!response.ok) {
        throw new Error(`房间 API 返回 HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body.rooms)) {
        throw new Error('房间 API 响应中没有 rooms 数组');
    }
    return body.rooms.length;
}

async function rebootServer(options) {
    const url = new URL(`http://${options.host}:${options.statusPort}/api/message`);
    url.searchParams.set('username', options.username);
    url.searchParams.set('pass', options.password);
    url.searchParams.set('reboot', options.runId);

    let rebootAccepted = false;
    let response;
    let body;
    try {
        response = await fetchWithTimeout(url, 10000);
        body = await response.text();
    } catch (error) {
        console.warn(`[服务端] 重启请求连接提前断开，将通过停机与恢复状态确认: ${error.message}`);
    }
    if (response) {
        if (!response.ok || body.includes('密码错误') || body.includes('reboot fail')) {
            throw new Error(`服务端拒绝重启: HTTP ${response.status} ${body}`);
        }
        if (!body.includes('reboot ok')) {
            throw new Error(`无法确认服务端重启: ${body}`);
        }
        rebootAccepted = true;
        console.log(`[服务端] 已接受重启请求: ${body}`);
    }

    const deadline = Date.now() + 120000;
    let consecutiveSuccesses = 0;
    let sawUnavailable = false;
    await sleep(1000);
    while (Date.now() < deadline) {
        try {
            const roomCount = await getRoomCount(options);
            consecutiveSuccesses++;
            if ((rebootAccepted || sawUnavailable) && consecutiveSuccesses >= 2) {
                console.log(`[服务端] 重启后 API 已恢复，当前房间数: ${roomCount}`);
                return;
            }
        } catch {
            sawUnavailable = true;
            consecutiveSuccesses = 0;
        }
        await sleep(1000);
    }
    throw new Error('服务端在重启后 120 秒内没有恢复');
}

async function addBot(options, matchup, endpointPort, name, dialog) {
    const url = new URL(`http://127.0.0.1:${endpointPort}/`);
    url.searchParams.set('name', name);
    url.searchParams.set('host', options.host);
    url.searchParams.set('port', String(options.duelPort));
    url.searchParams.set('password', "M");
    url.searchParams.set('deck', matchup.deck);
    url.searchParams.set('chat', 'false');
    if (dialog) {
        url.searchParams.set('dialog', dialog);
    }

    const response = await fetchWithTimeout(url, 5000);
    if (!response.ok) {
        throw new Error(`${name} 启动请求返回 HTTP ${response.status}`);
    }
}

async function launchPair(options, matchup, matchupGameIndex) {
    const current = {
        dialog: matchup.currentDialog,
        name: matchup.newName,
        port: options.currentPort,
    };
    const old = {
        dialog: matchup.oldDialog,
        name: matchup.oldName,
        port: options.oldPort,
    };
    const players = matchupGameIndex % 2 === 0 ? [current, old] : [old, current];

    await addBot(options, matchup, players[0].port, players[0].name, players[0].dialog);
    if (options.pairDelayMs > 0) {
        await sleep(options.pairDelayMs);
    }
    await addBot(options, matchup, players[1].port, players[1].name, players[1].dialog);
    if (options.pairDelayMs > 0) {
        await sleep(options.pairDelayMs);
    }
}

async function scheduleGames(options, state) {
    let consecutiveErrors = 0;
    while (!state.stopping && state.launchedGames < options.totalGames) {
        try {
            const roomCount = await getRoomCount(options);
            state.lastRoomCount = roomCount;
            const availableRooms = Math.max(0, options.maxRooms - roomCount);
            const toLaunch = Math.min(
                availableRooms,
                options.pairsPerTick,
                options.totalGames - state.launchedGames,
            );

            for (let index = 0; index < toLaunch && !state.stopping; index++) {
                let matchupIndex = -1;
                for (let offset = 0; offset < options.matchups.length; offset++) {
                    const candidate = (state.nextMatchupIndex + offset) % options.matchups.length;
                    if (state.launchedByMatchup[candidate] < options.gamesPerDeck) {
                        matchupIndex = candidate;
                        break;
                    }
                }
                if (matchupIndex === -1) {
                    break;
                }

                const matchup = options.matchups[matchupIndex];
                await launchPair(options, matchup, state.launchedByMatchup[matchupIndex]);
                state.launchedByMatchup[matchupIndex]++;
                state.launchedGames++;
                state.nextMatchupIndex = (matchupIndex + 1) % options.matchups.length;
                console.log(
                    `[调度] ${matchup.deck} ` +
                    `${state.launchedByMatchup[matchupIndex]}/${options.gamesPerDeck}，` +
                    `总计 ${state.launchedGames}/${options.totalGames}，服务端房间 ${roomCount}`,
                );
            }
            consecutiveErrors = 0;
        } catch (error) {
            consecutiveErrors++;
            console.error(`[调度] ${error.message}`);
            if (consecutiveErrors >= 10) {
                throw new Error('连续 10 次无法查询房间或创建 bot，停止调度');
            }
        }
        await sleep(options.pollMs);
    }
}

function getObservedGameCounts(state) {
    return state.latestStats.map((comparison) => Math.min(
        comparison.current?.games || 0,
        comparison.old?.games || 0,
    ));
}

async function waitForResults(options, state) {
    const deadline = Date.now() + options.settleMinutes * 60 * 1000;
    while (!state.stopping && Date.now() < deadline) {
        const observedGames = getObservedGameCounts(state);
        if (observedGames.every((count) => count >= options.gamesPerDeck)) {
            console.log(`[完成] ${options.matchups.length} 个卡组均已统计 ${options.gamesPerDeck} 场对局`);
            return;
        }
        await sleep(Math.min(options.pollMs, 5000));
    }

    if (!state.stopping) {
        const observedGames = getObservedGameCounts(state);
        console.warn(
            `[完成] 等待统计超时；已创建 ${state.launchedGames} 场，` +
            `回报中双方均可确认 ${observedGames.reduce((sum, count) => sum + count, 0)} 场`,
        );
    }
}

function closeServer(server) {
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(resolve);
    });
}

async function main() {
    const raw = parseArguments(process.argv.slice(2));
    if (raw.help) {
        showHelp();
        return;
    }

    const currentBots = loadBotsFromConf(settings.currentBotConf);
    const oldBots = loadBotsFromConf(settings.oldBotConf);
    if (raw['list-decks']) {
        console.log(
            [...currentBots.keys()]
                .filter((deck) => oldBots.has(deck))
                .join('\n'),
        );
        return;
    }

    const options = buildOptions(raw);
    validateOptions(options, currentBots, oldBots);
    console.log(JSON.stringify({
        currentBotConf: options.currentBotConf,
        currentDir: options.currentDir,
        currentPort: options.currentPort,
        decks: options.matchups.map((matchup) => matchup.deck),
        gamesPerDeck: options.gamesPerDeck,
        host: `${options.host}:${options.duelPort}`,
        listenPort: options.listenPort,
        oldBotConf: options.oldBotConf,
        oldDir: options.oldDir,
        oldPort: options.oldPort,
        outputPath: options.outputPath,
        runId: options.runId,
        totalGames: options.totalGames,
    }, null, 2));

    if (options.dryRun) {
        console.log('配置校验完成；dry-run 未启动进程或发送网络请求。');
        return;
    }

    const state = {
        lastRoomCount: 0,
        latestRank: [],
        latestStats: options.matchups.map((matchup) => ({
            current: null,
            deck: matchup.deck,
            newName: matchup.newName,
            old: null,
            oldName: matchup.oldName,
        })),
        launchedByMatchup: options.matchups.map(() => 0),
        launchedGames: 0,
        nextMatchupIndex: 0,
        stopping: false,
    };
    const children = [];
    const rankServer = createRankServer(options, state);
    let shuttingDown = false;

    const shutdown = async (reason) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        state.stopping = true;
        console.log(`[停止] ${reason}`);
        await closeServer(rankServer);
        for (const child of children) {
            if (child.exitCode === null) {
                child.kill();
            }
        }
        appendResult(options.outputPath, {
            at: new Date().toISOString(),
            launchedByDeck: Object.fromEntries(options.matchups.map(
                (matchup, index) => [matchup.deck, state.launchedByMatchup[index]],
            )),
            launchedGames: state.launchedGames,
            latestStats: state.latestStats,
            reason,
            type: 'end',
        });
    };

    process.once('SIGINT', () => {
        shutdown('收到 Ctrl+C').then(() => process.exit(130));
    });
    process.once('SIGTERM', () => {
        shutdown('收到终止信号').then(() => process.exit(143));
    });

    await new Promise((resolve, reject) => {
        rankServer.once('error', reject);
        rankServer.listen(options.listenPort, '0.0.0.0', resolve);
    });
    console.log(`[统计] 正在监听 http://0.0.0.0:${options.listenPort}/`);

    appendResult(options.outputPath, {
        at: new Date().toISOString(),
        options: {
            currentDir: options.currentDir,
            currentPort: options.currentPort,
            gamesPerDeck: options.gamesPerDeck,
            host: options.host,
            matchups: options.matchups,
            oldDir: options.oldDir,
            oldPort: options.oldPort,
            runId: options.runId,
            totalGames: options.totalGames,
        },
        type: 'start',
    });

    try {
        await rebootServer(options);
        appendResult(options.outputPath, {
            at: new Date().toISOString(),
            type: 'server-rebooted',
        });

        const currentChild = startWindBot('新版', options.currentDir, options.currentPort);
        const oldChild = startWindBot('旧版', options.oldDir, options.oldPort);
        children.push(currentChild, oldChild);
        await Promise.all([
            waitForWindBot('新版', options.currentPort, currentChild),
            waitForWindBot('旧版', options.oldPort, oldChild),
        ]);

        await scheduleGames(options, state);
        if (!state.stopping) {
            console.log(
                `[调度] ${options.matchups.length} 个卡组共 ${state.launchedGames} 场对局` +
                '已全部创建，等待服务端统计回报',
            );
            await waitForResults(options, state);
        }
        await shutdown('任务结束');
    } catch (error) {
        await shutdown(`发生错误: ${error.message}`);
        throw error;
    }
}

main().catch((error) => {
    console.error(`失败: ${error.stack || error.message}`);
    process.exitCode = 1;
});
