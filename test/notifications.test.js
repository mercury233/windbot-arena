'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:http');
const path = require('node:path');
const { Notifications, renderWebhookTemplate } = require('../server/notifications');
const { createDefaultArenaSettings, validateAndMergeArenaSettings, getPublicArenaSettings } = require('../server/arena-settings');
const { ArenaDatabase } = require('../server/database');
const { ArenaService } = require('../server/arena-service');
const { createApp } = require('../server/app');

test('notification settings validate templates and return editable tokens', () => {
    const settings = createDefaultArenaSettings();
    settings.notifications = {
        mode: 'webhook', webhookUrl: 'https://example.com/notify?access_token=secret',
        webhookTemplate: '{"accessToken":"body-secret","text":{"content":"{{body}}"}}',
        webhookHeaders: '{"Authorization":"Bearer header-secret"}',
    };
    const saved = validateAndMergeArenaSettings(settings, settings);
    const publicRecord = getPublicArenaSettings(saved);
    for (const value of ['access_token=secret', 'body-secret', 'header-secret']) {
        assert.equal(JSON.stringify(publicRecord).includes(value), true);
    }
    assert.deepEqual(validateAndMergeArenaSettings(publicRecord.settings, saved), saved);
    for (const notifications of [
        { mode: 'push' }, { webhookUrl: 'file:///tmp/test' },
        { webhookTemplate: '{invalid' }, { webhookTemplate: '[]' },
        { webhookTemplate: '{"body":"{{unknown}}"}' },
        { webhookHeaders: '{"Content-Type":"text/plain"}' },
        { webhookHeaders: '{"X-Token":"bad\\r\\nvalue"}' },
    ]) {
        assert.throws(() => validateAndMergeArenaSettings({
            ...settings, notifications: { ...settings.notifications, ...notifications },
        }, saved));
    }
});

test('POST templates are required and defaults contain only title and body', async () => {
    const settings = createDefaultArenaSettings();
    assert.deepEqual(JSON.parse(settings.notifications.webhookTemplate), { title: '{{title}}', body: '{{body}}' });
    Object.assign(settings.notifications, { mode: 'webhook', webhookUrl: 'https://example.com' });
    for (const template of ['', ' \n ', null]) {
        const input = structuredClone(settings);
        input.notifications.webhookTemplate = template;
        assert.throws(() => validateAndMergeArenaSettings(input, settings), /请求体模板不能为空/);
        input.notifications.webhookMethod = 'GET';
        assert.doesNotThrow(() => validateAndMergeArenaSettings(input, settings));
    }
    settings.notifications.webhookTemplate = '';
    const notifications = new Notifications({ getArenaSettings: () => ({ settings }) }, () => assert.fail('empty template must not be sent'));
    await assert.rejects(notifications.send({ id: 'run', status: 'completed' }));
});

test('template migration upgrades old defaults and preserves custom templates', (t) => {
    const database = new ArenaDatabase(':memory:');
    t.after(() => database.close());
    for (const template of ['', JSON.stringify({ title: '{{title}}', body: '{{body}}', runId: '{{runId}}', status: '{{status}}', finishedAt: '{{finishedAt}}' }, null, 2), '{"token":"custom","text":"{{body}}"}']) {
        const settings = createDefaultArenaSettings();
        settings.notifications.webhookTemplate = template;
        database.saveArenaSettings(settings);
        database.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run('004_notifications.sql');
        database.migrate();
        assert.deepEqual(JSON.parse(database.getArenaSettings().settings.notifications.webhookTemplate), template.includes('custom')
            ? JSON.parse(template) : { title: '{{title}}', body: '{{body}}' });
    }
});

test('webhook renders nested JSON safely and posts custom tokens without following redirects', async () => {
    const settings = createDefaultArenaSettings();
    settings.notifications = {
        mode: 'webhook', webhookUrl: 'https://example.com/hook?access_token=url-token',
        webhookHeaders: '{"Authorization":"Bearer header-token"}',
        webhookTemplate: '{"accessToken":"body-token","items":[{"text":"{{note}} / {{status}}"}],"enabled":true}',
    };
    const note = '"quoted"\n中文 {{runId}}';
    const notifications = new Notifications({ getArenaSettings: () => ({ settings }) }, async (url, options) => {
        assert.equal(url, settings.notifications.webhookUrl);
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer header-token');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(options.body), {
            accessToken: 'body-token', items: [{ text: `${note} / completed` }], enabled: true,
        });
        return new Response(null, { status: 204 });
    });
    await notifications.send({ id: 'run-1', status: 'completed', note, srvproId: 'srvpro-1' });
    assert.equal(renderWebhookTemplate('{"text":"{{note}}"}', { note }).text, note);
    notifications.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(notifications.send({ id: 'run-1', status: 'failed' }), /HTTP 503/);
});

