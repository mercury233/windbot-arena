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
            duelPort: 7911,
            host: '',
            maxRooms: 100,
            password: '',
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
        ...existing,
        mode,
        port: readInteger(source.port, `${label}服务端口`, 1, 65535),
    };
    if (mode === 'local') {
        result.botConfPath = String(source.botConfPath || '').trim();
        result.runtimeDir = String(source.runtimeDir || '').trim();
    } else {
        result.botConfText = String(source.botConfText || '');
        result.botConfUrl = String(source.botConfUrl || '').trim();
        result.host = String(source.host || '').trim();
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
    return result;
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

    const settings = {
        scheduler: {
            pairDelayMs: readInteger(input.scheduler?.pairDelayMs, '双方加入间隔', 0, 60000),
            pairsPerTick: readInteger(input.scheduler?.pairsPerTick, '每轮创建对局数', 1, 100),
            pollMs: readInteger(input.scheduler?.pollMs, '调度轮询间隔', 100, 60000),
            settleMinutes: readInteger(input.scheduler?.settleMinutes, '统计等待时间', 1, 1440),
        },
        srvpro: {
            duelPort: readInteger(srvpro.duelPort, 'SRVPro 对战端口', 1, 65535),
            host: String(srvpro.host || '').trim(),
            maxRooms: readInteger(srvpro.maxRooms, '房间上限', 1, 100000),
            password,
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
    delete result.srvpro.accessKey;
    delete result.srvpro.maxRankNames;
    delete result.srvpro.rankPostPath;
    delete result.development;
    for (const instance of Object.values(result.windbots)) {
        instance.botConfUrl ||= '';
    }
    return {
        secretStatus: {
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
