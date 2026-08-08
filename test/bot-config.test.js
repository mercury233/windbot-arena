'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    buildChallengeMatchups,
    buildRankingEntries,
    buildRegressionMatchups,
    getRegressionCatalog,
    inspectConfiguration,
    parseBotConfig,
} = require('../server/bot-config');
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

test('configuration inspection reports incomplete settings without throwing', () => {
    const settings = createDefaultArenaSettings();
    settings.srvpro.rankPostPath = '';
    const result = inspectConfiguration(settings);

    assert.equal(result.valid, false);
    assert.equal(result.modes.ranking.valid, false);
    assert.ok(result.issues.includes('SRVPro 地址未配置'));
    assert.ok(result.issues.includes('排行接收路径未配置'));
    assert.ok(result.issues.includes('新版 WindBot 运行目录未配置'));
    assert.ok(result.issues.includes('新版 bot.conf 路径未配置'));
});

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

test('challenge shares the target rank and keeps opponent bot names', () => {
    const settings = createDefaultArenaSettings();
    settings.srvpro.maxRankNames = 1000;
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfText: botConfig,
        host: 'windbot-current.lan',
        mode: 'remote',
    };
    const matchups = buildChallengeMatchups(settings, 'ManualExecutor', []);

    assert.deepEqual(matchups.map((item) => item.label), [
        'Dragon',
        'Deck With Spaces',
        'Unleveled',
        'ManualExecutor',
    ]);
    assert.equal(matchups[0].competitors[0].deck, 'ManualExecutor');
    assert.equal(matchups[0].competitors[0].dialog, 'default');
    assert.equal(matchups.at(-1).competitors[1].deck, 'ManualExecutor');
    assert.equal(matchups[0].competitors[0].endpointHost, 'windbot-current.lan');
    assert.equal(matchups[0].competitors[0].rankName, 'ManualExecutor');
    assert.equal(matchups[0].competitors[1].rankName, 'Dragon Bot');
    assert.ok(matchups.every((item) => item.competitors[0].rankName === 'ManualExecutor'));
    assert.equal(matchups.at(-1).competitors[1].rankName, '对手-ManualExecutor');
    assert.equal(new Set(matchups.flatMap((item) => item.competitors.map((bot) => bot.rankName))).size, 5);

    const beginnerMatchups = buildChallengeMatchups(settings, 'Beginner', []);
    assert.ok(beginnerMatchups.some((item) => item.label === 'Beginner'));

    const aliasSettings = structuredClone(settings);
    aliasSettings.windbots.current.botConfText += `
!艾克莉西娅-阿不思
Name=艾克莉西娅 Deck=Albaz Dialog=ecclesia.zh-CN
AI_LV4
`;
    const [albazMatchup] = buildChallengeMatchups(
        aliasSettings,
        'Albaz — 艾克莉西娅-阿不思',
        ['Dragon'],
    );
    assert.equal(albazMatchup.competitors[0].deck, 'Albaz');
    assert.equal(albazMatchup.competitors[0].rankName, 'Albaz');

    assert.throws(
        () => buildChallengeMatchups(
            settings,
            'ManualExecutorWithAnExtremelyLongName',
            ['Dragon'],
        ),
        /超过 20 个字符的排行榜名称: “ManualExecutorWithAnExtremelyLongName”/,
    );
});

test('ranking creates one current WindBot entry per selected deck', () => {
    const settings = createDefaultArenaSettings();
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfText: botConfig,
        host: 'windbot-current.lan',
        mode: 'remote',
    };
    const entries = buildRankingEntries(settings, ['Dragon', 'Beginner']);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].competitors.length, 1);
    assert.equal(entries[0].competitors[0].source, 'current');
    assert.equal(entries[0].competitors[0].rankName, 'Dragon Bot');
    assert.equal(entries[1].competitors[0].rankName, 'Beginner Bot');
    assert.notEqual(entries[0].competitors[0].rankName, entries[1].competitors[0].rankName);
    assert.throws(() => buildRankingEntries(settings, ['Dragon']), /至少需要两个卡组/);
});

test('current-only modes remain available when the old WindBot is not configured', () => {
    const settings = createDefaultArenaSettings();
    settings.srvpro = {
        ...settings.srvpro,
        accessKey: 'key',
        host: 'srvpro.lan',
        password: 'password',
        username: 'admin',
    };
    settings.windbots.current = {
        ...settings.windbots.current,
        botConfText: botConfig,
        host: 'windbot-current.lan',
        mode: 'remote',
    };
    const inspection = inspectConfiguration(settings);
    assert.equal(inspection.modes.challenge.valid, true);
    assert.equal(inspection.modes.ranking.valid, true);
    assert.equal(inspection.modes.regression.valid, false);
    assert.equal(inspection.currentDecks.length, 4);
});