test('frontend and disabled modes never call external services', async () => {
    const settings = createDefaultArenaSettings();
    const notifications = new Notifications({ getArenaSettings: () => ({ settings }) }, () => assert.fail('unexpected HTTP'));
    const received = [];
    notifications.on('notification', (payload) => received.push(payload));
    await notifications.send({ status: 'completed' });
    assert.equal(received.length, 0);
    settings.notifications.mode = 'frontend';
    for (const status of ['completed', 'failed', 'stopped', 'interrupted']) {
        await notifications.send({ id: status, status, srvproId: 'srvpro-1' });
    }
    assert.deepEqual(received.map((payload) => payload.status), ['completed', 'failed', 'stopped', 'interrupted']);
    assert.equal(received[3].title, 'WindBot Arena · 任务中断');
});

test('POST renders URL templates and persists blank HTTP headers', async (t) => {
    const database = new ArenaDatabase(':memory:');
    t.after(() => database.close());
    const input = createDefaultArenaSettings();
    assert.equal(input.notifications.webhookHeaders, '');
    Object.assign(input.notifications, {
        mode: 'webhook', webhookUrl: 'https://example.com/{{runId}}?note={{note}}', webhookHeaders: ' \n ',
    });
    const settings = validateAndMergeArenaSettings(input, input);
    database.saveArenaSettings(settings);
    assert.equal(database.getArenaSettings().settings.notifications.webhookHeaders, '');
    assert.equal(getPublicArenaSettings(settings).settings.notifications.webhookHeaders, '');
    let calls = 0;
    const notifications = new Notifications(database, async (url, options) => {
        calls++;
        assert.equal(url, 'https://example.com/run%2F1?note=%E4%B8%AD%E6%96%87%26%23');
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
        assert.equal(JSON.parse(options.body).body, '中文&#（srvpro-1）');
        return new Response(null, { status: 204 });
    });
    await notifications.send({ id: 'run/1', status: 'completed', note: '中文&#', srvproId: 'srvpro-1' });
    assert.equal(calls, 1);
    input.notifications.webhookUrl = 'https://example.com/?text={{unknown}}';
    assert.throws(() => validateAndMergeArenaSettings(input, settings), /URL 或模板变量无效/);
    for (const headers of ['{}', '', '{"Authorization":"Bearer keep"}']) {
        settings.notifications.webhookHeaders = headers;
        database.saveArenaSettings(settings);
        database.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run('004_notifications.sql');
        database.migrate();
        assert.equal(database.getArenaSettings().settings.notifications.webhookHeaders, headers === '{}' ? '' : headers);
    }
});

test('GET webhook encodes URL template values and sends headers without a body', async () => {
    const settings = createDefaultArenaSettings();
    Object.assign(settings.notifications, {
        mode: 'webhook', webhookMethod: 'GET',
        webhookUrl: 'https://example.com/{{runId}}?token=fixed&text={{note}}',
        webhookHeaders: '{"Authorization":"Bearer token"}',
    });
    const saved = validateAndMergeArenaSettings(settings, settings);
    const note = '中文 &x=1#fragment /?\n{{status}}';
    let calls = 0;
    const notifications = new Notifications({ getArenaSettings: () => ({ settings: saved }) }, async (url, options) => {
        calls++;
        assert.equal(url, `https://example.com/run%2F1?token=fixed&text=${encodeURIComponent(note)}`);
        assert.equal(new URL(url).searchParams.get('text'), note);
        assert.equal(options.method, 'GET');
        assert.equal('body' in options, false);
        assert.deepEqual(options.headers, { Authorization: 'Bearer token' });
        return new Response(null, { status: 204 });
    });
    await notifications.send({ id: 'run/1', note, status: 'completed' });
    assert.equal(calls, 1);
    await notifications.send({ id: 'run/1', note, status: 'interrupted' });
    assert.equal(calls, 2);
    for (const changes of [
        { webhookMethod: 'DELETE' },
        { webhookUrl: 'https://example.com/?text={{unknown}}' },
        { webhookUrl: 'javascript:{{body}}' },
    ]) {
        assert.throws(() => validateAndMergeArenaSettings({ ...settings,
            notifications: { ...settings.notifications, ...changes },
        }, settings));
    }
    const cleared = validateAndMergeArenaSettings({ ...settings,
        notifications: { ...settings.notifications, mode: 'off', webhookUrl: '', webhookHeaders: '' },
    }, saved);
    assert.equal(cleared.notifications.webhookUrl, '');
    assert.equal(cleared.notifications.webhookHeaders, '');
});

