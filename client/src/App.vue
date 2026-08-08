<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    NAlert,
    NAutoComplete,
    NButton,
    NCheckbox,
    NEmpty,
    NInputNumber,
    NPopconfirm,
    NProgress,
    NRadioButton,
    NRadioGroup,
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
const historyPage = ref(1);
const historyTotal = ref(0);
const activeRun = ref(null);
const selectedRun = ref(null);
const recentDecks = ref(storedRecentDecks);
const selectedDecks = ref([...storedRecentDecks]);
const allDecks = ref(false);
const experimentKind = ref('regression');
const targetDeck = ref('');
const deckListExpanded = ref(true);
const gamesPerMatchup = ref(500);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const refreshingDecks = ref(false);
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
const historyPageSize = 10;

const terminalStatuses = new Set(['completed', 'stopped', 'failed', 'interrupted']);
const statusLabels = {
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    preparing: '准备环境',
    queued: '排队中',
    running: '正在对局',
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
const runKindLabels = {
    challenge: '卡组挑战',
    ranking: '胜率排行',
    regression: '新旧回归',
};
const runKindDescriptions = {
    challenge: '指定卡组持续对战全部或选中的对手，直到手动停止。',
    ranking: '从选中卡组中每局随机抽取两个对战，直到手动停止。',
    regression: '新版与旧版使用同一卡组，按计划局数进行回归对战。',
};

const regressionDeckOptions = computed(() => (system.value?.configuration.decks || []).map((item) => ({
    aiLevel: item.aiLevel,
    currentLabel: item.currentLabel,
    value: item.deck,
})));
const currentDeckOptions = computed(() => (system.value?.configuration.currentDecks || []).map((item) => ({
    aiLevel: item.aiLevel,
    currentLabel: item.currentLabel,
    value: item.deck,
})));
const catalogDeckOptions = computed(() => (
    experimentKind.value === 'regression' ? regressionDeckOptions.value : currentDeckOptions.value
));
const targetDeckOptions = computed(() => {
    const query = String(targetDeck.value || '').trim().toLocaleLowerCase();
    return currentDeckOptions.value
        .filter((option) => (
            query === ''
            || option.value.toLocaleLowerCase().includes(query)
            || option.currentLabel.toLocaleLowerCase().includes(query)
        ))
        .map((option) => ({
            displayLabel: option.currentLabel === option.value
                ? option.value
                : `${option.value} — ${option.currentLabel}`,
            label: option.value,
            value: option.value,
        }));
});
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
const availableAiLevels = computed(() => [...new Set(
    deckOptions.value
        .map((option) => option.aiLevel)
        .filter((level) => level !== null),
)].sort((left, right) => right - left));
const effectiveSelectedDeckSet = computed(() => {
    if (!allDecks.value) {
        return new Set(selectedDecks.value);
    }
    const target = String(targetDeck.value || '').trim();
    return new Set(deckOptions.value
        .filter((option) => (
            option.aiLevel !== 1
            || (experimentKind.value === 'challenge' && option.value === target)
        ))
        .map((option) => option.value));
});
const allDeckCount = computed(() => {
    if (experimentKind.value !== 'challenge' || !String(targetDeck.value || '').trim()) {
        return bulkDeckCount.value;
    }
    const included = deckOptions.value.some((item) => (
        item.value === String(targetDeck.value || '').trim() && item.aiLevel !== 1
    ));
    return bulkDeckCount.value + (included ? 0 : 1);
});
const displayedRun = computed(() => activeRun.value || selectedRun.value);
const historyPageCount = computed(() => Math.max(1, Math.ceil(
    historyTotal.value / historyPageSize,
)));
const modeConfiguration = computed(() => (
    system.value?.configuration.modes?.[experimentKind.value]
    || { issues: system.value?.configuration.issues || [], valid: system.value?.configuration.valid === true }
));
const configurationReady = computed(() => modeConfiguration.value.valid === true);
const canStart = computed(() => {
    if (!configurationReady.value || activeRun.value) {
        return false;
    }
    const selectedCount = allDecks.value ? bulkDeckCount.value : new Set(selectedDecks.value).size;
    if (experimentKind.value === 'challenge') {
        return String(targetDeck.value || '').trim() !== '' && (allDecks.value || selectedCount > 0);
    }
    if (experimentKind.value === 'ranking') {
        return selectedCount >= 2;
    }
    return selectedCount > 0 && Number.isInteger(gamesPerMatchup.value);
});
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
const challengeRows = computed(() => {
    if (displayedRun.value?.kind !== 'challenge') {
        return [];
    }
    return [...displayedRun.value.matchups].sort((left, right) => (
        Number(right.observedGames > 0) - Number(left.observedGames > 0)
        || right.currentWinRate - left.currentWinRate
        || (right.competitors[0]?.win || 0) - (left.competitors[0]?.win || 0)
        || left.label.localeCompare(right.label)
    ));
});
const rankingRows = computed(() => {
    if (displayedRun.value?.kind !== 'ranking') {
        return [];
    }
    return [...displayedRun.value.matchups].sort((left, right) => (
        right.currentWinRate - left.currentWinRate
        || (right.competitors[0]?.win || 0) - (left.competitors[0]?.win || 0)
        || left.label.localeCompare(right.label)
    ));
});
const rankingLeader = computed(() => rankingRows.value.find((item) => item.observedGames > 0) || null);
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
    if (!run || run.kind !== 'regression') {
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
            api(`/api/runs?limit=${historyPageSize}&offset=${(historyPage.value - 1) * historyPageSize}`),
            api('/api/runs/active'),
        ]);
        system.value = systemBody;
        runs.value = runsBody.runs;
        historyTotal.value = runsBody.total;
        activeRun.value = activeBody.run;
        if (activeBody.run) {
            experimentKind.value = activeBody.run.kind;
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
        const run = (await api(`/api/runs/${runId}`)).run;
        selectedRun.value = run;
        if (activeRun.value) {
            return;
        }

        experimentKind.value = run.kind;
        await nextTick();
        allDecks.value = run.config?.selection === 'all';
        selectedDecks.value = run.matchups.map((matchup) => matchup.label);
        targetDeck.value = run.kind === 'challenge' ? run.config?.targetDeck || '' : '';
        if (run.kind === 'regression' && run.gamesPerMatchup > 0) {
            gamesPerMatchup.value = run.gamesPerMatchup;
        }
    } catch (error) {
        message.error(error.message);
    }
}

