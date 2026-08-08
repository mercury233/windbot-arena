'use strict';

const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readPort(value) {
    const port = Number(value || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('WINDBOT_ARENA_PORT 必须是有效端口');
    }
    return port;
}

function loadConfig() {
    const databaseValue = process.env.WINDBOT_ARENA_DATABASE || path.join('data', 'arena.sqlite');
    return {
        databasePath: path.isAbsolute(databaseValue)
            ? databaseValue
            : path.resolve(rootDir, databaseValue),
        listenHost: process.env.WINDBOT_ARENA_HOST || '0.0.0.0',
        listenPort: readPort(process.env.WINDBOT_ARENA_PORT),
        rootDir,
    };
}

module.exports = { loadConfig };
