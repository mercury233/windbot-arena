<script setup>
import { ref, watch } from 'vue';
import {
    NAlert,
    NButton,
    NCard,
    NForm,
    NFormItem,
    NInput,
    NInputNumber,
    NModal,
    NRadioButton,
    NRadioGroup,
    NTabPane,
    NTabs,
} from 'naive-ui';

const props = defineProps({
    disabled: Boolean,
    record: { type: Object, default: null },
    saving: Boolean,
    show: Boolean,
});
const emit = defineEmits(['save', 'update:show']);
const draft = ref(null);
const cancelButton = ref(null);
const notificationTestResult = ref('');
const testingNotification = ref(false);
const webhookHeadersExample = JSON.stringify({ Authorization: 'Bearer 你的 token' });
const webhookExample = JSON.stringify({
    title: '{{title}}',
    body: '{{body}}',
}, null, 2);
const windbotLabels = {
    current: '新版 WindBot',
    old: '旧版 WindBot',
};

function cloneSettings(value) {
    return JSON.parse(JSON.stringify(value));
}

watch(() => [props.show, props.record], () => {
    if (props.show && props.record) {
        draft.value = cloneSettings(props.record.settings);
    }
}, { immediate: true });

function close() {
    emit('update:show', false);
}

function save() {
    emit('save', cloneSettings(draft.value));
}

