'use strict';

const { createServer } = require('http');
const { createApp } = require('./app');
const { ArenaService } = require('./arena-service');
const { loadConfig } = require('./config');
const { ArenaDatabase } = require('./database');

async function main() {
    const config = loadConfig();
    if (process.env.npm_lifecycle_event === 'dev:server') {
        config.clientDevUrl = 'http://127.0.0.1:5173';
    }
    const database = new ArenaDatabase(config.databasePath);
    const arenaService = new ArenaService(config, database);
    const interrupted = arenaService.initialize();
    if (interrupted > 0) {
        console.warn(`已将 ${interrupted} 个未正常结束的测试标记为中断`);
    }

    const shutdownController = new AbortController();
    const server = createServer(createApp(
        config,
        database,
        arenaService,
        shutdownController.signal,
    ));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.listenPort, config.listenHost, resolve);
    });
    console.log(`WindBot Arena 已启动: ${
        config.clientDevUrl || `http://${config.listenHost}:${config.listenPort}`
    }`);
    if (config.clientDevUrl) {
        console.log(`Arena API 已启动: http://${config.listenHost}:${config.listenPort}`);
    }

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`收到 ${signal}，正在关闭服务`);
        const serverClosed = new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        shutdownController.abort();
        await arenaService.shutdown();
        await serverClosed;
        database.close();
    };
    process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
}

main().catch((error) => {
    console.error(`启动失败: ${error.stack || error.message}`);
    process.exitCode = 1;
});
