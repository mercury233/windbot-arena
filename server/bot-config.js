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

function loadBotsFromInstance(instance, label) {
    if (instance.mode === 'remote') {
        if (instance.botConfText.trim() === '') {
            throw new Error(`${label}远程模式缺少 bot.conf 内容`);
        }
        return parseBotConfig(instance.botConfText);
    }
    if (!fs.existsSync(instance.botConfPath)) {
        throw new Error(`${label} bot.conf 不存在: ${instance.botConfPath}`);
    }
    return parseBotConfig(fs.readFileSync(instance.botConfPath, 'utf8'));
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

function makeCompetitor(instance, bot, source, slot) {
    return {
        botLabel: bot.label,
        deck: bot.deck,
        dialog: getDialog(instance, bot.dialog),
        endpointHost: instance.mode === 'local' ? '127.0.0.1' : instance.host,
        endpointPort: instance.port,
        executionMode: instance.mode,
        rankName: `${source === 'current' ? '新' : '旧'}-${bot.label}`,
        runtimeDir: instance.runtimeDir,
        slot,
        source,
    };
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
        throw new Error('没有符合条件的共同卡组；批量选择不会包含 AI_LV1');
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
    const rankNames = matchups.flatMap((matchup) => matchup.competitors.map((item) => item.rankName));
    if (new Set(rankNames).size !== rankNames.length) {
        throw new Error('两份 bot.conf 生成了重复的排行榜名称');
    }
    if (rankNames.some((name) => [...name].length > 20)) {
        throw new Error('bot.conf 中存在加版本前缀后超过 20 个字符的机器人名称');
    }
    if (rankNames.length > settings.srvpro.maxRankNames) {
        throw new Error(`本次测试会生成 ${rankNames.length} 个机器人名称，超过排行榜限制`);
    }
    return matchups;
}

function inspectConfiguration(settings) {
    const issues = [];
    const srvpro = settings.srvpro;
    for (const [label, value] of [
        ['SRVPro 地址', srvpro.host],
        ['SRVPro 管理账号', srvpro.username],
        ['SRVPro 管理密码', srvpro.password],
        ['排行接收密钥', srvpro.accessKey],
    ]) {
        if (typeof value !== 'string' || value.trim() === '') {
            issues.push(`${label}未配置`);
        }
    }

    for (const [label, instance] of [
        ['新版', settings.windbots.current],
        ['旧版', settings.windbots.old],
    ]) {
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
                issues.push(`${label}远程模式缺少 bot.conf 内容`);
            }
        }
    }
    if (getWindBotEndpoint(settings.windbots.current) === getWindBotEndpoint(settings.windbots.old)) {
        issues.push('新版和旧版 WindBot 不能使用同一服务地址与端口');
    }

    let decks = [];
    if (!issues.some((issue) => issue.includes('bot.conf'))) {
        try {
            decks = getRegressionCatalog(settings).map((item) => ({
                aiLevel: item.current.aiLevel,
                currentLabel: item.current.label,
                deck: item.deck,
                oldLabel: item.old.label,
            }));
            if (decks.length === 0) {
                issues.push('两份 bot.conf 没有共同的可运行卡组');
            }
        } catch (error) {
            issues.push(error.message);
        }
    }
    return { decks, issues, valid: issues.length === 0 };
}

module.exports = {
    buildRegressionMatchups,
    getRegressionCatalog,
    inspectConfiguration,
    loadBotsFromInstance,
    parseBotConfig,
};