test('webhook method migration preserves old POST settings and subsequent GET selection', (t) => {
    const database = new ArenaDatabase(':memory:');
    t.after(() => database.close());
    const settings = createDefaultArenaSettings();
    delete settings.notifications.webhookMethod;
    settings.notifications.webhookUrl = 'https://example.com/?token=saved';
    database.saveArenaSettings(settings);
    database.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run('004_notifications.sql');
    database.migrate();
    const migrated = database.getArenaSettings().settings;
    assert.deepEqual(migrated.notifications, { ...settings.notifications, webhookMethod: 'POST' });
    migrated.notifications.webhookMethod = 'GET';
    database.saveArenaSettings(migrated);
    database.migrate();
    assert.deepEqual(database.getArenaSettings().settings.notifications, migrated.notifications);
});

test('notification migration preserves existing configuration and runs once', (t) => {
    const database = new ArenaDatabase(':memory:');
    t.after(() => database.close());
    const legacy = createDefaultArenaSettings();
    delete legacy.notifications;
    legacy.srvpros[0].password = 'existing-secret';
    database.saveArenaSettings(legacy);
    database.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run('004_notifications.sql');
    database.migrate();
    const settings = database.getArenaSettings().settings;
    assert.equal(settings.notifications.mode, 'off');
    assert.equal(settings.srvpros[0].password, 'existing-secret');
    settings.notifications = { mode: 'webhook', webhookUrl: 'https://example.com', webhookTemplate: '{"token":"saved"}', webhookHeaders: '{}' };
    database.saveArenaSettings(settings);
    database.migrate();
    assert.deepEqual(database.getArenaSettings().settings, settings);
});

test('delivery failure preserves final status and logs no endpoint credentials', async (t) => {
    const database = new ArenaDatabase(':memory:');
    t.after(() => database.close());
    database.createRun({ id: 'run', kind: 'ranking', gamesPerMatchup: 0, createdAt: new Date().toISOString(), config: {}, matchups: [], srvproId: 'srvpro-1' });
    const service = new ArenaService({}, database);
    service.notifications.send = async () => { throw new Error('https://example.com?token=private'); };
    const context = { id: 'run', srvproId: 'srvpro-1', abortController: new AbortController() };
    service.contexts.set(context.srvproId, context);
    await service.finish(context, 'completed', '完成');
    const run = database.getRun('run');
    assert.equal(run.status, 'completed');
    assert.equal(service.contexts.size, 0);
    assert.equal(JSON.stringify(run).includes('private'), false);
    assert.ok(JSON.stringify(run).includes('notification-error'));
});

test('manual immediate stop skips notification while other endings still notify', async (t) => {
    for (const outcome of ['manual', 'manual-after-graceful', 'graceful', 'shutdown', 'completed', 'failed', 'interrupted']) {
        await t.test(outcome, async (t) => {
            const database = new ArenaDatabase(':memory:');
            t.after(() => database.close());
            database.createRun({ id: 'run', kind: 'ranking', gamesPerMatchup: 0, createdAt: new Date().toISOString(), config: {}, matchups: [], srvproId: 'srvpro-1' });
            const service = new ArenaService({}, database);
            const sent = [];
            service.notifications.send = async (run) => sent.push(run.status);
            const context = { id: 'run', srvproId: 'srvpro-1', running: true, abortController: new AbortController() };
            service.contexts.set(context.srvproId, context);
            if (outcome === 'graceful' || outcome === 'manual-after-graceful') service.gracefulStopRun('run');
            if (outcome.startsWith('manual')) service.stopRun('run');
            if (outcome === 'shutdown') service.stopRun('run', 'Arena 服务正在关闭');
            const status = ['completed', 'failed', 'interrupted'].includes(outcome) ? outcome : 'stopped';
            await service.finish(context, status, context.stopReason || '任务结束');
            assert.deepEqual(sent, outcome.startsWith('manual') ? [] : [status]);
            assert.equal(database.getRun('run').status, status);
            assert.equal(service.contexts.size, 0);
            assert.equal(service.pendingNotifications.size, 0);
        });
    }
});

