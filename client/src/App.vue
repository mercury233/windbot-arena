<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    NAlert,
    NButton,
    NCheckbox,
    NEmpty,
    NInputNumber,
    NPopconfirm,
    NProgress,
    NSpin,
    NSwitch,
    NTag,
    useMessage,
} from 'naive-ui';

const SettingsModal = defineAsyncComponent(() => import('./SettingsModal.vue'));

defineProps({
    darkMode: { type: Boolean, default: true },
});
const emit = defineEmits(['update:darkMode']);

const message = useMessage();
let storedRecentDecks = [];
try {
    const value = JSON.parse(localStorage.getItem('windbot-arena-recent-decks') || '[]');
    if (Array.isArray(value)) {
        storedRecentDecks = [...new Set(value.filter((deck) => typeof deck === 'string'))];
    }
} catch {
    storedRecentDecks = [];
}
const system = ref(null);
const runs = ref([]);
const activeRun = ref(null);
const selectedRun = ref(null);
const recentDecks = ref(storedRecentDecks);
const selectedDecks = ref([...storedRecentDecks]);
const allDecks = ref(false);
const deckListExpanded = ref(true);
const gamesPerMatchup = ref(500);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const liveConnected = ref(false);
const settingsOpen = ref(false);
const settingsRecord = ref(null);
const savingSettings = ref(false);
const clockNow = ref(Date.now());
let eventSource;
let clockTimer;
let pollingTimer;
let refreshTimer;
let refreshing;
let refreshQueued = false;
let recentDecksValidated = false;

const terminalStatuses = new Set(['completed', 'stopped', 'failed', 'interrupted']);
const statusLabels = {
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    preparing: '准备环境',
    queued: '排队中',
    running: '创建对局',
    settling: '等待统计',
    stopped: '已停止',
    stopping: '停止中',
};
const statusTypes = {
    completed: 'success',
    failed: 'error',
    interrupted: 'warning',
    preparing: 'info',
    queued: 'default',
    running: 'success',
    settling: 'warning',
    stopped: 'default',
    stopping: 'warning',
};

const catalogDeckOptions = computed(() => (system.value?.configuration.decks || []).map((item) => ({
    aiLevel: item.aiLevel,
    currentLabel: item.currentLabel,
    value: item.deck,
})));
const recentDeckSet = computed(() => new Set(recentDecks.value));
const deckOptions = computed(() => {
    const recentOrder = new Map(recentDecks.value.map((deck, index) => [deck, index]));
    return [...catalogDeckOptions.value].sort((left, right) => {
        const leftIsRecent = recentOrder.has(left.value);
        const rightIsRecent = recentOrder.has(right.value);
        if (leftIsRecent && rightIsRecent) {
            return recentOrder.get(left.value) - recentOrder.get(right.value);
        }
        if (leftIsRecent !== rightIsRecent) {
            return leftIsRecent ? -1 : 1;
        }
        return 0;
    });
});
const bulkDeckCount = computed(() => deckOptions.value.filter((item) => item.aiLevel !== 1).length);
const displayedRun = computed(() => activeRun.value || selectedRun.value);
const configurationReady = computed(() => system.value?.configuration.valid === true);
const canStart = computed(() => (
    configurationReady.value
    && !activeRun.value
    && (allDecks.value ? bulkDeckCount.value > 0 : selectedDecks.value.length > 0)
));
const progress = computed(() => {
    const run = displayedRun.value;
    if (!run || run.totalGames === 0) {
        return 0;
    }
    const launchedGames = Math.min(run.launchedGames || 0, run.totalGames);
    const observedGames = Math.min(run.observedGames || 0, run.totalGames);
    return Math.min(100, Math.round(
        ((launchedGames + observedGames) / (run.totalGames * 2)) * 100,
    ));
});
const totals = computed(() => {
    const result = [
        { flee: 0, games: 0, lose: 0, win: 0 },
        { flee: 0, games: 0, lose: 0, win: 0 },
    ];
    for (const matchup of displayedRun.value?.matchups || []) {
        matchup.competitors.forEach((competitor, index) => {
            result[index].win += competitor.win;
            result[index].lose += competitor.lose;
            result[index].flee += competitor.flee;
            result[index].games += competitor.games;
        });
    }
    return result;
});
const currentWinRate = computed(() => {
    const decided = totals.value[0].win + totals.value[1].win;
    return decided === 0 ? 0 : totals.value[0].win / decided;
});
const elapsedMilliseconds = computed(() => {
    const run = displayedRun.value;
    const startedAt = Date.parse(run?.startedAt || run?.createdAt);
    if (!Number.isFinite(startedAt)) {
        return null;
    }
    const finishedAt = terminalStatuses.has(run.status) ? Date.parse(run.finishedAt) : clockNow.value;
    const end = Number.isFinite(finishedAt) ? finishedAt : clockNow.value;
    return Math.max(0, end - startedAt);
});
const estimatedCompletionAt = computed(() => {
    const run = displayedRun.value;
    if (!run) {
        return null;
    }
    if (terminalStatuses.has(run.status)) {
        return run.finishedAt || null;
    }
    const startedAt = Date.parse(run.startedAt || run.createdAt);
    const observedGames = Math.min(run.observedGames || 0, run.totalGames || 0);
    if (!Number.isFinite(startedAt) || observedGames === 0 || run.totalGames === 0) {
        return null;
    }
    const estimatedDuration = Math.max(0, clockNow.value - startedAt) * (run.totalGames / observedGames);
    return new Date(startedAt + estimatedDuration).toISOString();
});

