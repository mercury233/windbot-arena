'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createApp, readRankPayload } = require('../server/app');

test('readRankPayload accepts the SRVPro form body', () => {
    const rank = [['新-Dragon', { win: 2, lose: 1, flee: 0 }]];
    const body = new URLSearchParams({
        accesskey: 'secret',
        rank: JSON.stringify(rank),
    }).toString();
    assert.deepEqual(readRankPayload(body), {
        accessKey: 'secret',
        rank,
    });
});

test('settings API saves configuration and the configured rank endpoint checks the stored key', async (context) => {
    let savedSettings;
    let receivedRank;
    const publicRecord = {
        secretStatus: { accessKeyConfigured: true, passwordConfigured: true },
        settings: { srvpro: { accessKey: '', password: '' } },
        updatedAt: '2026-08-08T00:00:00.000Z',
    };
    const service = {
        getRankAccessKey: () => 'rank-secret',
        getRankPostPath: () => '/score/report',
        getSettings: () => publicRecord,
        receiveRank: (rank) => { receivedRank = rank; },
        updateSettings: (settings) => {
            savedSettings = settings;
            return publicRecord;
        },
    };
    const database = {};
    const app = createApp({ rootDir: path.resolve(__dirname, '..') }, database, service);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await settingsResponse.json(), publicRecord);
    const siteResponse = await fetch(`${baseUrl}/`);
    assert.equal(siteResponse.headers.get('cache-control'), 'no-cache');
    await fetch(`${baseUrl}/api/settings`, {
        body: JSON.stringify({ srvpro: { host: 'srvpro.lan' } }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
    });
    assert.equal(savedSettings.srvpro.host, 'srvpro.lan');

    const rank = [['新-Dragon', { win: 1 }]];
    const rejected = await fetch(`${baseUrl}/score/report`, {
        body: new URLSearchParams({ accesskey: 'wrong', rank: JSON.stringify(rank) }),
        method: 'POST',
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${baseUrl}/score/report`, {
        body: new URLSearchParams({ accesskey: 'rank-secret', rank: JSON.stringify(rank) }),
        method: 'POST',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(receivedRank, rank);

    const unconfiguredPath = await fetch(`${baseUrl}/`, {
        body: new URLSearchParams({ accesskey: 'rank-secret', rank: JSON.stringify(rank) }),
        method: 'POST',
    });
    assert.equal(unconfiguredPath.status, 404);
});

test('shutdown signal closes SSE connections so the HTTP server can stop', async () => {
    const shutdownController = new AbortController();
    const listeners = new Set();
    const service = {
        getRankPostPath: () => '/score/report',
        off: (event, listener) => listeners.delete(listener),
        on: (event, listener) => listeners.add(listener),
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
    assert.equal(listeners.size, 1);

    const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    shutdownController.abort();
    await serverClosed;

    assert.equal(listeners.size, 0);
});
