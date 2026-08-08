'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server/app');

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
    const publicRecord = {
        secretStatus: { passwordConfigured: true },
        settings: { srvpro: { password: '' } },
        updatedAt: '2026-08-08T00:00:00.000Z',
    };
    const service = {
        getSettings: () => publicRecord,
        getWindBotOutput: (name) => ({ available: true, name, output: 'ready' }),
        listRooms: () => ({ rooms: [{ id: '123', name: 'M,RANDOM#123' }] }),
        refreshBotConfigs: () => {
            refreshedDecks = true;
            return { configuration: {}, fetchedRemoteCount: 1 };
        },
        updateSettings: (settings) => {
            savedSettings = settings;
            return publicRecord;
        },
    };
    const database = {
        getRunCount: () => 23,
        listRuns: (limit, offset) => {
            requestedRunPage = { limit, offset };
            return [{ id: 'run-21' }];
        },
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
    assert.deepEqual(await (await fetch(`${baseUrl}/api/srvpro/rooms`)).json(), {
        rooms: [{ id: '123', name: 'M,RANDOM#123' }],
    });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/windbots/current/output`)).json(), {
        available: true,
        name: 'current',
        output: 'ready',
    });
    const siteResponse = await fetch(`${baseUrl}/`);
    assert.equal(siteResponse.headers.get('cache-control'), 'no-cache');
    await fetch(`${baseUrl}/api/settings`, {
        body: JSON.stringify({ srvpro: { host: 'srvpro.lan' } }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
    });
    assert.equal(savedSettings.srvpro.host, 'srvpro.lan');
    const refreshResponse = await fetch(`${baseUrl}/api/decks/refresh`, { method: 'POST' });
    assert.equal(refreshResponse.status, 200);
    assert.equal(refreshedDecks, true);
    const runsResponse = await fetch(`${baseUrl}/api/runs?limit=10&offset=20`);
    assert.deepEqual(await runsResponse.json(), {
        runs: [{ id: 'run-21' }],
        total: 23,
    });
    assert.deepEqual(requestedRunPage, { limit: 10, offset: 20 });

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
