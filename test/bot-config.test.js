'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRegressionMatchups, getRegressionCatalog, parseBotConfig } = require('../server/bot-config');
const { createDefaultArenaSettings } = require('../server/arena-settings');

const botConfig = `
!Dragon Bot
Name=Dragon Deck=Dragon Dialog=dragon
AI_LV4
!Quoted Bot
Name=Quoted Deck='Deck With Spaces' Dialog=quoted
AI_LV2
!Beginner Bot
AI_LV1
Name=Beginner Deck=Beginner Dialog=beginner
!Unleveled Bot
Name=Unleveled Deck=Unleveled Dialog=default
!Manual Bot
Name=Manual Deck=SELECT_DECKFILE Dialog=manual
`;

test('parseBotConfig parses supported entries and filters manual bots', () => {
    const bots = parseBotConfig(botConfig);
    assert.deepEqual([...bots.keys()], ['Dragon', 'Deck With Spaces', 'Beginner', 'Unleveled']);
    assert.deepEqual(bots.get('Dragon'), {
        aiLevel: 4,
        deck: 'Dragon',
        dialog: 'dragon',
        label: 'Dragon Bot',
    });
    assert.equal(bots.get('Beginner').aiLevel, 1);
    assert.equal(bots.get('Unleveled').aiLevel, null);
});

test('buildRegressionMatchups creates generalized competitors', (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbot-arena-bots-'));
    context.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));
    const currentDir = path.join(tempDir, 'current');
    const oldDir = path.join(tempDir, 'old');
    for (const runtimeDir of [currentDir, oldDir]) {
        fs.mkdirSync(path.join(runtimeDir, 'Dialogs'), { recursive: true });
        fs.writeFileSync(path.join(runtimeDir, 'WindBot.exe'), 'fixture');
    }
    fs.writeFileSync(path.join(currentDir, 'Dialogs', 'dragon.json'), '{}');
    const currentBotConf = path.join(tempDir, 'current.conf');
    const oldBotConf = path.join(tempDir, 'old.conf');
    fs.writeFileSync(currentBotConf, botConfig);
    fs.writeFileSync(oldBotConf, botConfig.replace('Dragon Bot', 'Legacy Dragon'));

    const settings = createDefaultArenaSettings();
    settings.srvpro.maxRankNames = 1000;
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfPath: currentBotConf,
        runtimeDir: currentDir,
    };
    settings.windbots.old = {
        ...settings.windbots.old,
        botConfPath: oldBotConf,
        runtimeDir: oldDir,
    };
    const matchups = buildRegressionMatchups(settings, ['Dragon']);

    assert.equal(matchups.length, 1);
    assert.equal(matchups[0].competitors[0].rankName, '新-Dragon Bot');
    assert.equal(matchups[0].competitors[1].rankName, '旧-Legacy Dragon');
    assert.equal(matchups[0].aiLevel, 4);
    assert.equal(matchups[0].competitors[0].dialog, 'dragon');
    assert.equal(matchups[0].competitors[1].dialog, null);
});

test('remote WindBot uses pasted bot.conf and remote endpoint', () => {
    const settings = createDefaultArenaSettings();
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfText: botConfig,
        host: 'windbot-current.lan',
        mode: 'remote',
    };
    settings.windbots.old = {
        ...settings.windbots.old,
        botConfText: botConfig.replace('Dragon Bot', 'Legacy Dragon'),
        host: 'windbot-old.lan',
        mode: 'remote',
    };
    const [matchup] = buildRegressionMatchups(settings, ['Dragon']);
    assert.equal(matchup.competitors[0].endpointHost, 'windbot-current.lan');
    assert.equal(matchup.competitors[0].executionMode, 'remote');
    assert.equal(matchup.competitors[0].dialog, 'dragon');
});

test('catalog sorts AI levels descending while bulk selection excludes AI_LV1', () => {
    const settings = createDefaultArenaSettings();
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfText: botConfig,
        host: 'windbot-current.lan',
        mode: 'remote',
    };
    settings.windbots.old = {
        ...settings.windbots.old,
        botConfText: botConfig,
        host: 'windbot-old.lan',
        mode: 'remote',
    };
    const catalog = getRegressionCatalog(settings);
    assert.deepEqual(catalog.map((item) => item.deck), [
        'Dragon',
        'Deck With Spaces',
        'Beginner',
        'Unleveled',
    ]);
    const matchups = buildRegressionMatchups(settings, []);
    assert.deepEqual(matchups.map((item) => item.label), [
        'Dragon',
        'Deck With Spaces',
        'Unleveled',
    ]);
    assert.equal(buildRegressionMatchups(settings, ['Beginner'])[0].label, 'Beginner');
});
