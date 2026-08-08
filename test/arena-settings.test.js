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

test('public settings never expose SRVPro secrets', () => {
    const result = getPublicArenaSettings(makeValidSettings(), '2026-08-08T00:00:00.000Z');
    assert.equal(result.settings.srvpro.password, '');
    assert.equal(result.settings.srvpro.accessKey, '');
    assert.equal(result.secretStatus.passwordConfigured, true);
    assert.equal(result.secretStatus.accessKeyConfigured, true);
});

test('two WindBot definitions cannot point to the same endpoint', () => {
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
