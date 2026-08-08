'use strict';

function createDefaultArenaSettings() {
    return {
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

function readText(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${label} 不能为空`);
    }
    return value.trim();
}

function readInteger(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
    }
    return number;
}

function readWindBot(input, existing, label, required = true) {
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
    if (mode === 'local') {
        if (required) {
            readText(result.runtimeDir, `${label}运行目录`);
            readText(result.botConfPath, `${label} bot.conf 路径`);
        }
    } else {
        if (required) {
            readText(result.host, `${label}服务地址`);
        }
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
        } else if (required) {
            readText(result.botConfText, `${label} bot.conf 内容或 URL`);
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
    readText(password, 'SRVPro 管理密码');
    readText(accessKey, '排行接收密钥');
    const rankPostPath = readText(srvpro.rankPostPath, '排行接收路径');
    if (
        !rankPostPath.startsWith('/')
        || rankPostPath.length > 200
        || /[?#\s]/.test(rankPostPath)
    ) {
        throw new Error('排行接收路径必须是以 / 开头且不含查询参数、片段或空白的 URL 路径');
    }
    const reservedApiPaths = ['/api/decks', '/api/events', '/api/runs', '/api/settings', '/api/system'];
    if (reservedApiPaths.some((path) => rankPostPath === path || rankPostPath.startsWith(`${path}/`))) {
        throw new Error('排行接收路径不能与 Arena API 路径冲突');
    }

    const settings = {
        scheduler: {
            pairDelayMs: readInteger(input.scheduler?.pairDelayMs, '双方加入间隔', 0, 60000),
            pairsPerTick: readInteger(input.scheduler?.pairsPerTick, '每轮创建对局数', 1, 100),
            pollMs: readInteger(input.scheduler?.pollMs, '调度轮询间隔', 100, 60000),
            settleMinutes: readInteger(input.scheduler?.settleMinutes, '统计等待时间', 1, 1440),
        },
        srvpro: {
            accessKey,
            duelPort: readInteger(srvpro.duelPort, 'SRVPro 对战端口', 1, 65535),
            host: readText(srvpro.host, 'SRVPro 地址'),
            maxRankNames: readInteger(srvpro.maxRankNames, '排行榜名称上限', 2, 100000),
            maxRooms: readInteger(srvpro.maxRooms, '房间上限', 1, 100000),
            password,
            rankPostPath,
            statusPort: readInteger(srvpro.statusPort, 'SRVPro 管理端口', 1, 65535),
            username: readText(srvpro.username, 'SRVPro 管理账号'),
        },
        windbots: {
            current: readWindBot(input.windbots?.current, previous.windbots.current, '新版 WindBot '),
            old: readWindBot(input.windbots?.old, previous.windbots.old, '旧版 WindBot ', false),
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