function formatWindBotEndpoint(windbot) {
    if (!windbot) {
        return '—';
    }
    return `${windbot.mode === 'local' ? '本地' : '远程'} ${windbot.host}:${windbot.port}`;
}

async function api(path, options) {
    const response = await fetch(path, {
        cache: 'no-store',
        headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.error || `请求失败: HTTP ${response.status}`);
    }
    return body;
}

async function refresh() {
    if (refreshing) {
        refreshQueued = true;
        return refreshing;
    }
    refreshing = (async () => {
        const [systemBody, runsBody, activeBody] = await Promise.all([
            api('/api/system'),
            api('/api/runs?limit=40'),
            api('/api/runs/active'),
        ]);
        system.value = systemBody;
        runs.value = runsBody.runs;
        activeRun.value = activeBody.run;
        if (activeBody.run) {
            selectedRun.value = activeBody.run;
        } else if (selectedRun.value) {
            const latest = await api(`/api/runs/${selectedRun.value.id}`).catch(() => null);
            selectedRun.value = latest?.run || null;
        } else if (runs.value.length > 0) {
            selectedRun.value = (await api(`/api/runs/${runs.value[0].id}`)).run;
        }
    })().finally(() => {
        refreshing = null;
        loading.value = false;
        if (refreshQueued) {
            refreshQueued = false;
            scheduleRefresh();
        }
    });
    return refreshing;
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch((error) => message.error(error.message)), 150);
}

async function selectRun(runId) {
    try {
        selectedRun.value = (await api(`/api/runs/${runId}`)).run;
    } catch (error) {
        message.error(error.message);
    }
}

async function openSettings() {
    try {
        settingsRecord.value = await api('/api/settings');
        settingsOpen.value = true;
    } catch (error) {
        message.error(error.message);
    }
}

async function saveSettings(settings) {
    savingSettings.value = true;
    try {
        settingsRecord.value = await api('/api/settings', {
            body: JSON.stringify(settings),
            method: 'PUT',
        });
        settingsOpen.value = false;
        message.success('系统配置已保存');
        await refresh();
    } catch (error) {
        message.error(error.message);
    } finally {
        savingSettings.value = false;
    }
}

