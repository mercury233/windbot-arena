'use strict';

const fs = require('fs');
const path = require('path');
const { getWindBotEndpoint } = require('./arena-settings');

function parseBotConfig(content) {
    const bots = new Map();
    const blocks = content.split(/(?=^!)/m);
    for (const block of blocks) {
        const match = block.match(
            /^!([^\r\n]+)[\s\S]*?^Name=\S+\s+Deck=(?:'([^']+)'|(\S+))\s+Dialog=(\S+)/m,
        );
        if (!match || /\bSELECT_DECKFILE\b/.test(block)) {
            continue;
        }

        const deck = match[2] || match[3];
        const aiLevel = block.match(/\bAI_LV(\d+)\b/);
        bots.set(deck, {
            aiLevel: aiLevel ? Number(aiLevel[1]) : null,
            deck,
            dialog: match[4],
            label: match[1],
        });
    }
    return bots;
}

function loadBotConfigText(instance, label) {
    if (instance.mode === 'remote') {
        if (instance.botConfText.trim() === '') {
            throw new Error(`${label}远程模式缺少 bot.conf 内容`);
        }
        return instance.botConfText;
    }
    if (!fs.existsSync(instance.botConfPath)) {
        throw new Error(`${label} bot.conf 不存在: ${instance.botConfPath}`);
    }
    return fs.readFileSync(instance.botConfPath, 'utf8');
}

function loadBotsFromInstance(instance, label) {
    return parseBotConfig(loadBotConfigText(instance, label));
}

function getRegressionCatalog(settings) {
    const currentBots = loadBotsFromInstance(settings.windbots.current, '新版');
    const oldBots = loadBotsFromInstance(settings.windbots.old, '旧版');
    return [...currentBots.values()]
        .filter((bot) => oldBots.has(bot.deck))
        .map((current) => ({
            current,
            deck: current.deck,
            old: oldBots.get(current.deck),
        }))
        .sort((left, right) => {
            if (left.current.aiLevel === null) {
                return right.current.aiLevel === null ? left.deck.localeCompare(right.deck) : 1;
            }
            if (right.current.aiLevel === null) {
                return -1;
            }
            return right.current.aiLevel - left.current.aiLevel
                || left.deck.localeCompare(right.deck);
        });
}

function getCurrentCatalog(settings) {
    return [...loadBotsFromInstance(settings.windbots.current, '新版').values()]
        .sort((left, right) => {
            if (left.aiLevel === null) {
                return right.aiLevel === null ? left.deck.localeCompare(right.deck) : 1;
            }
            if (right.aiLevel === null) {
                return -1;
            }
            return right.aiLevel - left.aiLevel || left.deck.localeCompare(right.deck);
        });
}

function validateWindBotRuntime(instance, label) {
    if (instance.mode === 'local') {
        const exePath = path.join(instance.runtimeDir, 'WindBot.exe');
        if (!fs.existsSync(exePath)) {
            throw new Error(`${label}程序不存在: ${exePath}`);
        }
        return;
    }
    if (instance.host.trim() === '') {
        throw new Error(`${label}远程服务地址不能为空`);
    }
}

function getDialog(instance, dialog) {
    if (instance.mode === 'remote') {
        return dialog;
    }
    return fs.existsSync(path.join(instance.runtimeDir, 'Dialogs', `${dialog}.json`))
        ? dialog
        : null;
}

function makeCompetitor(instance, bot, source, slot, rankName) {
    return {
        botLabel: bot.label,
        deck: bot.deck,
        dialog: getDialog(instance, bot.dialog),
        endpointHost: instance.mode === 'local' ? '127.0.0.1' : instance.host,
        endpointPort: instance.port,
        executionMode: instance.mode,
        rankName: rankName || `${source === 'current' ? '新' : '旧'}-${bot.label}`,
        runtimeDir: instance.runtimeDir,
        slot,
        source,
    };
}

function validateRankNames(matchups, settings) {
    const competitorsByRankName = new Map();
    for (const competitor of matchups.flatMap((matchup) => matchup.competitors)) {
        const competitors = competitorsByRankName.get(competitor.rankName) || [];
        competitors.push(competitor);
        competitorsByRankName.set(competitor.rankName, competitors);
    }
    const duplicateRankNames = [...competitorsByRankName]
        .filter(([, competitors]) => (
            competitors.length > 1 && !competitors.every((item) => item.source === 'target')
        ))
        .map(([name]) => name);
    if (duplicateRankNames.length > 0) {
        throw new Error(`本次测试生成了重复的排行榜名称: ${
            duplicateRankNames.map((name) => `“${name}”`).join('、')
        }`);
    }
    const rankNames = [...competitorsByRankName.keys()];
    const overlongRankNames = rankNames.filter((name) => [...name].length > 20);
    if (overlongRankNames.length > 0) {
        throw new Error(`本次测试生成了超过 20 个字符的排行榜名称: ${
            overlongRankNames.map((name) => `“${name}”`).join('、')
        }`);
    }
    if (rankNames.length > settings.srvpro.maxRankNames) {
        throw new Error(`本次测试会生成 ${rankNames.length} 个机器人名称，超过排行榜限制`);
    }
}

