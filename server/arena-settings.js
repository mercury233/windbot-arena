'use strict';

function createDefaultArenaSettings() {
    return {
        development: {
            rankForwardEnabled: false,
            rankForwardUrl: '',
        },
        scheduler: {
            pairDelayMs: 250,
            pairsPerTick: 2,
            pollMs: 1000,
            settleMinutes: 30,
        },
        srvpro: {
            accessKey: '',
            duelPort: 7911,
            host: '',
            maxRankNames: 1000,
            maxRooms: 100,
            password: '',
            rankPostPath: '/',
            statusPort: 7922,
            username: '',
        },
        windbots: {
            current: {
                botConfPath: '',
                botConfText: '',
                botConfUrl: '',
                host: '',
                mode: 'local',
                port: 2399,
                runtimeDir: '',
            },
            old: {
                botConfPath: '',
                botConfText: '',
                botConfUrl: '',
                host: '',
                mode: 'local',
                port: 2398,
                runtimeDir: '',
            },
        },
    };
}

function readInteger(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
    }
    return number;
}

function readWindBot(input, existing, label) {
    const source = input || {};
    const mode = source.mode;
    if (!['local', 'remote'].includes(mode)) {
        throw new Error(`${label}运行模式无效`);
    }
    const result = {
        botConfPath: String(source.botConfPath || '').trim(),
        botConfText: String(source.botConfText || ''),
        botConfUrl: String(source.botConfUrl || '').trim(),
        host: String(source.host || '').trim(),
        mode,
        port: readInteger(source.port, `${label}服务端口`, 1, 65535),
        runtimeDir: String(source.runtimeDir || '').trim(),
    };
    if (mode === 'remote') {
        if (result.botConfUrl) {
            let url;
            try {
                url = new URL(result.botConfUrl);
            } catch {
                throw new Error(`${label}bot.conf URL 无效`);
            }
            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error(`${label}bot.conf URL 只支持 HTTP 或 HTTPS`);
            }
            if (result.botConfUrl.length > 2000) {
                throw new Error(`${label}bot.conf URL 不能超过 2000 个字符`);
            }
        }
    }
    return { ...existing, ...result };
}

function validateAndMergeArenaSettings(input, existing) {
    if (!input || typeof input !== 'object') {
        throw new Error('配置内容无效');
    }
    const previous = existing || createDefaultArenaSettings();
    const srvpro = input.srvpro || {};
    const password = typeof srvpro.password === 'string' && srvpro.password !== ''
        ? srvpro.password
        : previous.srvpro.password;
    const accessKey = typeof srvpro.accessKey === 'string' && srvpro.accessKey !== ''
        ? srvpro.accessKey
        : previous.srvpro.accessKey;
    const rankPostPath = String(srvpro.rankPostPath || '').trim();
    if (
        rankPostPath
        && (
            !rankPostPath.startsWith('/')
            || rankPostPath.length > 200
            || /[?#\s]/.test(rankPostPath)
        )
    ) {
        throw new Error('排行接收路径必须是以 / 开头且不含查询参数、片段或空白的 URL 路径');
    }
    const reservedApiPaths = ['/api/decks', '/api/events', '/api/runs', '/api/settings', '/api/system'];
    if (reservedApiPaths.some((path) => rankPostPath === path || rankPostPath.startsWith(`${path}/`))) {
        throw new Error('排行接收路径不能与 Arena API 路径冲突');
    }

    const rankForwardEnabled = input.development?.rankForwardEnabled === true;
    const rankForwardUrl = String(input.development?.rankForwardUrl || '').trim();
    if (rankForwardEnabled && !rankForwardUrl) {
        throw new Error('启用排行转发时必须填写开发机排行接收 URL');
    }
    if (rankForwardUrl) {
        let url;
        try {
            url = new URL(rankForwardUrl);
        } catch {
            throw new Error('开发机排行接收 URL 无效');
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('开发机排行接收 URL 只支持 HTTP 或 HTTPS');
        }
        if (rankForwardUrl.length > 2000) {
            throw new Error('开发机排行接收 URL 不能超过 2000 个字符');
        }
    }

    const settings = {
        development: {
            rankForwardEnabled,
            rankForwardUrl,
        },
        scheduler: {
            pairDelayMs: readInteger(input.scheduler?.pairDelayMs, '双方加入间隔', 0, 60000),
            pairsPerTick: readInteger(input.scheduler?.pairsPerTick, '每轮创建对局数', 1, 100),
            pollMs: readInteger(input.scheduler?.pollMs, '调度轮询间隔', 100, 60000),
            settleMinutes: readInteger(input.scheduler?.settleMinutes, '统计等待时间', 1, 1440),
        },
        srvpro: {
            accessKey,
            duelPort: readInteger(srvpro.duelPort, 'SRVPro 对战端口', 1, 65535),
            host: String(srvpro.host || '').trim(),
            maxRankNames: readInteger(srvpro.maxRankNames, '排行榜名称上限', 2, 100000),
            maxRooms: readInteger(srvpro.maxRooms, '房间上限', 1, 100000),
            password,
            rankPostPath,
            statusPort: readInteger(srvpro.statusPort, 'SRVPro 管理端口', 1, 65535),
            username: String(srvpro.username || '').trim(),
        },
        windbots: {
            current: readWindBot(input.windbots?.current, previous.windbots.current, '新版 WindBot '),
            old: readWindBot(input.windbots?.old, previous.windbots.old, '旧版 WindBot '),
        },
    };
    const old = settings.windbots.old;
    const oldConfigured = old.mode === 'local'
        ? old.runtimeDir !== '' && old.botConfPath !== ''
        : old.host !== '' && (old.botConfText.trim() !== '' || old.botConfUrl !== '');
    if (
        oldConfigured
        && getWindBotEndpoint(settings.windbots.current) === getWindBotEndpoint(old)
    ) {
        throw new Error('新版和旧版 WindBot 不能使用同一服务地址与端口');
    }
    return settings;
}

function getWindBotEndpoint(windbot) {
    const host = windbot.mode === 'local' ? '127.0.0.1' : windbot.host;
    return `${host}:${windbot.port}`;
}

function getPublicArenaSettings(settings, updatedAt) {
    const result = structuredClone(settings);
    result.srvpro.password = '';
    result.srvpro.accessKey = '';
    for (const instance of Object.values(result.windbots)) {
        instance.botConfUrl ||= '';
    }
    return {
        secretStatus: {
            accessKeyConfigured: settings.srvpro.accessKey !== '',
            passwordConfigured: settings.srvpro.password !== '',
        },
        settings: result,
        updatedAt,
    };
}

module.exports = {
    createDefaultArenaSettings,
    getPublicArenaSettings,
    getWindBotEndpoint,
    validateAndMergeArenaSettings,
};
