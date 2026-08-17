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
                        每个实例都应仅供 Arena 使用。任务会独占并重启所选实例；不同实例上的任务可以同时运行。
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
                            <n-form label-placement="top">
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

            </n-tabs>

            <n-alert
                v-if="disabled"
                class="settings-disabled-alert"
                type="warning"
                :bordered="false"
            >
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
.windbot-settings,
.srvpro-settings {
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

.settings-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}

.settings-disabled-alert {
    margin-top: 18px;
}

@media (max-width: 640px) {
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
