'use strict';

const path = require('path');

const projectDir = path.resolve(__dirname, '..');

module.exports = {
    host: 'your.test.server.com',
    duelPort: 7911,
    statusPort: 7922,
    username: 'replace-with-server-username',
    password: 'replace-with-server-password',
    maxRooms: 100,
    maxRankNames: 1000,

    listenPort: 3000,
    accessKey: 'replace-with-rank-access-key',

    currentBotConf: path.join(projectDir, 'BotWrapper', 'bot.conf'),
    currentDir: path.join(projectDir, 'bin', 'Release'),
    currentPort: 2399,

    oldBotConf: 'windbot-old/bot.conf',
    oldDir: 'windbot-old/WindBot',
    oldPort: 2398,

    pairDelayMs: 250,
    pairsPerTick: 2,
    pollMs: 1000,
    settleMinutes: 30,
};