async function testNotification() {
    if (testingNotification.value) return;
    testingNotification.value = true;
    notificationTestResult.value = '';
    try {
        if (draft.value.notifications.mode === 'frontend') {
            if (!window.isSecureContext || !('Notification' in window)) {
                notificationTestResult.value = '当前浏览器不支持浏览器通知，或页面未使用 HTTPS / localhost。';
                return;
            }
            const permission = Notification.permission === 'default'
                ? await Notification.requestPermission() : Notification.permission;
            if (permission !== 'granted') {
                notificationTestResult.value = '未获得浏览器通知权限，可在浏览器站点设置中允许通知后重试。';
                return;
            }
            try {
                new Notification('WindBot Arena · 测试通知', {
                    body: '这是一条浏览器测试通知。', tag: 'arena-notification-test', icon: '/arena.ico',
                });
                notificationTestResult.value = '已请求显示浏览器通知，请检查设备的通知中心。';
            } catch {
                notificationTestResult.value = '当前浏览器无法显示浏览器通知。';
            }
        } else if (draft.value.notifications.mode === 'webhook') {
            const response = await fetch('/api/notifications/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft.value.notifications),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '测试通知发送失败');
            notificationTestResult.value = result.message;
        }
    } catch (error) {
        notificationTestResult.value = error.message || '测试通知失败';
    } finally {
        testingNotification.value = false;
    }
}

function addSrvpro() {
    let id;
    do {
        const parts = new Uint32Array(4);
        if (typeof globalThis.crypto?.getRandomValues === 'function') {
            globalThis.crypto.getRandomValues(parts);
        } else {
            for (let index = 0; index < parts.length; index++) {
                parts[index] = Math.floor(Math.random() * 0x100000000);
            }
        }
        const token = Array.from(
            parts,
            (part) => part.toString(36).padStart(7, '0'),
        ).join('');
        id = `srvpro-${token}`;
    } while (draft.value.srvpros.some((srvpro) => srvpro.id === id));
    draft.value.srvpros.push({
        duelPort: 7911,
        host: '',
        id,
        maxRooms: 100,
        name: `SRVPro ${draft.value.srvpros.length + 1}`,
        password: '',
        roomsPerSecond: 1,
        statusPort: 7922,
        username: '',
    });
}

function removeSrvpro(index) {
    if (draft.value.srvpros.length > 1) {
        draft.value.srvpros.splice(index, 1);
    }
}
</script>

<template>
    <n-modal
        v-if="draft"
        :show="show"
        :mask-closable="false"
        :auto-focus="false"
        @after-enter="cancelButton?.$el.focus({ preventScroll: true })"
        @update:show="emit('update:show', $event)"
    >
        <n-card
            class="settings-card"
            :content-style="{ minHeight: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0' }"
            :segmented="{ action: true }"
            title="Arena 系统配置"
            :bordered="false"
            role="dialog"
            aria-modal="true"
        >
            <n-tabs
                v-if="show"
                type="line"
                class="settings-tabs"
                :pane-style="{ flex: '1', minHeight: '0', overflowY: 'auto', scrollbarGutter: 'stable', paddingLeft: 'var(--n-padding-left)', paddingRight: 'var(--n-padding-left)', paddingBottom: '22px' }"
            >
                <n-tab-pane name="notifications" tab="通知">
                    <n-form label-placement="top" class="settings-form" :show-feedback="false">
                        <n-alert type="info" :bordered="false">
                            任务完成、中断或失败时通知。浏览器通知需要页面保持打开；Webhook 由 Arena 后端发送，关闭页面后仍可发送。
                        </n-alert>
                        <n-form-item label="通知模式">
                            <n-radio-group v-model:value="draft.notifications.mode">
                                <n-radio-button value="off">关闭</n-radio-button>
                                <n-radio-button value="frontend">浏览器通知</n-radio-button>
                                <n-radio-button value="webhook">Webhook</n-radio-button>
                            </n-radio-group>
                        </n-form-item>
                        <template v-if="draft.notifications.mode === 'frontend'">
                            <n-form-item label="浏览器通知">
                                <div class="notification-test-row">
                                    <n-button :loading="testingNotification" @click="testNotification">测试通知</n-button>
                                    <n-alert v-if="notificationTestResult" type="info" :bordered="false">{{ notificationTestResult }}</n-alert>
                                </div>
                            </n-form-item>
                            <p>首次使用请先测试一次通知以申请浏览器通知权限。页面需要保持打开才能接收通知。</p>
                        </template>
                        <template v-if="draft.notifications.mode === 'webhook'">
                            <n-form-item label="请求方式">
                                <n-radio-group v-model:value="draft.notifications.webhookMethod">
                                    <n-radio-button value="POST">POST</n-radio-button>
                                    <n-radio-button value="GET">GET</n-radio-button>
                                </n-radio-group>
                            </n-form-item>
                            <n-form-item label="Webhook URL 模板">
                                <n-input v-model:value="draft.notifications.webhookUrl"
                                    placeholder="https://example.com/notify?access_token=…" />
                            </n-form-item>
                            <n-form-item v-if="draft.notifications.webhookMethod === 'POST'" label="JSON 请求体模板">
                                <n-input v-model:value="draft.notifications.webhookTemplate" type="textarea" :autosize="{ minRows: 6, maxRows: 16 }"
                                    :placeholder="webhookExample" />
                            </n-form-item>
                            <p v-if="draft.notifications.webhookMethod === 'POST'">POST 支持嵌套 JSON 和固定字段（例如 accessToken）；请求体模板不能为空。</p>
                            <p v-pre>模板变量：{{title}}、{{body}}、{{runId}}、{{status}}、{{finishedAt}}、{{srvproId}}、{{note}}。</p>
                            <p v-pre>{{title}} 内容为“WindBot Arena · 任务完成/失败/停止/中断”，根据任务状态显示对应文本。{{body}} 内容为“任务备注（SRVPro 实例 ID）”，没有备注时使用任务 ID，例如“新版回归测试（srvpro-1）”。</p>
                            <n-form-item label="自定义 HTTP 请求头（可选）">
                                <n-input v-model:value="draft.notifications.webhookHeaders" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }"
                                    :placeholder="webhookHeadersExample" />
                            </n-form-item>
                            <p>以 JSON 格式填写 HTTP 请求头；留空不进行自定义。<span v-if="draft.notifications.webhookMethod === 'POST'">POST 的 Content-Type 固定为 application/json。</span></p>
                            <div class="notification-test-row">
                                <n-button :loading="testingNotification" @click="testNotification">测试通知</n-button>
                                <n-alert v-if="notificationTestResult" type="info" :bordered="false">{{ notificationTestResult }}</n-alert>
                            </div>
                            <p>使用当前表单配置发送测试通知，无需先保存设置。</p>
                        </template>
                    </n-form>
                </n-tab-pane>
                <n-tab-pane name="srvpro" tab="SRVPro">
                    <n-alert type="info" :bordered="false">
                        SRVPro 需自行安装和运行。每个实例都应仅供 Arena 使用。任务会独占所选实例；不同实例上的任务可以同时运行。
                    </n-alert>
                    <div class="srvpro-settings">
                        <section
                            v-for="(srvpro, index) in draft.srvpros"
                            :key="srvpro.id"
                            class="srvpro-instance"
                        >
                            <div class="instance-heading">
                                <div>
                                    <span>INSTANCE {{ String(index + 1).padStart(2, '0') }}</span>
                                    <h3>{{ srvpro.name || '未命名 SRVPro' }}</h3>
                                </div>
                                <n-button
                                    size="small"
                                    tertiary
                                    type="error"
                                    :disabled="draft.srvpros.length === 1"
                                    @click="removeSrvpro(index)"
                                >
                                    删除实例
                                </n-button>
                            </div>
                            <n-form label-placement="top" :show-feedback="false">
                                <div class="settings-grid">
                                    <n-form-item label="实例名称">
                                        <n-input v-model:value="srvpro.name" placeholder="例如 本机、NAS-2" />
                                    </n-form-item>
                                    <n-form-item label="服务地址">
                                        <n-input v-model:value="srvpro.host" placeholder="srvpro.lan 或 192.168.1.20" />
                                    </n-form-item>
                                    <n-form-item label="对战端口">
                                        <n-input-number v-model:value="srvpro.duelPort" :min="1" :max="65535" />
                                    </n-form-item>
                                    <n-form-item label="管理端口">
                                        <n-input-number v-model:value="srvpro.statusPort" :min="1" :max="65535" />
                                    </n-form-item>
                                    <n-form-item label="管理账号">
                                        <n-input v-model:value="srvpro.username" />
                                    </n-form-item>
                                    <n-form-item label="管理密码">
                                        <n-input
                                            v-model:value="srvpro.password"
                                            type="password"
                                            show-password-on="click"
                                            :placeholder="record.secretStatus.srvpros[srvpro.id]?.passwordConfigured ? '留空则保留当前密码' : '尚未配置'"
                                        />
                                    </n-form-item>
                                    <n-form-item label="最大房间数">
                                        <n-input-number v-model:value="srvpro.maxRooms" :min="1" />
                                    </n-form-item>
                                    <n-form-item label="每秒创建房间数">
                                        <n-input-number
                                            v-model:value="srvpro.roomsPerSecond"
                                            :min="1"
                                            :max="100"
                                        />
                                    </n-form-item>
                                </div>
                            </n-form>
                        </section>
                        <n-button dashed block @click="addSrvpro">添加 SRVPro 实例</n-button>
                    </div>
                </n-tab-pane>

                <n-tab-pane name="windbots" tab="WindBot">
                    <n-alert type="info" :bordered="false">
                        大部分任务默认使用新版 WindBot；旧版 WindBot 为可选配置。
                    </n-alert>
                    <div class="windbot-settings">
                        <section v-for="name in ['current', 'old']" :key="name" class="windbot-instance">
                            <div class="instance-heading">
                                <div>
                                    <span>{{ name === 'current' ? 'CURRENT' : 'BASELINE' }}</span>
                                    <h3>{{ windbotLabels[name] }}</h3>
                                </div>
                                <n-radio-group v-model:value="draft.windbots[name].mode" size="small">
                                    <n-radio-button value="local">本地拉起</n-radio-button>
                                    <n-radio-button value="remote">远程服务</n-radio-button>
                                </n-radio-group>
                            </div>

                            <n-form label-placement="top" :show-feedback="false">
                                <div class="settings-grid">
                                    <template v-if="draft.windbots[name].mode === 'local'">
                                        <n-form-item label="WindBot 运行目录" class="span-2">
                                            <n-input
                                                v-model:value="draft.windbots[name].runtimeDir"
                                                placeholder="包含 WindBot.exe、Decks 和 Dialogs 的目录"
                                            />
                                        </n-form-item>
                                        <n-form-item label="bot.conf 路径" class="span-2">
                                            <n-input v-model:value="draft.windbots[name].botConfPath" />
                                        </n-form-item>
                                    </template>
                                    <template v-else>
                                        <n-form-item label="远程服务地址" class="span-2">
                                            <n-input
                                                v-model:value="draft.windbots[name].host"
                                                placeholder="远程 WindBot 主机名或 IP"
                                            />
                                        </n-form-item>
                                        <n-form-item label="远程 bot.conf URL（可选）" class="span-2">
                                            <n-input
                                                v-model:value="draft.windbots[name].botConfUrl"
                                                placeholder="例如 https://windbot.example.com/bot.conf"
                                            />
                                        </n-form-item>
                                        <n-form-item label="远程 bot.conf 内容（手动或 URL 缓存）" class="span-2">
                                            <n-input
                                                v-model:value="draft.windbots[name].botConfText"
                                                type="textarea"
                                                :autosize="{ minRows: 8, maxRows: 16 }"
                                                placeholder="可直接粘贴；填写 URL 时，保存配置会自动获取并覆盖这里的内容"
                                            />
                                        </n-form-item>
                                    </template>
                                    <n-form-item label="HTTP 服务端口">
                                        <n-input-number v-model:value="draft.windbots[name].port" :min="1" :max="65535" />
                                    </n-form-item>
                                </div>
                            </n-form>

                            <n-alert
                                v-if="draft.windbots[name].mode === 'remote'"
                                type="warning"
                                :bordered="false"
                            >
                                测试前需在远端手动启动 ServerMode。填写 bot.conf URL 后，保存配置会立即获取一次，主界面的刷新按钮可再次拉取。
                            </n-alert>
                        </section>
                    </div>
                </n-tab-pane>

            </n-tabs>

            <template #action>
                <div class="settings-footer">
                    <div v-if="disabled" class="settings-footer-alerts">
                        <n-alert v-if="disabled" type="warning" :bordered="false">
                            当前测试结束后才能保存系统配置。
                        </n-alert>
                    </div>
                    <div class="settings-actions">
                        <n-button ref="cancelButton" @click="close">取消</n-button>
                        <n-button type="primary" :disabled="disabled" :loading="saving" @click="save">保存配置</n-button>
                    </div>
                </div>
            </template>
        </n-card>
    </n-modal>
