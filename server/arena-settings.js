'use strict';

const { DEFAULT_WEBHOOK_TEMPLATE, renderWebhookTemplate, renderWebhookUrl } = require('./notifications');

function createDefaultArenaSettings() {
    return {
        notifications: { mode: 'off', webhookMethod: 'POST', webhookUrl: '', webhookTemplate: DEFAULT_WEBHOOK_TEMPLATE, webhookHeaders: '' },
        srvpros: [{
            duelPort: 7911,
            host: '',
            id: 'srvpro-1',
            maxRooms: 100,
            name: 'SRVPro 1',
            password: '',
            roomsPerSecond: 1,
            statusPort: 7922,
            username: '',
        }],
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
    if (!Array.isArray(input.srvpros) || input.srvpros.length === 0) {
        throw new Error('至少需要配置一个 SRVPro 实例');
    }
    if (input.srvpros.length > 100) {
        throw new Error('SRVPro 实例不能超过 100 个');
    }
    const previousSrvpros = new Map(previous.srvpros.map((srvpro) => [srvpro.id, srvpro]));
    const ids = new Set();
    const managementEndpoints = new Set();
    const srvpros = input.srvpros.map((source, index) => {
        const id = String(source?.id || '').trim();
        const name = String(source?.name || '').trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            throw new Error(`第 ${index + 1} 个 SRVPro 实例 ID 无效`);
        }
        if (ids.has(id)) {
            throw new Error(`SRVPro 实例 ID 重复: ${id}`);
        }
        ids.add(id);
        if (!name) {
            throw new Error(`第 ${index + 1} 个 SRVPro 实例名称不能为空`);
        }
        if (name.length > 100) {
            throw new Error(`SRVPro 实例名称不能超过 100 个字符: ${name}`);
        }
        const host = String(source.host || '').trim();
        const statusPort = readInteger(source.statusPort, `${name} 管理端口`, 1, 65535);
        const managementEndpoint = `${host.toLocaleLowerCase()}:${statusPort}`;
        if (host && managementEndpoints.has(managementEndpoint)) {
            throw new Error(`SRVPro 管理地址重复: ${host}:${statusPort}`);
        }
        managementEndpoints.add(managementEndpoint);
        const existingSrvpro = previousSrvpros.get(id);
        const password = typeof source.password === 'string' && source.password !== ''
            ? source.password
            : existingSrvpro?.password || '';
        return {
            duelPort: readInteger(source.duelPort, `${name} 对战端口`, 1, 65535),
            host,
            id,
            maxRooms: readInteger(source.maxRooms, `${name} 房间上限`, 1, 100000),
            name,
            password,
            roomsPerSecond: readInteger(source.roomsPerSecond, `${name} 每秒创建房间数`, 1, 100),
            statusPort,
            username: String(source.username || '').trim(),
        };
    });

    const notifications = {
        ...(previous.notifications || createDefaultArenaSettings().notifications),
        ...input.notifications,
    };
    if (!['off', 'frontend', 'webhook'].includes(notifications.mode)) {
        throw new Error('通知模式无效');
    }
    notifications.webhookMethod ??= 'POST';
    if (!['GET', 'POST'].includes(notifications.webhookMethod)) throw new Error('Webhook 请求方式必须是 GET 或 POST');
    notifications.webhookUrl = String(notifications.webhookUrl ?? '').trim();
    notifications.webhookTemplate = String(notifications.webhookTemplate ?? '');
    notifications.webhookHeaders = String(notifications.webhookHeaders ?? '').trim();
    if (notifications.webhookUrl) {
        let url;
        try {
            url = new URL(renderWebhookUrl(notifications.webhookUrl, {}));
        } catch { throw new Error('Webhook URL 或模板变量无效'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || notifications.webhookUrl.length > 2000) {
            throw new Error('Webhook 必须是无内嵌账号密码的 HTTP(S) URL，且不超过 2000 个字符');
        }
    }
    if (notifications.mode === 'webhook' && !notifications.webhookUrl) {
        throw new Error('请填写 Webhook URL');
    }
    if (notifications.webhookTemplate.length > 20000 || notifications.webhookHeaders.length > 10000) {
        throw new Error('Webhook JSON 模板或请求头过长');
    }
    if (notifications.mode === 'webhook' && notifications.webhookMethod === 'POST' && !notifications.webhookTemplate.trim()) {
        throw new Error('POST 请求体模板不能为空');
    }
    if (notifications.webhookTemplate.trim()) {
        try {
            const body = renderWebhookTemplate(notifications.webhookTemplate, {});
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        } catch {
            throw new Error('Webhook 模板必须是 JSON 对象，且只使用支持的变量');
        }
    }
    try {
        const headers = JSON.parse(notifications.webhookHeaders || '{}');
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value !== 'string' || /^(host|content-length|content-type|connection|transfer-encoding)$/i.test(key)) throw new Error();
            new Headers({ [key]: value });
        }
    } catch {
        throw new Error('Webhook 请求头必须是字符串值的 JSON 对象，不能覆盖 Host、Content-Type 或传输控制头');
    }
    const settings = {
        notifications: {
            mode: notifications.mode,
            webhookMethod: notifications.webhookMethod,
            webhookUrl: notifications.webhookUrl,
            webhookTemplate: notifications.webhookTemplate,
            webhookHeaders: notifications.webhookHeaders,
        },
        srvpros,
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
    const defaultRoomsPerSecond = createDefaultArenaSettings().srvpros[0].roomsPerSecond;
    const secretStatus = { srvpros: {} };
    result.notifications = { ...createDefaultArenaSettings().notifications, ...result.notifications };
    for (const srvpro of result.srvpros) {
        const source = settings.srvpros.find((item) => item.id === srvpro.id);
        secretStatus.srvpros[srvpro.id] = {
            passwordConfigured: typeof source?.password === 'string' && source.password !== '',
        };
        srvpro.roomsPerSecond ??= defaultRoomsPerSecond;
        srvpro.password = '';
        delete srvpro.accessKey;
        delete srvpro.maxRankNames;
        delete srvpro.rankPostPath;
    }
    delete result.scheduler;
    delete result.development;
    for (const instance of Object.values(result.windbots)) {
        instance.botConfUrl ||= '';
    }
    return {
        secretStatus,
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