function selectHistoryPage(page) {
    historyPage.value = page;
    refresh().catch((error) => message.error(error.message));
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

async function refreshBotConfigs() {
    refreshingDecks.value = true;
    try {
        const result = await api('/api/decks/refresh', { method: 'POST' });
        const fingerprintChanged = JSON.stringify(system.value?.botConfigFingerprints || null)
            !== JSON.stringify(result.botConfigFingerprints);
        const catalogChanged = JSON.stringify(system.value?.configuration || null)
            !== JSON.stringify(result.configuration);
        message.success(`bot.conf 已刷新，内容${
            result.contentChanged || fingerprintChanged || catalogChanged ? '有变化' : '无变化'
        }`);
        await refresh();
    } catch (error) {
        message.error(error.message);
    } finally {
        refreshingDecks.value = false;
    }
}

async function startRun() {
    starting.value = true;
    try {
        const requestedDecks = allDecks.value ? [] : [...selectedDecks.value];
        const request = {
            decks: requestedDecks,
            kind: experimentKind.value,
        };
        if (experimentKind.value === 'regression') {
            request.gamesPerMatchup = gamesPerMatchup.value;
        } else if (experimentKind.value === 'challenge') {
            request.targetDeck = String(targetDeck.value || '').trim();
        }
        const body = await api('/api/runs', {
            body: JSON.stringify(request),
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
        historyPage.value = 1;
        message.success(`${runKindLabels[experimentKind.value]}已创建`);
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

async function copyResults() {
    const run = displayedRun.value;
    if (!run) {
        return;
    }

    const lines = [
        `WindBot Arena · ${runKindLabels[run.kind] || '实验结果'}`,
        `任务 ID：${run.id}`,
        `状态：${statusLabels[run.status] || run.status}`,
        `创建时间：${formatDate(run.createdAt)}`,
        `已统计对局：${run.observedGames}`,
        `已创建对局：${run.launchedGames}${run.kind === 'regression' ? ` / ${run.totalGames}` : ''}`,
    ];
    if (run.kind === 'ranking') {
        lines.push(`当前榜首：${rankingLeader.value
            ? `${rankingLeader.value.label}（${formatPercent(rankingLeader.value.currentWinRate)}）`
            : '统计中'}`);
    } else {
        if (run.kind === 'challenge') {
            lines.push(`挑战卡组：${run.config?.targetDeck || '—'}`);
        }
        lines.push(`${run.kind === 'challenge' ? '挑战卡组' : '新版'}总胜率：${formatPercent(currentWinRate.value)}`);
    }
    lines.push(`已用时间：${formatDuration(elapsedMilliseconds.value)}`, '');

    if (run.kind === 'regression') {
        lines.push('卡组\t等级 / Bot\t统计进度\t胜 / 负 / 逃\t新版胜率');
        for (const matchup of run.matchups) {
            const competitor = matchup.competitors[0];
            lines.push([
                matchup.label,
                `${matchup.aiLevel ? `LV${matchup.aiLevel} / ` : ''}${competitor?.botLabel || '—'}`,
                `${matchup.observedGames} / ${matchup.targetGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0} / ${competitor?.flee || 0}`,
                formatPercent(matchup.currentWinRate),
            ].join('\t'));
        }
    } else if (run.kind === 'challenge') {
        lines.push('对手卡组\t等级 / Bot\t已统计 / 已创建\t挑战卡组 胜 / 负\t挑战卡组胜率');
        for (const matchup of challengeRows.value) {
            const competitor = matchup.competitors[0];
            lines.push([
                matchup.label,
                `${matchup.aiLevel ? `LV${matchup.aiLevel} / ` : ''}${matchup.competitors[1]?.botLabel || '—'}`,
                `${matchup.observedGames} / ${matchup.launchedGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0}`,
                formatPercent(matchup.currentWinRate),
            ].join('\t'));
        }
    } else {
        lines.push('排名\t卡组\t等级 / Bot\t已统计 / 已创建\t胜 / 负 / 逃\t胜率');
        rankingRows.value.forEach((entry, index) => {
            const competitor = entry.competitors[0];
            lines.push([
                index + 1,
                entry.label,
                `${entry.aiLevel ? `LV${entry.aiLevel} / ` : ''}${competitor?.botLabel || '—'}`,
                `${entry.observedGames} / ${entry.launchedGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0} / ${competitor?.flee || 0}`,
                formatPercent(entry.currentWinRate),
            ].join('\t'));
        });
    }

    const text = lines.join('\n');
    try {
        let copied = false;
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch {
                copied = false;
            }
        }
        if (!copied) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) {
                throw new Error('浏览器拒绝了复制请求');
            }
        }
        message.success('实验结果已复制为文本');
    } catch (error) {
        message.error(`复制失败：${error.message}`);
    }
}

function handleDeckSelection(deck, checked) {
    selectedDecks.value = checked
        ? [...new Set([...selectedDecks.value, deck])]
        : selectedDecks.value.filter((item) => item !== deck);
}

function isAiLevelSelected(aiLevel) {
    const decks = deckOptions.value.filter((option) => option.aiLevel === aiLevel);
    return decks.length > 0 && decks.every((option) => effectiveSelectedDeckSet.value.has(option.value));
}

function isAiLevelIndeterminate(aiLevel) {
    const decks = deckOptions.value.filter((option) => option.aiLevel === aiLevel);
    const selectedCount = decks.filter(
        (option) => effectiveSelectedDeckSet.value.has(option.value),
    ).length;
    return selectedCount > 0 && selectedCount < decks.length;
}

function handleAiLevelSelection(aiLevel, checked) {
    const selected = new Set(effectiveSelectedDeckSet.value);
    for (const option of deckOptions.value) {
        if (option.aiLevel !== aiLevel) {
            continue;
        }
        if (checked) {
            selected.add(option.value);
        } else {
            selected.delete(option.value);
        }
    }
    allDecks.value = false;
    selectedDecks.value = deckOptions.value
        .filter((option) => selected.has(option.value))
        .map((option) => option.value);
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

watch(experimentKind, () => {
    allDecks.value = false;
    deckListExpanded.value = true;
    const available = new Set(catalogDeckOptions.value.map((option) => option.value));
    selectedDecks.value = selectedDecks.value.filter((deck) => available.has(deck));
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
                    <span class="eyebrow">DUEL EXPERIMENT LAB</span>
                    <h1>让每一次 AI 变更<br><em>都有数据可循</em></h1>
                    <p>运行新旧版本回归、单卡组挑战与随机胜率排行，实时观察卡组表现并完整留档。</p>
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
                                <li v-for="issue in modeConfiguration.issues" :key="issue">{{ issue }}</li>
                            </ul>
                            <template #action>
                                <n-button size="small" type="error" ghost @click="openSettings">打开配置</n-button>
                            </template>
                        </n-alert>

                        <article class="panel launch-panel">
                            <n-radio-group
                                v-model:value="experimentKind"
                                class="experiment-tabs"
                                name="experiment-kind"
                                :disabled="!!activeRun"
                            >
                                <n-radio-button value="regression">新旧回归</n-radio-button>
                                <n-radio-button value="challenge">卡组挑战</n-radio-button>
                                <n-radio-button value="ranking">胜率排行</n-radio-button>
                            </n-radio-group>
                            <div class="panel-heading">
                                <div>
                                    <span class="section-index">01</span>
                                    <div>
                                        <div class="results-title-line">
                                            <h2>{{ runKindLabels[experimentKind] }}</h2>
                                            <n-tag v-if="!activeRun" size="small">可创建</n-tag>
                                        </div>
                                        <p>{{ runKindDescriptions[experimentKind] }}</p>
                                    </div>
                                </div>
                            </div>

                            <div class="launch-form">
                                <label v-if="experimentKind === 'challenge'" class="field target-deck-field">
                                    <span>挑战卡组</span>
                                    <n-auto-complete
                                        v-model:value="targetDeck"
                                        :disabled="!!activeRun"
                                        :options="targetDeckOptions"
                                        :render-label="(option) => option.displayLabel"
                                        clearable
                                        placeholder="输入执行器名称，可不在 bot.conf 列表中"
                                    />
                                </label>
                                <div class="field field-wide deck-picker">
                                    <div class="field-heading">
                                        <span>{{ experimentKind === 'challenge' ? '对手卡组' : '测试卡组' }}</span>
                                        <n-button
                                            text
                                            type="primary"
                                            size="tiny"
                                            :disabled="!!activeRun"
                                            :loading="refreshingDecks"
                                            @click="refreshBotConfigs"
                                        >
                                            刷新 bot.conf
                                        </n-button>
                                    </div>
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
                                                    ? `全部卡组（不含 LV1，共 ${allDeckCount} 个）`
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
                                                        || (experimentKind === 'challenge'
                                                            && String(targetDeck || '').trim() === option.value)
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
                                                    <span v-if="option.aiLevel" class="ai-level">LV{{ option.aiLevel }}</span>
                                                </span>
                                            </n-checkbox>
                                            <span v-if="deckOptions.length === 0" class="deck-options-empty">
                                                没有可用卡组
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div class="deck-bulk-controls">
                                    <n-checkbox
                                        v-model:checked="allDecks"
                                        :disabled="!!activeRun"
                                    >
                                        {{ experimentKind === 'regression' ? '全部共同卡组' : '全部新版卡组' }}
                                    </n-checkbox>
                                    <span class="ai-level-controls">
                                        <n-checkbox
                                            v-for="aiLevel in availableAiLevels"
                                            :key="aiLevel"
                                            :checked="isAiLevelSelected(aiLevel)"
                                            :indeterminate="isAiLevelIndeterminate(aiLevel)"
                                            :disabled="!!activeRun"
                                            @update:checked="handleAiLevelSelection(aiLevel, $event)"
                                        >
                                            LV{{ aiLevel }}
                                        </n-checkbox>
                                    </span>
                                </div>
                                <div class="launch-actions">
                                    <label v-if="experimentKind === 'regression'" class="field games-field">
                                        <span>每卡组局数</span>
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
                                        启动{{ runKindLabels[experimentKind] }}
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
                                            <h2>结果统计</h2>
                                            <n-tag size="small" :type="statusTypes[displayedRun.status]">
                                                {{ statusLabels[displayedRun.status] || displayedRun.status }}
                                            </n-tag>
                                        </div>
                                        <p class="results-meta">
                                            {{ displayedRun.matchups.length }} 个卡组
                                            · <code>{{ displayedRun.id.slice(0, 8).toUpperCase() }}</code>
                                            · 创建于 {{ formatDate(displayedRun.createdAt) }}
                                        </p>
                                    </div>
                                </div>
                                <div class="results-actions">
                                    <n-button size="small" secondary @click="copyResults">复制文本</n-button>
                                </div>
                            </div>

                            <div class="metric-grid">
                                <div class="metric primary-metric">
                                    <span>{{ displayedRun.kind === 'regression' ? '任务进度' : '已统计对局' }}</span>
                                    <strong v-if="displayedRun.kind === 'regression'">{{ progress }}<small>%</small></strong>
                                    <strong v-else>{{ displayedRun.observedGames }}</strong>
                                    <n-progress
                                        v-if="displayedRun.kind === 'regression'"
                                        type="line"
                                        :percentage="progress"
                                        :height="5"
                                        :show-indicator="false"
                                        :border-radius="0"
                                    />
                                </div>
                                <div class="metric">
                                    <span>{{ displayedRun.kind === 'regression' ? '已创建 / 计划' : '已创建对局' }}</span>
                                    <strong>
                                        {{ displayedRun.launchedGames }}
                                        <small v-if="displayedRun.kind === 'regression'"> / {{ displayedRun.totalGames }}</small>
                                    </strong>
                                </div>
                                <div class="metric">
                                    <span v-if="displayedRun.kind === 'ranking'">当前榜首</span>
                                    <span v-else>{{ displayedRun.kind === 'challenge' ? '挑战卡组总胜率' : '新版总胜率' }}</span>
                                    <strong v-if="displayedRun.kind === 'ranking'" class="leader-value">
                                        {{ rankingLeader?.label || '统计中' }}
                                        <small v-if="rankingLeader"> {{ formatPercent(rankingLeader.currentWinRate) }}</small>
                                    </strong>
                                    <strong v-else>{{ formatPercent(currentWinRate) }}</strong>
                                </div>
                                <div class="metric">
                                    <span>已用时间</span>
                                    <strong class="time-value">{{ formatDuration(elapsedMilliseconds) }}</strong>
                                </div>
                                <div class="metric">
                                    <span>
                                        {{ terminalStatuses.has(displayedRun.status)
                                            ? '完成时间'
                                            : displayedRun.kind === 'regression' ? '预计完成时间' : '运行方式' }}
                                    </span>
                                    <strong class="time-value">
                                        {{ terminalStatuses.has(displayedRun.status)
                                            ? formatDate(displayedRun.finishedAt)
                                            : displayedRun.kind === 'regression'
                                                ? estimatedCompletionAt ? formatDate(estimatedCompletionAt) : '估算中'
                                                : '手动停止' }}
                                    </strong>
                                </div>
                            </div>

                            <div v-if="displayedRun.kind === 'regression'" class="table-wrap">
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
                                            <td class="deck-cell">
                                                <strong>{{ matchup.label }}</strong>
                                                <small>
                                                    <span v-if="matchup.aiLevel">LV{{ matchup.aiLevel }} · </span>
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
                            <div v-else-if="displayedRun.kind === 'challenge'" class="table-wrap">
                                <table class="result-table">
                                    <thead>
                                        <tr>
                                            <th>对手卡组</th>
                                            <th>已统计 / 已创建</th>
                                            <th>挑战卡组 胜/负</th>
                                            <th>挑战卡组胜率</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="matchup in challengeRows" :key="matchup.id">
                                            <td class="deck-cell">
                                                <strong>{{ matchup.label }}</strong>
                                                <small>
                                                    <span v-if="matchup.aiLevel">LV{{ matchup.aiLevel }} · </span>
                                                    {{ matchup.competitors[1]?.botLabel }}
                                                </small>
                                            </td>
                                            <td>
                                                <span class="progress-number">
                                                    {{ matchup.observedGames }} / {{ matchup.launchedGames }}
                                                </span>
                                            </td>
                                            <td class="score current-score">
                                                {{ matchup.competitors[0]?.win || 0 }} /
                                                {{ matchup.competitors[0]?.lose || 0 }}
                                            </td>
                                            <td class="deck-win-rate">
                                                {{ formatPercent(matchup.currentWinRate) }}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <div v-else class="table-wrap">
                                <table class="result-table ranking-table">
                                    <thead>
                                        <tr>
                                            <th>排名</th>
                                            <th>卡组</th>
                                            <th>已统计 / 已创建</th>
                                            <th>胜/负/逃</th>
                                            <th>胜率</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="(entry, index) in rankingRows" :key="entry.id">
                                            <td class="ranking-position">{{ index + 1 }}</td>
                                            <td class="deck-cell">
                                                <strong>{{ entry.label }}</strong>
                                                <small>
                                                    <span v-if="entry.aiLevel">LV{{ entry.aiLevel }} · </span>
                                                    {{ entry.competitors[0]?.botLabel }}
                                                </small>
                                            </td>
                                            <td>
                                                <span class="progress-number">
                                                    {{ entry.observedGames }} / {{ entry.launchedGames }}
                                                </span>
                                            </td>
                                            <td class="score current-score">
                                                {{ entry.competitors[0]?.win || 0 }} /
                                                {{ entry.competitors[0]?.lose || 0 }} /
                                                {{ entry.competitors[0]?.flee || 0 }}
                                            </td>
                                            <td class="deck-win-rate">{{ formatPercent(entry.currentWinRate) }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </article>

                        <article v-else class="panel empty-panel">
                            <n-empty description="还没有测试记录，配置上方参数后启动第一次实验" />
                        </article>
                    </div>

                    <aside class="side-column">
                        <article class="panel history-panel">
                            <div class="aside-heading">
                                <div>
                                    <span class="section-index">03</span>
                                    <h2>运行历史</h2>
                                </div>
                                <span>{{ historyTotal }}</span>
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
                                        <strong>
                                            {{ runKindLabels[run.kind] || run.kind }} · {{ run.matchupCount }} 个卡组
                                        </strong>
                                        <small>{{ formatDate(run.createdAt) }} · {{ statusLabels[run.status] }}</small>
                                    </span>
                                    <code>{{ run.id.slice(0, 8).toUpperCase() }}</code>
                                </button>
                            </div>
                            <div v-if="historyTotal > historyPageSize" class="history-pagination">
                                <n-button
                                    size="tiny"
                                    secondary
                                    :disabled="historyPage === 1"
                                    @click="selectHistoryPage(historyPage - 1)"
                                >
                                    上一页
                                </n-button>
                                <span>{{ historyPage }} / {{ historyPageCount }}</span>
                                <n-button
                                    size="tiny"
                                    secondary
                                    :disabled="historyPage === historyPageCount"
                                    @click="selectHistoryPage(historyPage + 1)"
                                >
                                    下一页
                                </n-button>
                            </div>
                            <n-empty v-if="!runs.length" size="small" description="暂无历史记录" />
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
                            <p>卡组与参赛方已独立建模，可继续扩展新的实验方式。</p>
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
