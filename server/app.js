'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const STATE_HEARTBEAT_MS = 5000;

function createApp(config, database, arenaService, shutdownSignal) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', (request, response, next) => {
        response.set('Cache-Control', 'no-store');
        next();
    });

    app.get('/api/system', (request, response) => {
        response.json(arenaService.inspectSystem());
    });

    app.get('/api/srvpro/rooms', async (request, response, next) => {
        try {
            response.json(await arenaService.listRooms(request.query.srvproId));
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/srvpro/halfwaywatch', async (request, response, next) => {
        try {
            response.json(await arenaService.updateHalfwayWatch(
                request.body.srvproId,
                request.body.enabled,
            ));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/windbots/:name/output', (request, response, next) => {
        try {
            response.json(arenaService.getWindBotOutput(request.params.name));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/settings', (request, response) => {
        response.json(arenaService.getSettings());
    });

    app.put('/api/settings', async (request, response, next) => {
        try {
            response.json(await arenaService.updateSettings(request.body));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/decks', (request, response, next) => {
        try {
            response.json(arenaService.listDecks());
        } catch (error) {
            error.statusCode = 503;
            next(error);
        }
    });

    app.post('/api/decks/refresh', async (request, response, next) => {
        try {
            response.json(await arenaService.refreshBotConfigs());
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/runs', (request, response) => {
        const requestedLimit = Number(request.query.limit) || 30;
        const limit = Math.min(100, Math.max(1, Math.trunc(requestedLimit)));
        const requestedOffset = Number(request.query.offset) || 0;
        const offset = Math.max(0, Math.trunc(requestedOffset));
        response.json({
            runs: database.listRuns(limit, offset),
            total: database.getRunCount(),
        });
    });

    app.get('/api/runs/active', (request, response) => {
        response.json({
            runs: database.findActiveRuns().map((run) => database.getRun(run.id)),
        });
    });

    app.get('/api/runs/:id', (request, response) => {
        const run = database.getRun(request.params.id);
        if (!run) {
            response.status(404).json({ error: '测试记录不存在' });
            return;
        }
        response.json({ run });
    });

    app.post('/api/runs', (request, response, next) => {
        try {
            const run = arenaService.createRun(request.body);
            response.status(202).json({ run });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/runs/:id/stop', (request, response, next) => {
        try {
            response.status(202).json({ run: arenaService.stopRun(request.params.id) });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/runs/:id/note', (request, response, next) => {
        try {
            response.json({ run: arenaService.updateRunNote(request.params.id, request.body?.note) });
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/runs/:id', (request, response, next) => {
        try {
            arenaService.deleteRun(request.params.id);
            response.status(204).end();
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/events', (request, response) => {
        response.set({
            'Cache-Control': 'no-cache',
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        const writeState = (event) => {
            response.write(`event: ${event}\ndata: ${JSON.stringify({
                at: new Date().toISOString(),
                revisions: arenaService.getRevisions(),
            })}\n\n`);
        };
        writeState('ready');

        if (shutdownSignal?.aborted) {
            response.end();
            return;
        }

        const heartbeat = setInterval(() => writeState('heartbeat'), STATE_HEARTBEAT_MS);
        let closed = false;
        const cleanup = () => {
            if (closed) {
                return;
            }
            closed = true;
            clearInterval(heartbeat);
            shutdownSignal?.removeEventListener('abort', closeForShutdown);
        };
        const closeForShutdown = () => {
            cleanup();
            response.end();
            response.destroy();
        };
        shutdownSignal?.addEventListener('abort', closeForShutdown, { once: true });
        request.on('close', cleanup);
    });

    const clientDist = path.join(config.rootDir, 'dist');
    if (config.clientDevUrl) {
        app.use((request, response, next) => {
            if (request.method === 'GET' && !request.path.startsWith('/api/')) {
                response.redirect(307, new URL(request.originalUrl, config.clientDevUrl).toString());
                return;
            }
            next();
        });
    } else if (fs.existsSync(path.join(clientDist, 'index.html'))) {
        app.use(express.static(clientDist, {
            setHeaders(response, filePath) {
                if (path.basename(filePath) === 'index.html') {
                    response.set('Cache-Control', 'no-cache');
                } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
                    response.set('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        }));
        app.use((request, response, next) => {
            if (request.method === 'GET' && !request.path.startsWith('/api/')) {
                response.set('Cache-Control', 'no-cache');
                response.sendFile(path.join(clientDist, 'index.html'));
                return;
            }
            next();
        });
    } else {
        app.get('/', (request, response) => {
            response.status(503).type('text').send('Web 界面尚未构建，请运行 npm run build');
        });
    }

    app.use((error, request, response, next) => {
        if (response.headersSent) {
            next(error);
            return;
        }
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
            console.error(error.stack || error.message);
        }
        response.status(statusCode).json({ error: error.message || '服务器内部错误' });
    });
    return app;
}

module.exports = { createApp };