function buildRegressionMatchups(settings, requestedDecks) {
    const currentInstance = settings.windbots.current;
    const oldInstance = settings.windbots.old;
    if (getWindBotEndpoint(currentInstance) === getWindBotEndpoint(oldInstance)) {
        throw new Error('新版和旧版 WindBot 不能使用同一服务地址与端口');
    }
    validateWindBotRuntime(currentInstance, '新版');
    validateWindBotRuntime(oldInstance, '旧版');

    const catalog = getRegressionCatalog(settings);
    if (catalog.length === 0) {
        throw new Error('新旧版本之间没有可运行的共同卡组');
    }

    const catalogByDeck = new Map(catalog.map((item) => [item.deck, item]));
    const requestedDeckSet = requestedDecks?.length ? new Set(requestedDecks) : null;
    const missing = requestedDeckSet
        ? [...requestedDeckSet].filter((deck) => !catalogByDeck.has(deck))
        : [];
    if (missing.length > 0) {
        throw new Error(`这些卡组不同时存在于新旧配置中: ${missing.join(', ')}`);
    }
    const selectedDecks = catalog
        .filter((item) => (
            requestedDeckSet
                ? requestedDeckSet.has(item.deck)
                : item.current.aiLevel !== 1
        ))
        .map((item) => item.deck);
    if (selectedDecks.length === 0) {
        throw new Error('没有符合条件的共同卡组；批量选择不会包含 LV1');
    }

    const matchups = selectedDecks.map((deck) => {
        const pair = catalogByDeck.get(deck);
        return {
            aiLevel: pair.current.aiLevel,
            label: deck,
            competitors: [
                makeCompetitor(currentInstance, pair.current, 'current', 1),
                makeCompetitor(oldInstance, pair.old, 'old', 2),
            ],
        };
    });
    validateRankNames(matchups, settings);
    return matchups;
}

function buildChallengeMatchups(settings, targetDeckInput, requestedDecks) {
    const instance = settings.windbots.current;
    validateWindBotRuntime(instance, '新版');
    const requestedTargetDeck = String(targetDeckInput || '').trim();
    if (!requestedTargetDeck) {
        throw new Error('挑战卡组名称不能为空');
    }

    const catalog = getCurrentCatalog(settings);
    const catalogByDeck = new Map(catalog.map((bot) => [bot.deck, bot]));
    const targetDeck = catalog.find((bot) => (
        requestedTargetDeck === `${bot.deck} — ${bot.label}`
    ))?.deck || requestedTargetDeck;
    let opponentDecks;
    if (requestedDecks?.length) {
        opponentDecks = [...new Set(requestedDecks.map((deck) => deck.trim()))];
        const missing = opponentDecks.filter((deck) => !catalogByDeck.has(deck));
        if (missing.length > 0) {
            throw new Error(`这些对手不在新版 bot.conf 列表中: ${missing.join(', ')}`);
        }
    } else {
        opponentDecks = catalog.filter((bot) => bot.aiLevel !== 1).map((bot) => bot.deck);
        if (!opponentDecks.includes(targetDeck)) {
            opponentDecks.push(targetDeck);
        }
    }
    if (opponentDecks.length === 0) {
        throw new Error('至少需要一个对手卡组');
    }

    const targetBot = catalogByDeck.get(targetDeck) || {
        aiLevel: null,
        deck: targetDeck,
        dialog: 'default',
        label: targetDeck,
    };
    const matchups = opponentDecks.map((opponentDeck) => {
        const opponent = catalogByDeck.get(opponentDeck) || targetBot;
        return {
            aiLevel: opponent.aiLevel,
            label: opponentDeck,
            competitors: [
                makeCompetitor(
                    instance,
                    targetBot,
                    'target',
                    1,
                    targetBot.deck,
                ),
                makeCompetitor(
                    instance,
                    opponent,
                    'opponent',
                    2,
                    catalogByDeck.has(opponentDeck) ? opponent.label : `对手-${opponent.deck}`,
                ),
            ],
        };
    });
    validateRankNames(matchups, settings);
    return matchups;
}

