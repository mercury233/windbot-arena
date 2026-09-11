'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_WEBHOOK_TEMPLATE = JSON.stringify({
    title: '{{title}}', body: '{{body}}',
}, null, 2);
const TEMPLATE_FIELDS = ['title', 'body', 'runId', 'status', 'finishedAt', 'srvproId', 'note'];

function renderWebhookUrl(template, payload) {
    const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (match, field) => {
        if (!TEMPLATE_FIELDS.includes(field)) throw new Error(`未知通知模板变量: ${field}`);
        return encodeURIComponent(String(payload[field] ?? ''));
    });
    const url = new URL(rendered);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error('Webhook 必须是无内嵌账号密码和片段的 HTTP(S) URL');
    }
    return rendered;
}

function renderWebhookTemplate(template, payload) {
    // 在解析后的字符串中替换，避免任务文本中的引号、换行改变 JSON 结构。
    return JSON.parse(template, (key, value) => typeof value === 'string'
        ? value.replace(/\{\{([^{}]+)\}\}/g, (match, field) => {
            if (!TEMPLATE_FIELDS.includes(field)) throw new Error(`未知通知模板变量: ${field}`);
            return String(payload[field] ?? '');
        })
        : value);
}

class Notifications extends EventEmitter {
    constructor(database, fetchImpl = fetch) {
        super();
        this.setMaxListeners(0);
        this.database = database;
        this.fetch = fetchImpl;
    }

    async send(run) {
        const settings = this.database.getArenaSettings().settings.notifications;
        if (!settings || settings.mode === 'off') return;
        const statusLabel = { completed: '完成', failed: '失败', stopped: '停止', interrupted: '中断' }[run.status];
        if (!statusLabel) return;
        const payload = {
            title: `WindBot Arena · 任务${statusLabel}`,
            body: `${run.note || run.id}（${run.srvproId}）`,
            runId: run.id, status: run.status, finishedAt: run.finishedAt,
            srvproId: run.srvproId, note: run.note || '',
        };
        await this.deliver(payload, settings);
    }

    async deliver(payload, settings) {
        if (settings.mode === 'frontend') {
            this.emit('notification', payload);
            return;
        }
        if (settings.mode !== 'webhook') return;
        const method = settings.webhookMethod || 'POST';
        const headers = JSON.parse(settings.webhookHeaders?.trim() || '{}');
        const response = await this.fetch(renderWebhookUrl(settings.webhookUrl, payload), {
            method,
            headers: method === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
            ...(method === 'POST' ? { body: JSON.stringify(renderWebhookTemplate(settings.webhookTemplate, payload)) } : {}),
            signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
    }
}

module.exports = { Notifications, DEFAULT_WEBHOOK_TEMPLATE, renderWebhookTemplate, renderWebhookUrl };