async function startRun() {
    starting.value = true;
    try {
        const requestedDecks = allDecks.value ? [] : [...selectedDecks.value];
        const body = await api('/api/runs', {
            body: JSON.stringify({
                decks: requestedDecks,
                gamesPerMatchup: gamesPerMatchup.value,
            }),
            method: 'POST',
        });
        if (requestedDecks.length > 0) {
            const selected = new Set(requestedDecks);
            recentDecks.value = catalogDeckOptions.value
                .filter((option) => selected.has(option.value))
                .map((option) => option.value);
            try {
                localStorage.setItem('windbot-arena-recent-decks', JSON.stringify(recentDecks.value));
            } catch {
                // 最近选择仍会保留到当前页面关闭。
            }
        }
        activeRun.value = body.run;
        selectedRun.value = body.run;
        message.success('回归测试已创建');
        await refresh();
    } catch (error) {
        message.error(error.message);
    } finally {
        starting.value = false;
    }
}

async function stopRun() {
    if (!activeRun.value) {
        return;
    }
    stopping.value = true;
    try {
        await api(`/api/runs/${activeRun.value.id}/stop`, { method: 'POST' });
        message.info('正在安全停止测试');
        await refresh();
    } catch (error) {
        message.error(error.message);
    } finally {
        stopping.value = false;
    }
}

function formatPercent(value) {
    return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatDate(value, timeOnly = false) {
    if (!value) {
        return '—';
    }
    return new Intl.DateTimeFormat('zh-CN', timeOnly ? {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    } : {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value));
}

function formatDuration(value) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const totalSeconds = Math.floor(value / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) {
        return `${days}天 ${hours}小时`;
    }
    if (hours > 0) {
        return `${hours}小时 ${minutes}分`;
    }
    if (minutes > 0) {
        return `${minutes}分 ${seconds}秒`;
    }
    return `${seconds}秒`;
}

function handleAllDecksChange(checked) {
    deckListExpanded.value = !checked;
}

function handleDeckSelection(deck, checked) {
    selectedDecks.value = checked
        ? [...new Set([...selectedDecks.value, deck])]
        : selectedDecks.value.filter((item) => item !== deck);
}

function refreshWhenVisible() {
    if (document.visibilityState === 'visible') {
        scheduleRefresh();
    }
}

watch(activeRun, (run, previous) => {
    if (run && !previous) {
        deckListExpanded.value = false;
    }
});

watch(catalogDeckOptions, (options) => {
    if (!system.value?.configuration?.valid || recentDecksValidated) {
        return;
    }
    const available = new Set(options.map((option) => option.value));
    recentDecks.value = recentDecks.value.filter((deck) => available.has(deck));
    selectedDecks.value = [...recentDecks.value];
    recentDecksValidated = true;
});

