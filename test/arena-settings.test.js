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
    Object.assign(settings.srvpro, {
        accessKey: 'rank-secret',
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
    input.srvpro.password = '';
    input.srvpro.accessKey = '';
    input.srvpro.rankPostPath = '/srvpro/score';
    const result = validateAndMergeArenaSettings(input, existing);
    assert.equal(result.srvpro.password, 'admin-secret');
    assert.equal(result.srvpro.accessKey, 'rank-secret');
    assert.equal(result.srvpro.rankPostPath, '/srvpro/score');
});

test('incomplete runtime settings can still be saved', () => {
    const settings = createDefaultArenaSettings();
    settings.srvpro.rankPostPath = '';
    const result = validateAndMergeArenaSettings(settings, settings);

    assert.equal(result.srvpro.host, '');
    assert.equal(result.srvpro.username, '');
    assert.equal(result.srvpro.password, '');
    assert.equal(result.srvpro.accessKey, '');
    assert.equal(result.srvpro.rankPostPath, '');
    assert.equal(result.windbots.current.runtimeDir, '');
    assert.equal(result.windbots.current.botConfPath, '');
});

test('public settings never expose SRVPro secrets', () => {
    const result = getPublicArenaSettings(makeValidSettings(), '2026-08-08T00:00:00.000Z');
    assert.equal(result.settings.srvpro.password, '');
    assert.equal(result.settings.srvpro.accessKey, '');
    assert.equal(result.secretStatus.passwordConfigured, true);
    assert.equal(result.secretStatus.accessKeyConfigured, true);
    assert.equal(result.settings.windbots.current.botConfUrl, '');
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

test('rank endpoint cannot conflict with Arena APIs', () => {
    const settings = makeValidSettings();
    settings.srvpro.rankPostPath = '/api/runs/active';
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /不能与 Arena API 路径冲突/,
    );
});

test('development rank forwarding requires an HTTP endpoint when enabled', () => {
    const settings = makeValidSettings();
    settings.development.rankForwardEnabled = true;
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /必须填写开发机排行接收 URL/,
    );

    settings.development.rankForwardUrl = 'file:///tmp/rank';
    assert.throws(
        () => validateAndMergeArenaSettings(settings, settings),
        /只支持 HTTP 或 HTTPS/,
    );

    settings.development.rankForwardUrl = 'http://dev-arena.lan:3000/score/report';
    const result = validateAndMergeArenaSettings(settings, settings);
    assert.deepEqual(result.development, {
        rankForwardEnabled: true,
        rankForwardUrl: 'http://dev-arena.lan:3000/score/report',
    });
});