</template>

<style scoped>
.settings-card {
    width: min(920px, calc(100vw - 32px));
    height: calc(100vh - 48px);
    height: calc(100dvh - 48px);
    overflow: hidden;
}

.settings-tabs {
    flex: 1;
    min-height: 0;
}

.settings-tabs :deep(.n-tabs-nav) {
    flex-shrink: 0;
    position: relative;
    margin-inline: var(--n-padding-left);
}

.settings-tabs :deep(.n-tabs-nav::before),
.settings-tabs :deep(.n-tabs-nav::after) {
    content: '';
    position: absolute;
    bottom: 0;
    width: var(--n-padding-left);
    height: 1px;
    background: var(--n-tab-border-color);
    pointer-events: none;
}

.settings-tabs :deep(.n-tabs-nav::before) {
    right: 100%;
}

.settings-tabs :deep(.n-tabs-nav::after) {
    left: 100%;
}

.settings-card :deep(.n-alert) {
    margin-bottom: 22px;
}

.settings-card :deep(.n-form-item) {
    margin-bottom: 12px;
}

.settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 18px;
}

.span-2 {
    grid-column: span 2;
}

.windbot-settings {
    display: grid;
    gap: 18px;
}

.windbot-instance,
.srvpro-instance {
    padding: 20px;
    border: 1px solid #1d333c;
    border-radius: 12px;
    background: #0a171d;
}

