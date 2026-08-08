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
    NSwitch,
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
        draft.value.development ||= {
            rankForwardEnabled: false,
            rankForwardUrl: '',
        };
    }
}, { immediate: true });

function close() {
    emit('update:show', false);
}

function save() {
    emit('save', cloneSettings(draft.value));
}
</script>

<template>
    <n-modal
        v-if="draft"
        :show="show"
        :mask-closable="false"
        @update:show="emit('update:show', $event)"
    >
        <n-card
            class="settings-card"
            title="Arena 系统配置"
            :bordered="false"
            role="dialog"
            aria-modal="true"
        >
            <n-tabs type="line" animated>
                <n-tab-pane name="srvpro" tab="SRVPro">
                    <n-alert type="info" :bordered="false">
                        该 SRVPro 应仅供 Arena 使用。每次测试都会主动重启它并清理现有房间。
                    </n-alert>
                    <n-form label-placement="top" class="settings-form">
                        <div class="settings-grid">
                            <n-form-item label="服务地址" class="span-2">
                                <n-input v-model:value="draft.srvpro.host" placeholder="例如 srvpro.lan 或 192.168.1.20" />
                            </n-form-item>
                            <n-form-item label="对战端口">
                                <n-input-number v-model:value="draft.srvpro.duelPort" :min="1" :max="65535" />
                            </n-form-item>
                            <n-form-item label="管理端口">
                                <n-input-number v-model:value="draft.srvpro.statusPort" :min="1" :max="65535" />
                            </n-form-item>
                            <n-form-item label="管理账号">
                                <n-input v-model:value="draft.srvpro.username" />
                            </n-form-item>
                            <n-form-item label="管理密码">
                                <n-input
                                    v-model:value="draft.srvpro.password"
                                    type="password"
                                    show-password-on="click"
                                    :placeholder="record.secretStatus.passwordConfigured ? '留空则保留当前密码' : '尚未配置'"
                                />
                            </n-form-item>
                            <n-form-item label="排行接收路径">
                                <n-input
                                    v-model:value="draft.srvpro.rankPostPath"
                                    placeholder="例如 / 或 /api/rank"
                                />
                            </n-form-item>
                            <n-form-item label="排行接收密钥">
                                <n-input
                                    v-model:value="draft.srvpro.accessKey"
                                    type="password"
                                    show-password-on="click"
                                    :placeholder="record.secretStatus.accessKeyConfigured ? '留空则保留当前密钥' : '尚未配置'"
                                />
                            </n-form-item>
                            <n-form-item label="最大房间数">
                                <n-input-number v-model:value="draft.srvpro.maxRooms" :min="1" />
                            </n-form-item>
                            <n-form-item label="排行榜名称上限">
                                <n-input-number v-model:value="draft.srvpro.maxRankNames" :min="2" />
                            </n-form-item>
                        </div>
                    </n-form>
                </n-tab-pane>

                <n-tab-pane name="windbots" tab="WindBot">
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

                            <n-form label-placement="top">
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

                <n-tab-pane name="scheduler" tab="调度">
                    <n-form label-placement="top" class="settings-form">
                        <div class="settings-grid">
                            <n-form-item label="双方加入间隔（毫秒）">
                                <n-input-number v-model:value="draft.scheduler.pairDelayMs" :min="0" :max="60000" />
                            </n-form-item>
                            <n-form-item label="每轮创建对局数">
                                <n-input-number v-model:value="draft.scheduler.pairsPerTick" :min="1" :max="100" />
                            </n-form-item>
                            <n-form-item label="调度轮询间隔（毫秒）">
                                <n-input-number v-model:value="draft.scheduler.pollMs" :min="100" :max="60000" />
                            </n-form-item>
                            <n-form-item label="统计等待时间（分钟）">
                                <n-input-number v-model:value="draft.scheduler.settleMinutes" :min="1" :max="1440" />
                            </n-form-item>
                        </div>
                    </n-form>
                </n-tab-pane>

                <n-tab-pane name="development" tab="开发">
                    <n-alert type="warning" :bordered="false">
                        此功能仅用于开发调试。如果本 Arena 运行在与开发机不同的机器，收到 SRVPro 排行时可转发到开发机。
                    </n-alert>
                    <n-form label-placement="top" class="settings-form">
                        <div class="settings-grid">
                            <n-form-item label="转发 SRVPro 排行 POST">
                                <n-switch v-model:value="draft.development.rankForwardEnabled">
                                    <template #checked>已开启</template>
                                    <template #unchecked>已关闭</template>
                                </n-switch>
                            </n-form-item>
                            <n-form-item label="开发机排行接收 URL" class="span-2">
                                <n-input
                                    v-model:value="draft.development.rankForwardUrl"
                                    :disabled="!draft.development.rankForwardEnabled"
                                    placeholder="例如 http://192.168.1.20:3000/srvpro/score"
                                />
                            </n-form-item>
                        </div>
                    </n-form>
                    <n-alert type="info" :bordered="false">
                        转发使用当前生产 Arena 的排行接收密钥，开发机 Arena 需配置相同密钥。Arena 转发的请求不会被再次转发。
                    </n-alert>
                </n-tab-pane>
            </n-tabs>

            <n-alert v-if="disabled" type="warning" :bordered="false">
                当前测试结束后才能保存系统配置。
            </n-alert>

            <template #footer>
                <div class="settings-actions">
                    <n-button @click="close">取消</n-button>
                    <n-button type="primary" :disabled="disabled" :loading="saving" @click="save">保存配置</n-button>
                </div>
            </template>
        </n-card>
    </n-modal>
</template>

<style scoped>
.settings-card {
    width: min(920px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
}

.settings-form,
.windbot-settings {
    margin-top: 22px;
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

.windbot-instance {
    padding: 20px;
    border: 1px solid #1d333c;
    border-radius: 12px;
    background: #0a171d;
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
    font-size: 9px;
    letter-spacing: 0.12em;
}

.instance-heading h3 {
    margin: 3px 0 0;
    color: #dce8eb;
    font-size: 14px;
}

.settings-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}

@media (max-width: 640px) {
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