test('shutdown waits for notifications after tasks leave the active list', async (t) => {
    for (const outcome of ['success', 'failure', 'deleted']) {
        await t.test(outcome, async (t) => {
            const database = new ArenaDatabase(':memory:');
            t.after(() => database.close());
            database.createRun({ id: 'run', kind: 'ranking', gamesPerMatchup: 0, createdAt: new Date().toISOString(), config: {}, matchups: [], srvproId: 'srvpro-1' });
            const service = new ArenaService({}, database);
            let resolveDelivery;
            let rejectDelivery;
            let deliveryStarted;
            const started = new Promise((resolve) => { deliveryStarted = resolve; });
            service.notifications.send = () => {
                deliveryStarted();
                return new Promise((resolve, reject) => {
                    resolveDelivery = resolve;
                    rejectDelivery = reject;
                });
            };
            const context = { id: 'run', srvproId: 'srvpro-1', abortController: new AbortController() };
            service.contexts.set(context.srvproId, context);
            context.done = service.finish(context, 'completed', '完成');
            await started;
            assert.equal(service.contexts.size, 0);
            assert.equal(database.getRun('run').status, 'completed');
            const revisions = service.getRevisions();
            if (outcome === 'deleted') service.deleteRun('run');
            let shutdownFinished = false;
            const shutdown = service.shutdown().then(() => { shutdownFinished = true; });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(shutdownFinished, false);
            if (outcome === 'success') resolveDelivery();
            else rejectDelivery(new Error('https://example.com?token=private'));
            await Promise.all([context.done, shutdown]);
            assert.equal(shutdownFinished, true);
            assert.equal(service.pendingNotifications.size, 0);
            if (outcome === 'failure') {
                const run = database.getRun('run');
                assert.equal(run.status, 'completed');
                assert.ok(JSON.stringify(run).includes('notification-error'));
                assert.equal(JSON.stringify(run).includes('private'), false);
                assert.equal(service.getRevisions().runs, revisions.runs + 1);
            } else if (outcome === 'deleted') {
                assert.equal(database.getRun('run'), null);
            }
        });
    }
});

test('frontend notifications reach SSE clients and remove listeners on shutdown', async (t) => {
    const notifications = new Notifications({});
    const shutdown = new AbortController();
    const app = createApp({ rootDir: path.resolve(__dirname, '..') }, {}, {
        notifications, getRevisions: () => ({ active: 0, runs: 0, system: 0 }),
    }, shutdown.signal);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { shutdown.abort(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`);
    const reader = response.body.getReader();
    await reader.read();
    notifications.emit('notification', { title: '完成', body: '测试', runId: 'run' });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /event: notification/);
    assert.match(chunk, /"title":"完成"/);
    shutdown.abort();
    assert.equal(notifications.listenerCount('notification'), 0);
    await reader.cancel();
});

test('webhook test API uses unsaved GET/POST settings and reports failures without saving', async (t) => {
    const database = new ArenaDatabase(':memory:');
    const service = new ArenaService({}, database);
    const original = database.getArenaSettings();
    const requests = [];
    service.notifications.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(null, { status: 204 });
    };
    const server = createServer(createApp({ rootDir: path.resolve(__dirname, '..') }, database, service));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        database.close();
    });
    const endpoint = `http://127.0.0.1:${server.address().port}/api/notifications/test`;
    for (const method of ['GET', 'POST']) {
        const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...original.settings.notifications,
                mode: 'webhook', webhookMethod: method,
                webhookUrl: 'https://example.com/{{runId}}?title={{title}}',
                webhookHeaders: '{"Authorization":"Bearer draft-token"}',
            }),
        });
        assert.equal(response.status, 200);
        assert.match((await response.json()).message, /成功发送/);
        const request = requests.at(-1);
        assert.equal(request.options.method, method);
        assert.equal(request.options.headers.Authorization, 'Bearer draft-token');
        assert.equal(new URL(request.url).pathname, '/notification-test');
        assert.equal(new URL(request.url).searchParams.get('title'), 'WindBot Arena · 测试通知');
        if (method === 'POST') assert.deepEqual(JSON.parse(request.options.body), {
            title: 'WindBot Arena · 测试通知', body: '这是一条测试通知（srvpro-1）',
        });
        else assert.equal('body' in request.options, false);
    }
    const invalid = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...original.settings.notifications, mode: 'webhook', webhookUrl: 'https://example.com', webhookTemplate: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /不能为空/);
    assert.equal(requests.length, 2);
    service.notifications.fetch = async () => { throw new Error('https://example.com/?token=private-secret'); };
    const failed = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...original.settings.notifications, mode: 'webhook', webhookUrl: 'https://example.com' }),
    });
    assert.equal(failed.status, 502);
    const error = await failed.json();
    assert.match(error.error, /发送失败/);
    assert.equal(JSON.stringify(error).includes('private-secret'), false);
    assert.deepEqual(database.getArenaSettings(), original);
    assert.equal(database.getRunCount(), 0);
});