.srvpro-settings {
    display: grid;
    gap: 18px;
}

.instance-heading {
    display: flex;
    gap: 20px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
}

.instance-heading span {
    color: #52717b;
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.12em;
}

.instance-heading h3 {
    margin: 3px 0 0;
    color: #dce8eb;
    font-size: 14px;
}

.notification-test-row {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
}

.notification-test-row :deep(.n-button) {
    flex-shrink: 0;
}

.settings-card .notification-test-row :deep(.n-alert) {
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
}

.notification-test-row :deep(.n-alert-body),
.settings-footer-alerts :deep(.n-alert-body) {
    padding-top: 6px;
    padding-bottom: 6px;
    line-height: 22px;
}

.notification-test-row :deep(.n-alert__icon),
.settings-footer-alerts :deep(.n-alert__icon) {
    top: 50%;
    margin-top: 0;
    transform: translateY(-50%);
}

.settings-footer {
    display: flex;
    align-items: center;
    gap: 16px;
}

.settings-footer-alerts {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.settings-card .settings-footer-alerts :deep(.n-alert) {
    margin-bottom: 0;
}

.settings-actions {
    display: flex;
    flex-shrink: 0;
    margin-left: auto;
    gap: 10px;
    justify-content: flex-end;
}

@media (max-width: 640px) {
    .settings-footer {
        flex-direction: column;
        align-items: stretch;
    }

    .instance-heading span {
        font-size: 12px;
    }

    .settings-grid {
        grid-template-columns: 1fr;
    }

    .span-2 {
        grid-column: auto;
    }

    .instance-heading {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>
