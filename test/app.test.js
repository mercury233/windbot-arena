'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server/app');

test('scheduled stop API forwards the run and duration', async (context) => {
    const app = createApp({ rootDir: path.resolve(__dirname, '..') }, {}, {
        scheduleStopRun(id, minutes) {
            assert.equal(id, 'run-1');
            assert.equal(minutes, 30);
            return { id, config: { stopAt: '2026-09-11T12:00:00.000Z' } };
        },
    });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs/run-1/schedule-stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: 30 }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).run.config.stopAt, '2026-09-11T12:00:00.000Z');
});

test('graceful stop API dispatches to the service', async (context) => {
    let stoppedId;
    const app = createApp({ rootDir: path.resolve(__dirname, '..') }, {}, {
        gracefulStopRun(id) {
            stoppedId = id;
            return { id, status: 'settling' };
        },
    });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs/run-1/graceful-stop`, {
        method: 'POST',
    });
    assert.equal(response.status, 202);
    assert.equal(stoppedId, 'run-1');
    assert.deepEqual(await response.json(), { run: { id: 'run-1', status: 'settling' } });
});

test('development backend redirects page requests to the Vite server', async (context) => {
    const service = {};
    const app = createApp({
        clientDevUrl: 'http://127.0.0.1:5173',
        rootDir: path.resolve(__dirname, '..'),
    }, {}, service);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/history?page=2`, {
        redirect: 'manual',
    });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), 'http://127.0.0.1:5173/history?page=2');
});

test('settings, room, WindBot and run APIs return service data', async (context) => {
    let savedSettings;
    let refreshedDecks = false;
    let requestedRunPage;
    let deletedRunId;
    let noteUpdate;
    let halfwayWatchUpdate;
    const publicRecord = {
        secretStatus: { srvpros: { 'srvpro-1': { passwordConfigured: true } } },
        settings: { srvpros: [{ id: 'srvpro-1', password: '' }] },
        updatedAt: '2026-08-08T00:00:00.000Z',
    };
    const service = {
        getSettings: () => publicRecord,
        getWindBotOutput: (name) => ({ available: true, name, output: 'ready' }),
        listRooms: (srvproId) => ({ rooms: [{ id: '123', name: srvproId }] }),
        updateHalfwayWatch: (srvproId, enabled) => {
            halfwayWatchUpdate = { enabled, srvproId };
            return { enableHalfwayWatch: enabled };
        },
        refreshBotConfigs: () => {
            refreshedDecks = true;
            return { configuration: {}, fetchedRemoteCount: 1 };
        },
        updateSettings: (settings) => {
            savedSettings = settings;
            return publicRecord;
        },
        deleteRun: (runId) => {
            deletedRunId = runId;
        },
        updateRunNote: (id, note) => {
            noteUpdate = { id, note };
            return noteUpdate;
        },
    };
    const database = {
        getRunCount: () => 23,
        listRuns: (limit, offset) => {
            requestedRunPage = { limit, offset };
            return [{ id: 'run-21' }];
        },
        findActiveRuns: () => [{ id: 'run-active' }],
        getRun: (id) => ({ id, srvproId: 'srvpro-1' }),
    };
    const app = createApp({ rootDir: path.resolve(__dirname, '..') }, database, service);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await settingsResponse.json(), publicRecord);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/srvpro/rooms?srvproId=srvpro-2`)).json(), {
        rooms: [{ id: '123', name: 'srvpro-2' }],
    });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/srvpro/halfwaywatch`, {
        body: JSON.stringify({ enabled: false, srvproId: 'srvpro-2' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
    })).json(), { enableHalfwayWatch: false });
    assert.deepEqual(halfwayWatchUpdate, { enabled: false, srvproId: 'srvpro-2' });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/windbots/current/output`)).json(), {
        available: true,
        name: 'current',
        output: 'ready',
    });
    const siteResponse = await fetch(`${baseUrl}/`);
    assert.equal(siteResponse.headers.get('cache-control'), 'no-cache');
    await fetch(`${baseUrl}/api/settings`, {
        body: JSON.stringify({ srvpros: [{ host: 'srvpro.lan' }] }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
    });
    assert.equal(savedSettings.srvpros[0].host, 'srvpro.lan');
    const refreshResponse = await fetch(`${baseUrl}/api/decks/refresh`, { method: 'POST' });
    assert.equal(refreshResponse.status, 200);
    assert.equal(refreshedDecks, true);
    const runsResponse = await fetch(`${baseUrl}/api/runs?limit=10&offset=20`);
    assert.deepEqual(await runsResponse.json(), {
        runs: [{ id: 'run-21' }],
        total: 23,
    });
    assert.deepEqual(requestedRunPage, { limit: 10, offset: 20 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/runs/active`)).json(), {
        runs: [{ id: 'run-active', srvproId: 'srvpro-1' }],
    });
    const deleteResponse = await fetch(`${baseUrl}/api/runs/run-21`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 204);
    assert.equal(deletedRunId, 'run-21');
    const noteResponse = await fetch(`${baseUrl}/api/runs/run-21/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: '手动备注' }),
    });
    assert.equal(noteResponse.status, 200);
    assert.deepEqual(await noteResponse.json(), { run: { id: 'run-21', note: '手动备注' } });
    assert.deepEqual(noteUpdate, { id: 'run-21', note: '手动备注' });

});

test('shutdown signal closes SSE connections so the HTTP server can stop', async () => {
    const shutdownController = new AbortController();
    const service = {
        getRevisions: () => ({ active: 3, runs: 2, system: 1 }),
    };
    const app = createApp(
        { rootDir: path.resolve(__dirname, '..') },
        {},
        service,
        shutdownController.signal,
    );
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const eventsResponse = await fetch(`http://127.0.0.1:${address.port}/api/events`);
    assert.equal(eventsResponse.status, 200);
    const firstEvent = new TextDecoder().decode((await eventsResponse.body.getReader().read()).value);
    assert.match(firstEvent, /event: ready/);
    assert.match(firstEvent, /"revisions":\{"active":3,"runs":2,"system":1\}/);

    const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    shutdownController.abort();
    await serverClosed;

});