function buildRankingEntries(settings, requestedDecks) {
    const instance = settings.windbots.current;
    validateWindBotRuntime(instance, '新版');
    const catalog = getCurrentCatalog(settings);
    const catalogByDeck = new Map(catalog.map((bot) => [bot.deck, bot]));
    const selectedDecks = requestedDecks?.length
        ? [...new Set(requestedDecks.map((deck) => deck.trim()))]
        : catalog.filter((bot) => bot.aiLevel !== 1).map((bot) => bot.deck);
    const missing = selectedDecks.filter((deck) => !catalogByDeck.has(deck));
    if (missing.length > 0) {
        throw new Error(`这些卡组不在新版 bot.conf 列表中: ${missing.join(', ')}`);
    }
    if (selectedDecks.length < 2) {
        throw new Error('胜率排行至少需要两个卡组');
    }

    const entries = selectedDecks.map((deck) => {
        const bot = catalogByDeck.get(deck);
        return {
            aiLevel: bot.aiLevel,
            label: deck,
            competitors: [
                makeCompetitor(
                    instance,
                    bot,
                    'current',
                    1,
                    bot.label,
                ),
            ],
        };
    });
    validateRankNames(entries, settings);
    return entries;
}

function inspectConfiguration(settings) {
    const baseIssues = [];
    const srvpro = settings.srvpro;
    for (const [label, value] of [
        ['SRVPro 地址', srvpro.host],
        ['SRVPro 管理账号', srvpro.username],
        ['SRVPro 管理密码', srvpro.password],
        ['排行接收密钥', srvpro.accessKey],
    ]) {
        if (typeof value !== 'string' || value.trim() === '') {
            baseIssues.push(`${label}未配置`);
        }
    }

    const inspectInstance = (label, instance) => {
        const issues = [];
        if (instance.mode === 'local') {
            for (const [targetLabel, targetPath] of [
                [`${label} bot.conf`, instance.botConfPath],
                [`${label} WindBot.exe`, path.join(instance.runtimeDir, 'WindBot.exe')],
            ]) {
                if (!targetPath || !fs.existsSync(targetPath)) {
                    issues.push(`${targetLabel} 不存在: ${targetPath || '未配置'}`);
                }
            }
        } else {
            if (!instance.host) {
                issues.push(`${label}远程 WindBot 地址未配置`);
            }
            if (!instance.botConfText?.trim()) {
                issues.push(instance.botConfUrl
                    ? `${label}尚未从 URL 获取 bot.conf，请手动刷新`
                    : `${label}远程模式缺少 bot.conf 内容或 URL`);
            }
        }
        return issues;
    };
    const currentIssues = [...baseIssues, ...inspectInstance('新版', settings.windbots.current)];
    const oldIssues = inspectInstance('旧版', settings.windbots.old);
    const regressionIssues = [...currentIssues, ...oldIssues];
    if (getWindBotEndpoint(settings.windbots.current) === getWindBotEndpoint(settings.windbots.old)) {
        regressionIssues.push('新版和旧版 WindBot 不能使用同一服务地址与端口');
    }

    let decks = [];
    if (!regressionIssues.some((issue) => issue.includes('bot.conf'))) {
        try {
            decks = getRegressionCatalog(settings).map((item) => ({
                aiLevel: item.current.aiLevel,
                currentLabel: item.current.label,
                deck: item.deck,
                oldLabel: item.old.label,
            }));
            if (decks.length === 0) {
                regressionIssues.push('两份 bot.conf 没有共同的可运行卡组');
            }
        } catch (error) {
            regressionIssues.push(error.message);
        }
    }
    let currentDecks = [];
    if (!currentIssues.some((issue) => issue.includes('bot.conf'))) {
        try {
            currentDecks = getCurrentCatalog(settings).map((item) => ({
                aiLevel: item.aiLevel,
                currentLabel: item.label,
                deck: item.deck,
            }));
            if (currentDecks.length === 0) {
                currentIssues.push('新版 bot.conf 没有可运行的卡组');
            }
        } catch (error) {
            currentIssues.push(error.message);
        }
    }
    const currentMode = { issues: currentIssues, valid: currentIssues.length === 0 };
    return {
        currentDecks,
        decks,
        issues: regressionIssues,
        modes: {
            challenge: currentMode,
            ranking: currentMode,
            regression: { issues: regressionIssues, valid: regressionIssues.length === 0 },
        },
        valid: regressionIssues.length === 0,
    };
}

module.exports = {
    buildChallengeMatchups,
    buildRankingEntries,
    buildRegressionMatchups,
    getCurrentCatalog,
    getRegressionCatalog,
    inspectConfiguration,
    loadBotConfigText,
    loadBotsFromInstance,
    parseBotConfig,
};
