'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDefaultArenaSettings,
    getPublicArenaSettings,
    validateAndMergeArenaSettings,
} = require('../server/arena-settings');

function makeValidSettings() {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.srvpros[0], {
        host: 'srvpro.lan',
        password: 'admin-secret',
        username: 'arena',
    });
    Object.assign(settings.windbots.current, {
        botConfText: '!Current\nName=Current Deck=Dragon Dialog=default',
        host: 'current.lan',
        mode: 'remote',
    });
    Object.assign(settings.windbots.old, {
        botConfText: '!Old\nName=Old Deck=Dragon Dialog=default',
        host: 'old.lan',
        mode: 'remote',
    });
    return settings;
}

test('settings validation preserves configured secrets when fields are blank', () => {
    const existing = makeValidSettings();
    const input = structuredClone(existing);
    input.srvpros[0].password = '';
    const result = validateAndMergeArenaSettings(input, existing);
    assert.equal(result.srvpros[0].password, 'admin-secret');
});

test('incomplete runtime settings can still be saved', () => {
    const settings = createDefaultArenaSettings();
    const result = validateAndMergeArenaSettings(settings, settings);

    assert.equal('scheduler' in result, false);
    assert.equal(result.srvpros[0].roomsPerSecond, 1);
    assert.equal(result.srvpros[0].host, '');
    assert.equal(result.srvpros[0].username, '');
    assert.equal(result.srvpros[0].password, '');
    assert.equal(result.windbots.current.runtimeDir, '');
    assert.equal(result.windbots.current.botConfPath, '');
});

test('public settings never expose SRVPro secrets', () => {
    const settings = makeValidSettings();
    settings.srvpros[0].accessKey = 'obsolete-rank-secret';
    delete settings.srvpros[0].roomsPerSecond;
    settings.scheduler = { pairDelayMs: 250, pairsPerTick: 2 };
    settings.development = { rankForwardEnabled: true };
    const result = getPublicArenaSettings(settings, '2026-08-08T00:00:00.000Z');
    assert.equal(result.settings.srvpros[0].password, '');
    assert.equal(result.settings.srvpros[0].roomsPerSecond, 1);
    assert.equal('scheduler' in result.settings, false);
    assert.equal('accessKey' in result.settings.srvpros[0], false);
    assert.equal('development' in result.settings, false);
    assert.equal(result.secretStatus.srvpros['srvpro-1'].passwordConfigured, true);
    assert.equal(result.settings.windbots.current.botConfUrl, '');
});

test('rooms created per second must be an integer in the supported range', () => {
    const settings = makeValidSettings();
    settings.srvpros[0].roomsPerSecond = 0;
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /每秒创建房间数 必须是 1 到 100 之间的整数/,
    );

    settings.srvpros[0].roomsPerSecond = 2.5;
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /每秒创建房间数 必须是 1 到 100 之间的整数/,
    );
});

test('multiple SRVPro instances keep secrets by stable ID and require unique endpoints', () => {
    const existing = makeValidSettings();
    existing.srvpros.push({
        ...existing.srvpros[0],
        host: 'srvpro-2.lan',
        id: 'srvpro-2',
        name: 'SRVPro 2',
        password: 'second-secret',
        statusPort: 8922,
    });
    const input = structuredClone(existing);
    input.srvpros.reverse();
    input.srvpros.forEach((srvpro) => { srvpro.password = ''; });

    const result = validateAndMergeArenaSettings(input, existing);
    assert.equal(result.srvpros[0].id, 'srvpro-2');
    assert.equal(result.srvpros[0].password, 'second-secret');
    assert.equal(result.srvpros[1].password, 'admin-secret');

    input.srvpros[1].host = input.srvpros[0].host;
    input.srvpros[1].statusPort = input.srvpros[0].statusPort;
    assert.throws(
        () => validateAndMergeArenaSettings(input, existing),
        /SRVPro 管理地址重复/,
    );
});

test('remote WindBot accepts an HTTP bot.conf URL instead of pasted content', () => {
    const settings = makeValidSettings();
    settings.windbots.current.botConfText = '';
    settings.windbots.current.botConfUrl = 'https://windbot.example.com/bot.conf';
    const result = validateAndMergeArenaSettings(settings, settings);
    assert.equal(result.windbots.current.botConfUrl, 'https://windbot.example.com/bot.conf');

    settings.windbots.current.botConfUrl = 'file:///srv/windbot/bot.conf';
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /只支持 HTTP 或 HTTPS/,
    );
});

test('switching WindBot modes preserves the inactive mode configuration', () => {
    const existing = makeValidSettings();
    Object.assign(existing.windbots.current, {
        botConfUrl: 'https://windbot.example.com/bot.conf',
        botConfText: 'remote bot config',
    });
    const localInput = structuredClone(existing);
    localInput.windbots.current = {
        botConfPath: 'F:\\WindBot\\bot.conf',
        mode: 'local',
        port: 2399,
        runtimeDir: 'F:\\WindBot',
    };

    const local = validateAndMergeArenaSettings(localInput, existing);
    assert.equal(local.windbots.current.host, 'current.lan');
    assert.equal(local.windbots.current.botConfUrl, 'https://windbot.example.com/bot.conf');
    assert.equal(local.windbots.current.botConfText, 'remote bot config');

    const remoteInput = structuredClone(local);
    remoteInput.windbots.current = {
        botConfText: 'updated remote bot config',
        botConfUrl: '',
        host: 'updated-current.lan',
        mode: 'remote',
        port: 2400,
    };
    const remote = validateAndMergeArenaSettings(remoteInput, local);
    assert.equal(remote.windbots.current.runtimeDir, 'F:\\WindBot');
    assert.equal(remote.windbots.current.botConfPath, 'F:\\WindBot\\bot.conf');
    assert.equal(remote.windbots.current.host, 'updated-current.lan');
    assert.equal(remote.windbots.current.botConfText, 'updated remote bot config');
});

test('old WindBot may remain incomplete while current-only modes are configured', () => {
    const settings = makeValidSettings();
    settings.windbots.old = createDefaultArenaSettings().windbots.old;
    const localResult = validateAndMergeArenaSettings(settings, settings);
    assert.equal(localResult.windbots.old.runtimeDir, '');
    assert.equal(localResult.windbots.old.botConfPath, '');

    settings.windbots.old.mode = 'remote';
    const remoteResult = validateAndMergeArenaSettings(settings, settings);
    assert.equal(remoteResult.windbots.old.host, '');
    assert.equal(remoteResult.windbots.old.botConfText, '');
});

test('configured WindBot definitions cannot point to the same endpoint', () => {
    const settings = makeValidSettings();
    settings.windbots.old.host = settings.windbots.current.host;
    settings.windbots.old.port = settings.windbots.current.port;
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /不能使用同一服务地址与端口/,
    );
});