onMounted(async () => {
    try {
        await refresh();
    } catch (error) {
        message.error(error.message);
        loading.value = false;
    }
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('ready', () => {
        liveConnected.value = true;
        scheduleRefresh();
    });
    eventSource.addEventListener('change', scheduleRefresh);
    eventSource.onerror = () => {
        liveConnected.value = false;
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', scheduleRefresh);
    clockTimer = setInterval(() => { clockNow.value = Date.now(); }, 1000);
    pollingTimer = setInterval(scheduleRefresh, 5000);
});

onBeforeUnmount(() => {
    clearInterval(clockTimer);
    clearInterval(pollingTimer);
    clearTimeout(refreshTimer);
    eventSource?.close();
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    window.removeEventListener('focus', scheduleRefresh);
});
</script>

<template>
    <div class="app-shell">
        <header class="topbar">
            <a class="brand" href="#">
                <span class="brand-mark"><img src="/arena.ico" alt=""></span>
                <span>
                    <strong>WindBot Arena</strong>
                    <small>DUEL EXPERIMENT CONSOLE</small>
                </span>
            </a>
            <div class="topbar-actions">
                <label class="theme-control">
                    <span>暗黑模式</span>
                    <n-switch
                        :value="darkMode"
                        size="small"
                        aria-label="切换暗黑模式"
                        @update:value="emit('update:darkMode', $event)"
                    />
                </label>
                <n-button size="small" quaternary @click="openSettings">系统配置</n-button>
            </div>
        </header>

        <main>
            <section class="hero">
                <div class="hero-copy">
                    <span class="eyebrow">REGRESSION LAB / 01</span>
                    <h1>让每一次 AI 变更<br><em>都有数据可循</em></h1>
                    <p>在同一环境中批量对战新旧 WindBot，实时观察卡组表现，并将每次实验完整留档。</p>
                </div>
                <div class="system-readout">
                    <div>
                        <span>SRVPRO</span>
                        <strong>{{ system ? `${system.srvpro.host}:${system.srvpro.duelPort}` : '—' }}</strong>
                    </div>
                    <div>
                        <span>CURRENT WINDBOT</span>
                        <strong>{{ formatWindBotEndpoint(system?.windbots.current) }}</strong>
                    </div>
                    <div>
                        <span>BASELINE WINDBOT</span>
                        <strong>{{ formatWindBotEndpoint(system?.windbots.old) }}</strong>
                    </div>
                </div>
            </section>

            <n-spin :show="loading">
                <section class="workspace">
                    <div class="main-column">
                        <n-alert
                            v-if="system && !configurationReady"
                            title="运行配置尚未就绪"
                            type="error"
                            :bordered="false"
                        >
                            <ul class="issue-list">
                                <li v-for="issue in system.configuration.issues" :key="issue">{{ issue }}</li>
                            </ul>
                            <template #action>
                                <n-button size="small" type="error" ghost @click="openSettings">打开配置</n-button>
                            </template>
                        </n-alert>

                        <article class="panel launch-panel">
                            <div class="panel-heading">
                                <div>
                                    <span class="section-index">01</span>
                                    <div>
                                        <h2>新旧对战回归</h2>
                                        <p>新版与旧版使用同一卡组，两边轮换先后加入房间。</p>
                                    </div>
                                </div>
                                <span class="panel-status">
                                    <n-tag v-if="activeRun" :type="statusTypes[activeRun.status]" round>
                                        {{ statusLabels[activeRun.status] || activeRun.status }}
                                    </n-tag>
                                    <n-tag v-else round :bordered="false">可创建</n-tag>
                                </span>
                            </div>

                            <div class="launch-form">
                                <div class="field field-wide deck-picker">
                                    <span>测试卡组</span>
                                    <div class="deck-list-box">
                                        <button
                                            type="button"
                                            class="deck-list-toggle"
                                            :aria-expanded="deckListExpanded"
                                            aria-controls="deck-options"
                                            @click="deckListExpanded = !deckListExpanded"
                                        >
                                            <span>
                                                {{ allDecks
                                                    ? `全部共同卡组（不含 AI_LV1，共 ${bulkDeckCount} 个）`
                                                    : selectedDecks.length
                                                        ? `已选择 ${selectedDecks.length} / ${deckOptions.length}`
                                                        : `请选择卡组（共 ${deckOptions.length} 个）` }}
                                            </span>
                                            <small>{{ deckListExpanded ? '收起' : '展开' }}</small>
                                        </button>
                                        <div v-show="deckListExpanded" id="deck-options" class="deck-options">
                                            <n-checkbox
                                                v-for="option in deckOptions"
                                                :key="option.value"
                                                class="deck-option"
                                                :checked="allDecks
                                                    ? option.aiLevel !== 1
                                                    : selectedDecks.includes(option.value)"
                                                :disabled="allDecks || !!activeRun"
                                                @update:checked="handleDeckSelection(option.value, $event)"
                                            >
                                                <span class="deck-option-main">
                                                    <strong>{{ option.value }}</strong>
                                                    <small>{{ option.currentLabel }}</small>
                                                </span>
                                                <span class="deck-option-tags">
                                                    <span v-if="recentDeckSet.has(option.value)" class="recent-deck">最近</span>
                                                    <span v-if="option.aiLevel" class="ai-level">AI_LV{{ option.aiLevel }}</span>
                                                </span>
                                            </n-checkbox>
                                            <span v-if="deckOptions.length === 0" class="deck-options-empty">
                                                没有可用的共同卡组
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div class="all-decks-control">
                                    <n-checkbox
                                        v-model:checked="allDecks"
                                        :disabled="!!activeRun"
                                        @update:checked="handleAllDecksChange"
                                    >
                                        全部共同卡组
                                    </n-checkbox>
                                </div>
                                <div class="launch-actions">
                                    <label class="field games-field">
                                        <span>每组局数</span>
                                        <n-input-number
                                            v-model:value="gamesPerMatchup"
                                            :disabled="!!activeRun"
                                            :min="1"
                                            :max="10000"
                                            :step="50"
                                        />
                                    </label>
                                    <n-button
                                        v-if="!activeRun"
                                        type="primary"
                                        :disabled="!canStart"
                                        :loading="starting"
                                        @click="startRun"
                                    >
                                        启动回归测试
                                    </n-button>
                                    <n-popconfirm v-else @positive-click="stopRun">
                                        <template #trigger>
                                            <n-button type="error" ghost :loading="stopping">停止测试</n-button>
                                        </template>
                                        已创建的对局不会撤销，现有统计会保留。确认停止？
                                    </n-popconfirm>
                                </div>
                            </div>
                        </article>

                        <article v-if="displayedRun" class="panel results-panel">
                            <div class="results-header">
                                <div>
                                    <span class="section-index">02</span>
                                    <div>
                                        <div class="results-title-line">
                                            <h2>实验结果</h2>
                                            <n-tag size="small" :type="statusTypes[displayedRun.status]">
                                                {{ statusLabels[displayedRun.status] || displayedRun.status }}
                                            </n-tag>
                                        </div>
                                        <p>{{ displayedRun.matchups.length }} 个对局组 · 创建于 {{ formatDate(displayedRun.createdAt) }}</p>
                                    </div>
                                </div>
                                <code>{{ displayedRun.id.slice(0, 8).toUpperCase() }}</code>
                            </div>

                            <div class="metric-grid">
                                <div class="metric primary-metric">
                                    <span>任务进度</span>
                                    <strong>{{ progress }}<small>%</small></strong>
                                    <n-progress
                                        type="line"
                                        :percentage="progress"
                                        :height="5"
                                        :show-indicator="false"
                                        :border-radius="0"
                                    />
                                </div>
                                <div class="metric">
                                    <span>已创建 / 计划</span>
                                    <strong>{{ displayedRun.launchedGames }}<small> / {{ displayedRun.totalGames }}</small></strong>
                                </div>
                                <div class="metric">
                                    <span>新版总胜率</span>
                                    <strong>{{ formatPercent(currentWinRate) }}</strong>
                                </div>
                                <div class="metric">
                                    <span>已用时间</span>
                                    <strong class="time-value">{{ formatDuration(elapsedMilliseconds) }}</strong>
                                </div>
                                <div class="metric">
                                    <span>{{ terminalStatuses.has(displayedRun.status) ? '完成时间' : '预计完成时间' }}</span>
                                    <strong class="time-value">
                                        {{ estimatedCompletionAt ? formatDate(estimatedCompletionAt) : '估算中' }}
                                    </strong>
                                </div>
                            </div>

                            <div class="table-wrap">
                                <table class="result-table">
                                    <thead>
                                        <tr>
                                            <th>卡组</th>
                                            <th>统计进度</th>
                                            <th>胜/负/逃</th>
                                            <th>新版胜率</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="matchup in displayedRun.matchups" :key="matchup.id">
                                            <td>
                                                <strong>{{ matchup.label }}</strong>
                                                <small>
                                                    <span v-if="matchup.aiLevel">AI_LV{{ matchup.aiLevel }} · </span>
                                                    {{ matchup.competitors[0]?.botLabel }}
                                                </small>
                                            </td>
                                            <td>
                                                <span class="progress-number">
                                                    {{ matchup.observedGames }} / {{ matchup.targetGames }}
                                                </span>
                                            </td>
                                            <td class="score current-score">
                                                {{ matchup.competitors[0]?.win || 0 }} /
                                                {{ matchup.competitors[0]?.lose || 0 }} /
                                                {{ matchup.competitors[0]?.flee || 0 }}
                                            </td>
                                            <td
                                                class="deck-win-rate"
                                                :class="{
                                                    'is-significant-win': matchup.observedGames > 100
                                                        && matchup.currentWinRate > 0.55,
                                                    'is-significant-loss': matchup.observedGames > 100
                                                        && matchup.currentWinRate < 0.45,
                                                }"
                                            >
                                                {{ formatPercent(matchup.currentWinRate) }}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </article>

                        <article v-else class="panel empty-panel">
                            <n-empty description="还没有测试记录，配置上方参数后启动第一次回归测试" />
                        </article>
                    </div>

                    <aside class="side-column">
                        <article class="panel history-panel">
                            <div class="aside-heading">
                                <div>
                                    <span class="section-index">03</span>
                                    <h2>运行历史</h2>
                                </div>
                                <span>{{ runs.length }}</span>
                            </div>
                            <div v-if="runs.length" class="history-list">
                                <button
                                    v-for="run in runs"
                                    :key="run.id"
                                    class="history-item"
                                    :class="{ active: displayedRun?.id === run.id }"
                                    @click="selectRun(run.id)"
                                >
                                    <span class="history-status" :class="`status-${run.status}`"></span>
                                    <span class="history-main">
                                        <strong>{{ run.matchupCount }} 个卡组 · {{ run.gamesPerMatchup }} 局</strong>
                                        <small>{{ formatDate(run.createdAt) }} · {{ statusLabels[run.status] }}</small>
                                    </span>
                                    <code>{{ run.id.slice(0, 8).toUpperCase() }}</code>
                                </button>
                            </div>
                            <n-empty v-else size="small" description="暂无历史记录" />
                        </article>

                        <article v-if="displayedRun" class="panel event-panel">
                            <div class="aside-heading">
                                <div>
                                    <span class="section-index">04</span>
                                    <h2>任务事件</h2>
                                </div>
                            </div>
                            <ol class="event-list">
                                <li v-for="event in [...displayedRun.events].reverse().slice(0, 8)" :key="event.id">
                                    <time>{{ formatDate(event.at, true) }}</time>
                                    <span :class="`event-${event.level}`">{{ event.message }}</span>
                                </li>
                            </ol>
                        </article>

                        <article class="future-panel">
                            <span>EXTENSIBLE CORE</span>
                            <strong>下一类实验，无需重做底层</strong>
                            <p>对局组与参赛方已独立建模，可继续扩展新卡组挑战和多卡组胜率排名。</p>
                        </article>
                    </aside>
                </section>
            </n-spin>
        </main>

        <footer>
            <span>WINDBOT ARENA / SELF-HOSTED CONTROL PLANE</span>
            <div class="footer-status">
                <span>最近收到数据：{{ formatDate(system?.latestRankAt, true) }}</span>
                <div class="live-state" :class="{ connected: liveConnected }" role="status">
                    <span class="live-dot"></span>
                    {{ liveConnected ? '实时数据已连接' : '正在重新连接' }}
                </div>
            </div>
        </footer>

        <settings-modal
            v-model:show="settingsOpen"
            :disabled="!!activeRun"
            :record="settingsRecord"
            :saving="savingSettings"
            @save="saveSettings"
        />
    </div>
</template>
