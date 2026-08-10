<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    NAlert,
    NAutoComplete,
    NButton,
    NCard,
    NCheckbox,
    NEmpty,
    NInputNumber,
    NModal,
    NPopconfirm,
    NProgress,
    NRadioButton,
    NRadioGroup,
    NSelect,
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
const activeRuns = ref([]);
const selectedRun = ref(null);
const selectedSrvproId = ref('');
const recentDecks = ref(storedRecentDecks);
const selectedDecks = ref([...storedRecentDecks]);
const allDecks = ref(false);
const experimentKind = ref('regression');
const targetDeck = ref('');
const challengerVersion = ref('current');
const deckListExpanded = ref(true);
const gamesPerMatchup = ref(500);
const challengeGamesPerMatchup = ref(100);
const configuredGamesPerMatchup = computed({
    get: () => (
        experimentKind.value === 'challenge'
            ? challengeGamesPerMatchup.value
            : gamesPerMatchup.value
    ),
    set: (value) => {
        if (experimentKind.value === 'challenge') {
            challengeGamesPerMatchup.value = value;
        } else {
            gamesPerMatchup.value = value;
        }
    },
});
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const refreshingDecks = ref(false);
const liveConnected = ref(false);
const settingsOpen = ref(false);
const settingsRecord = ref(null);
const savingSettings = ref(false);
const inspectorOpen = ref(false);
const inspectorKind = ref('srvpro');
const inspectorLoading = ref(false);
const inspectorError = ref('');
const inspectorRooms = ref([]);
const inspectorOutput = ref(null);
const clockNow = ref(Date.now());
let eventSource;
let clockTimer;
let inspectorTimer;
let refreshing;
let revisionIndexes;
let runSelectionRequest = 0;
const pendingRefreshDomains = new Set();
let recentDecksValidated = false;
const historyPageSize = 10;
const allRefreshDomains = ['system', 'runs', 'active'];

const terminalStatuses = new Set(['completed', 'stopped', 'failed', 'interrupted']);
const statusLabels = {
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    preparing: '准备环境',
    running: '正在对局',
    settling: '等待完成',
    stopped: '已停止',
    stopping: '停止中',
};
const statusTypes = {
    completed: 'success',
    failed: 'error',
    interrupted: 'warning',
    preparing: 'info',
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
    challenge: '指定卡组按列表顺序轮流对战全部或选中的对手，每组达到计划局数后自动完成。',
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
const oldDeckOptions = computed(() => (system.value?.configuration.oldDecks || []).map((item) => ({
    aiLevel: item.aiLevel,
    currentLabel: item.currentLabel,
    value: item.deck,
})));
const catalogDeckOptions = computed(() => (
    experimentKind.value === 'regression' ? regressionDeckOptions.value : currentDeckOptions.value
));
const targetDeckOptions = computed(() => {
    const query = String(targetDeck.value || '').trim().toLocaleLowerCase();
    const options = challengerVersion.value === 'old' ? oldDeckOptions.value : currentDeckOptions.value;
    return options
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
        .filter((level) => Number.isInteger(level) || level === null),
)].sort((left, right) => {
    if (left === null) {
        return 1;
    }
    if (right === null) {
        return -1;
    }
    return right - left;
}));
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
const displayedRun = computed(() => selectedRun.value);
const historyPageCount = computed(() => Math.max(1, Math.ceil(
    historyTotal.value / historyPageSize,
)));
const selectedSrvpro = computed(() => (
    system.value?.srvpros.find((srvpro) => srvpro.id === selectedSrvproId.value) || null
));
const selectedSrvproDisplay = computed(() => (
    selectedSrvpro.value
        ? `${selectedSrvpro.value.name} · ${selectedSrvpro.value.host}:${selectedSrvpro.value.duelPort}`
        : '—'
));
const activeRun = computed(() => (
    activeRuns.value.find((run) => run.srvproId === selectedSrvproId.value) || null
));
const launchPanelState = computed(() => {
    if (
        activeRun.value
        && displayedRun.value?.id !== activeRun.value.id
        && terminalStatuses.has(displayedRun.value?.status)
    ) {
        return 'terminal';
    }
    return activeRun.value ? 'running' : 'ready';
});
const terminalRunActionLabel = computed(() => (
    `任务${statusLabels[displayedRun.value?.status] || '已结束'}`
));
const hasActiveRuns = computed(() => activeRuns.value.length > 0);
const srvproOptions = computed(() => (system.value?.srvpros || []).map((srvpro) => {
    const busy = activeRuns.value.some((run) => run.srvproId === srvpro.id);
    return {
        disabled: busy,
        label: `${srvpro.name} — ${srvpro.host || '未配置'}:${srvpro.duelPort}${busy ? '（运行中）' : ''}`,
        value: srvpro.id,
    };
}));
const modeConfiguration = computed(() => (
    system.value?.configurationBySrvpro?.[selectedSrvproId.value]?.modes?.[
        experimentKind.value === 'challenge' && challengerVersion.value === 'old'
            ? 'challengeOld'
            : experimentKind.value
    ]
    || { issues: system.value?.configuration.issues || [], valid: system.value?.configuration.valid === true }
));
const configurationReady = computed(() => modeConfiguration.value.valid === true);
const inspectorTitle = computed(() => (
    inspectorKind.value === 'srvpro'
        ? `${selectedSrvpro.value?.name || 'SRVPro'} 房间列表（${inspectorRooms.value.length}）`
        : `${inspectorKind.value === 'current' ? '新版' : '旧版'} WindBot 命令行输出`
));
const canStart = computed(() => {
    if (!selectedSrvpro.value || !configurationReady.value || activeRun.value) {
        return false;
    }
    const selectedCount = allDecks.value ? bulkDeckCount.value : new Set(selectedDecks.value).size;
    if (experimentKind.value === 'challenge') {
        return String(targetDeck.value || '').trim() !== ''
            && (allDecks.value || selectedCount > 0)
            && Number.isInteger(challengeGamesPerMatchup.value);
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
    const observedGames = Math.min(run.observedGames || 0, run.totalGames);
    return Math.min(100, Math.round((observedGames / run.totalGames) * 100));
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
    if (displayedRun.value?.kind === 'challenge') {
        result[0].flee = displayedRun.value.challengeTargetFlee || 0;
    }
    return result;
});
const currentWinRate = computed(() => {
    const decided = totals.value[0].win + totals.value[1].win;
    return decided === 0 ? 0 : totals.value[0].win / decided;
});
const regressionRows = computed(() => {
    if (displayedRun.value?.kind !== 'regression') {
        return [];
    }
    return [...displayedRun.value.matchups].sort((left, right) => (
        (left.observedGames === 0) - (right.observedGames === 0)
        || left.currentWinRate - right.currentWinRate
        || (left.competitors[0]?.win || 0) - (right.competitors[0]?.win || 0)
        || left.label.localeCompare(right.label)
    ));
});
const challengeRows = computed(() => {
    if (displayedRun.value?.kind !== 'challenge') {
        return [];
    }
    return [...displayedRun.value.matchups].sort((left, right) => (
        (left.observedGames === 0) - (right.observedGames === 0)
        || left.currentWinRate - right.currentWinRate
        || (left.competitors[0]?.win || 0) - (right.competitors[0]?.win || 0)
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
    return getRunElapsedMilliseconds(displayedRun.value);
});
const estimatedCompletionAt = computed(() => {
    const run = displayedRun.value;
    if (!run || run.kind === 'ranking') {
        return null;
    }
    if (terminalStatuses.has(run.status)) {
        return run.finishedAt || null;
    }
    const startedAt = Date.parse(run.startedAt);
    const sampledAt = Date.parse(run.latestRankAt);
    const observedGames = Math.min(run.observedGames || 0, run.totalGames || 0);
    const elapsed = sampledAt - startedAt;
    const minimumSample = Math.min(
        run.totalGames || 0,
        Math.max(20, Math.ceil((run.totalGames || 0) * 0.05)),
    );
    if (
        !Number.isFinite(startedAt)
        || !Number.isFinite(sampledAt)
        || run.totalGames === 0
        || observedGames < minimumSample
        || elapsed < 30000
    ) {
        return null;
    }
    const estimatedDuration = elapsed * (run.totalGames / observedGames);
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

async function applyRunConfiguration(run) {
    experimentKind.value = run.kind;
    await nextTick();
    if (system.value?.srvpros.some((srvpro) => srvpro.id === run.srvproId)) {
        selectedSrvproId.value = run.srvproId;
    }
    allDecks.value = run.config?.selection === 'all';
    selectedDecks.value = run.matchups.map((matchup) => matchup.label);
    targetDeck.value = run.kind === 'challenge' ? run.config?.targetDeck || '' : '';
    challengerVersion.value = run.kind === 'challenge'
        ? run.config?.challengerVersion || 'current'
        : 'current';
    if (run.gamesPerMatchup > 0) {
        if (run.kind === 'challenge') {
            challengeGamesPerMatchup.value = run.gamesPerMatchup;
        } else if (run.kind === 'regression') {
            gamesPerMatchup.value = run.gamesPerMatchup;
        }
    }
}

async function refresh(domains = allRefreshDomains) {
    domains.forEach((domain) => pendingRefreshDomains.add(domain));
    if (refreshing) {
        return refreshing;
    }
    refreshing = (async () => {
        while (pendingRefreshDomains.size > 0) {
            const requested = [...pendingRefreshDomains];
            pendingRefreshDomains.clear();
            const responses = Object.fromEntries(await Promise.all(requested.map(async (domain) => {
                if (domain === 'system') {
                    return [domain, await api('/api/system')];
                }
                if (domain === 'runs') {
                    return [domain, await api(
                        `/api/runs?limit=${historyPageSize}&offset=${(historyPage.value - 1) * historyPageSize}`,
                    )];
                }
                return [domain, await api('/api/runs/active')];
            })));
            if (responses.system) {
                system.value = responses.system;
                if (!system.value.srvpros.some((srvpro) => srvpro.id === selectedSrvproId.value)) {
                    selectedSrvproId.value = system.value.srvpros[0]?.id || '';
                }
            }
            if (responses.runs) {
                runs.value = responses.runs.runs;
                historyTotal.value = responses.runs.total;
            }
            if (responses.active) {
                const previousActiveIds = new Set(activeRuns.value.map((run) => run.id));
                const selectedRunId = selectedRun.value?.id;
                const nextActiveRuns = responses.active.runs;
                activeRuns.value = nextActiveRuns;
                const selectedActiveRun = nextActiveRuns.find((run) => run.id === selectedRunId);
                if (selectedActiveRun) {
                    selectedRun.value = selectedActiveRun;
                } else if (selectedRunId && previousActiveIds.has(selectedRunId)) {
                    const latest = await api(`/api/runs/${selectedRunId}`).catch(() => null);
                    selectedRun.value = latest?.run || null;
                } else if (!selectedRun.value && nextActiveRuns.length > 0) {
                    selectedRun.value = nextActiveRuns[0];
                    await applyRunConfiguration(nextActiveRuns[0]);
                }
            }
            if (!selectedRun.value && runs.value.length > 0) {
                const initialRun = (await api(`/api/runs/${runs.value[0].id}`)).run;
                selectedRun.value = initialRun;
                await applyRunConfiguration(initialRun);
            }
        }
    })().finally(() => {
        refreshing = null;
        loading.value = false;
    });
    return refreshing;
}

function handleRevisionEvent(event) {
    let next;
    try {
        next = JSON.parse(event.data).revisions;
    } catch {
        return;
    }
    if (!next || !allRefreshDomains.every((domain) => Number.isInteger(next[domain]))) {
        return;
    }
    liveConnected.value = true;
    const changedDomains = revisionIndexes && system.value
        ? allRefreshDomains.filter((domain) => next[domain] !== revisionIndexes[domain])
        : allRefreshDomains;
    if (changedDomains.length === 0) {
        return;
    }
    refresh(changedDomains).then(() => {
        revisionIndexes ||= {};
        changedDomains.forEach((domain) => {
            revisionIndexes[domain] = next[domain];
        });
    }).catch((error) => message.error(error.message));
}

async function selectRun(runId) {
    const request = ++runSelectionRequest;
    try {
        const run = (await api(`/api/runs/${runId}`)).run;
        if (request !== runSelectionRequest) {
            return;
        }
        selectedRun.value = run;
        await applyRunConfiguration(run);
    } catch (error) {
        if (request === runSelectionRequest) {
            message.error(error.message);
        }
    }
}

function selectSrvpro(srvproId) {
    if (activeRuns.value.some((run) => run.srvproId === srvproId)) {
        return;
    }
    runSelectionRequest += 1;
    selectedSrvproId.value = srvproId;
}

function selectHistoryPage(page) {
    historyPage.value = page;
    refresh(['runs']).catch((error) => message.error(error.message));
}

async function openSettings() {
    try {
        settingsRecord.value = await api('/api/settings');
        settingsOpen.value = true;
    } catch (error) {
        message.error(error.message);
    }
}

async function loadInspector(silent = false) {
    const kind = inspectorKind.value;
    if (!silent) {
        inspectorLoading.value = true;
    }
    try {
        const body = kind === 'srvpro'
            ? await api(`/api/srvpro/rooms?srvproId=${encodeURIComponent(selectedSrvproId.value)}`)
            : await api(`/api/windbots/${kind}/output`);
        if (kind !== inspectorKind.value || !inspectorOpen.value) {
            return;
        }
        inspectorError.value = '';
        if (kind === 'srvpro') {
            inspectorRooms.value = body.rooms;
        } else {
            inspectorOutput.value = body;
        }
    } catch (error) {
        if (kind === inspectorKind.value && inspectorOpen.value) {
            inspectorError.value = error.message;
        }
    } finally {
        if (kind === inspectorKind.value) {
            inspectorLoading.value = false;
        }
    }
}

function openInspector(kind) {
    clearInterval(inspectorTimer);
    inspectorKind.value = kind;
    inspectorRooms.value = [];
    inspectorOutput.value = null;
    inspectorError.value = '';
    inspectorOpen.value = true;
    loadInspector();
    inspectorTimer = setInterval(() => loadInspector(true), 2000);
}

function closeInspector() {
    inspectorOpen.value = false;
    clearInterval(inspectorTimer);
}

function formatRoomPlayer(player) {
    if (!player) {
        return '—';
    }
    const details = [];
    if (player.status?.score !== null && player.status?.score !== undefined) {
        details.push(`Score: ${player.status.score}`);
    }
    if (player.status?.lp !== null && player.status?.lp !== undefined) {
        details.push(`LP: ${player.status.lp}`);
    }
    return details.length > 0 ? `${player.name} (${details.join(' ')})` : player.name;
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
        await refresh(['system']);
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
        await refresh(['system']);
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
            srvproId: selectedSrvproId.value,
        };
        if (experimentKind.value === 'regression') {
            request.gamesPerMatchup = gamesPerMatchup.value;
        } else if (experimentKind.value === 'challenge') {
            request.targetDeck = String(targetDeck.value || '').trim();
            request.challengerVersion = challengerVersion.value;
            request.gamesPerMatchup = challengeGamesPerMatchup.value;
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
        runSelectionRequest += 1;
        activeRuns.value = [
            body.run,
            ...activeRuns.value.filter((run) => run.id !== body.run.id),
        ];
        selectedRun.value = body.run;
        historyPage.value = 1;
        message.success(`${runKindLabels[experimentKind.value]}已创建`);
        await refresh(['runs', 'active']);
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
        await refresh(['runs', 'active']);
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

function getRunElapsedMilliseconds(run) {
    const createdAt = Date.parse(run?.createdAt);
    if (!Number.isFinite(createdAt)) {
        return null;
    }
    const finishedAt = terminalStatuses.has(run.status) ? Date.parse(run.finishedAt) : clockNow.value;
    const end = Number.isFinite(finishedAt) ? finishedAt : clockNow.value;
    return Math.max(0, end - createdAt);
}

function formatHistoryTitle(run) {
    const label = runKindLabels[run.kind] || run.kind;
    const matchupCount = run.matchupCount ?? run.matchups?.length ?? 0;
    if (run.kind === 'challenge') {
        const version = run.config?.challengerVersion === 'old' ? '旧版' : '新版';
        return `${label} · ${version} ${run.config?.targetDeck || '—'} VS ${matchupCount} 个卡组`;
    }
    const deckName = run.deckName || run.matchups?.[0]?.label;
    if (run.kind === 'regression' && matchupCount === 1 && deckName) {
        return `${label} · ${deckName} · 1 个卡组`;
    }
    return `${label} · ${matchupCount} 个卡组`;
}

async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // 在非安全来源下改用兼容复制方式。
        }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) {
        throw new Error('浏览器拒绝了复制请求');
    }
}

async function copyRoomName(name) {
    try {
        await writeClipboard(name);
        message.success('房名已复制');
    } catch (error) {
        message.error(`复制失败：${error.message}`);
    }
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
        `已完成对局：${run.observedGames}`,
        `已创建对局：${run.launchedGames}${run.kind !== 'ranking' ? ` / ${run.totalGames}` : ''}`,
    ];
    if (run.kind === 'ranking') {
        lines.push(`当前榜首：${rankingLeader.value
            ? `${rankingLeader.value.label}（${formatPercent(rankingLeader.value.currentWinRate)}）`
            : '统计中'}`);
    } else {
        if (run.kind === 'challenge') {
            lines.push(`挑战者卡组：${run.config?.targetDeck || '—'}`);
            lines.push(`挑战者版本：${run.config?.challengerVersion === 'old' ? '旧版' : '新版'}`);
            if (run.challengeTargetFlee > 0) {
                lines.push(`挑战者卡组合计逃跑：${run.challengeTargetFlee}`);
            }
        }
        lines.push(`${run.kind === 'challenge' ? '挑战者卡组' : '新版'}总胜率：${formatPercent(currentWinRate.value)}`);
    }
    lines.push(`已用时间：${formatDuration(elapsedMilliseconds.value)}`, '');

    if (run.kind === 'regression') {
        lines.push('卡组\t等级 / Bot\t统计进度\t胜 / 负 / 逃\t新版胜率');
        for (const matchup of regressionRows.value) {
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
        lines.push('对手卡组\t等级 / Bot\t统计进度\t挑战者卡组 胜 / 负\t对手逃跑\t挑战者卡组胜率');
        for (const matchup of challengeRows.value) {
            const competitor = matchup.competitors[0];
            lines.push([
                matchup.label,
                `${matchup.aiLevel ? `LV${matchup.aiLevel} / ` : ''}${matchup.competitors[1]?.botLabel || '—'}`,
                `${matchup.observedGames} / ${matchup.targetGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0}`,
                matchup.competitors[1]?.flee || 0,
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
        await writeClipboard(text);
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

function clearRecentDecks() {
    recentDecks.value = [];
    try {
        localStorage.removeItem('windbot-arena-recent-decks');
    } catch {
        // 当前页面仍会立即清除最近使用标记。
    }
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
    const available = new Set(catalogDeckOptions.value.map((option) => option.value));
    selectedDecks.value = selectedDecks.value.filter((deck) => available.has(deck));
});

onMounted(async () => {
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('ready', handleRevisionEvent);
    eventSource.addEventListener('heartbeat', handleRevisionEvent);
    eventSource.onerror = () => {
        liveConnected.value = false;
    };
    try {
        await refresh();
    } catch (error) {
        message.error(error.message);
        loading.value = false;
    }
    clockTimer = setInterval(() => { clockNow.value = Date.now(); }, 1000);
});

onBeforeUnmount(() => {
    clearInterval(clockTimer);
    clearInterval(inspectorTimer);
    eventSource?.close();
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
                        <div class="readout-heading">
                            <span>SRVPRO</span>
                            <button type="button" title="查看房间列表" aria-label="查看 SRVPro 房间列表" @click="openInspector('srvpro')">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="11" cy="11" r="6"></circle>
                                    <path d="m16 16 4 4"></path>
                                </svg>
                            </button>
                        </div>
                        <strong :title="selectedSrvpro ? selectedSrvproDisplay : undefined">
                            {{ selectedSrvproDisplay }}
                        </strong>
                    </div>
                    <div>
                        <div class="readout-heading">
                            <span>CURRENT WINDBOT</span>
                            <button type="button" title="查看命令行输出" aria-label="查看 Current WindBot 命令行输出" @click="openInspector('current')">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="11" cy="11" r="6"></circle>
                                    <path d="m16 16 4 4"></path>
                                </svg>
                            </button>
                        </div>
                        <strong>{{ formatWindBotEndpoint(system?.windbots.current) }}</strong>
                    </div>
                    <div>
                        <div class="readout-heading">
                            <span>BASELINE WINDBOT</span>
                            <button type="button" title="查看命令行输出" aria-label="查看 Baseline WindBot 命令行输出" @click="openInspector('old')">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="11" cy="11" r="6"></circle>
                                    <path d="m16 16 4 4"></path>
                                </svg>
                            </button>
                        </div>
                        <strong>{{ formatWindBotEndpoint(system?.windbots.old) }}</strong>
                    </div>
                </div>
            </section>

            <n-spin :show="loading">
                <section class="workspace">
                    <div class="main-column">
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
                            <n-alert
                                v-if="system && !configurationReady"
                                class="configuration-alert"
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
                            <div class="panel-heading">
                                <div>
                                    <span class="section-index">01</span>
                                    <div>
                                        <div class="results-title-line">
                                            <h2>{{ runKindLabels[experimentKind] }}</h2>
                                            <n-tag v-if="!activeRun" size="small">可创建</n-tag>
                                            <n-tag
                                                v-else-if="displayedRun?.id !== activeRun.id"
                                                size="small"
                                                type="warning"
                                            >
                                                历史
                                            </n-tag>
                                        </div>
                                        <p>{{ runKindDescriptions[experimentKind] }}</p>
                                    </div>
                                </div>
                            </div>

                            <div class="launch-form">
                                <label
                                    v-if="system?.srvpros.length > 1"
                                    class="field field-wide srvpro-field"
                                >
                                    <span>SRVPro 实例</span>
                                    <n-select
                                        :value="selectedSrvproId"
                                        :options="srvproOptions"
                                        placeholder="选择本次任务使用的 SRVPro"
                                        @update:value="selectSrvpro"
                                    />
                                </label>
                                <div v-if="experimentKind === 'challenge'" class="challenge-target-row">
                                    <label class="field target-deck-field">
                                        <span>挑战者卡组</span>
                                        <n-auto-complete
                                            v-model:value="targetDeck"
                                            :disabled="!!activeRun"
                                            :options="targetDeckOptions"
                                            :render-label="(option) => option.displayLabel"
                                            clearable
                                            placeholder="输入执行器名称，可不在 bot.conf 列表中"
                                        />
                                    </label>
                                    <div class="field challenger-version-field">
                                        <span>挑战者 WindBot</span>
                                        <n-radio-group
                                            v-model:value="challengerVersion"
                                            :disabled="!!activeRun"
                                            name="challenger-version"
                                            size="small"
                                        >
                                            <n-radio-button value="current">新版</n-radio-button>
                                            <n-radio-button value="old">旧版</n-radio-button>
                                        </n-radio-group>
                                    </div>
                                </div>
                                <div class="field field-wide deck-picker">
                                    <div class="field-heading">
                                        <span>{{ experimentKind === 'challenge' ? '对手卡组' : '测试卡组' }}</span>
                                        <div class="field-heading-actions">
                                            <n-button
                                                text
                                                type="primary"
                                                size="tiny"
                                                :disabled="recentDecks.length === 0"
                                                @click="clearRecentDecks"
                                            >
                                                清空最近使用
                                            </n-button>
                                            <n-button
                                                text
                                                type="primary"
                                                size="tiny"
                                                :disabled="hasActiveRuns"
                                                :loading="refreshingDecks"
                                                @click="refreshBotConfigs"
                                            >
                                                刷新 bot.conf
                                            </n-button>
                                        </div>
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
                                            :key="aiLevel ?? 'ungraded'"
                                            :checked="isAiLevelSelected(aiLevel)"
                                            :indeterminate="isAiLevelIndeterminate(aiLevel)"
                                            :disabled="!!activeRun"
                                            @update:checked="handleAiLevelSelection(aiLevel, $event)"
                                        >
                                            {{ aiLevel === null ? '无分级' : `LV${aiLevel}` }}
                                        </n-checkbox>
                                    </span>
                                </div>
                                <div class="launch-actions">
                                    <label v-if="experimentKind !== 'ranking'" class="field games-field">
                                        <span>{{ experimentKind === 'challenge' ? '每个对手局数' : '每卡组局数' }}</span>
                                        <n-input-number
                                            v-model:value="configuredGamesPerMatchup"
                                            :disabled="!!activeRun"
                                            :min="1"
                                            :max="10000"
                                            :step="experimentKind === 'challenge' ? 10 : 50"
                                        />
                                    </label>
                                    <n-button
                                        v-if="launchPanelState === 'ready'"
                                        type="primary"
                                        :disabled="!canStart"
                                        :loading="starting"
                                        @click="startRun"
                                    >
                                        启动{{ runKindLabels[experimentKind] }}
                                    </n-button>
                                    <n-button v-else-if="launchPanelState === 'terminal'" disabled>
                                        {{ terminalRunActionLabel }}
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
                                            {{ formatHistoryTitle(displayedRun) }}
                                            · <code>{{ displayedRun.id.slice(0, 8).toUpperCase() }}</code>
                                            · {{ displayedRun.config?.srvproName || displayedRun.config?.duelServer || 'SRVPro' }}
                                            · 创建于 {{ formatDate(displayedRun.createdAt) }}
                                        </p>
                                    </div>
                                </div>
                                <div class="results-actions">
                                    <n-button size="small" secondary @click="copyResults">复制文本</n-button>
                                </div>
                            </div>

                            <div class="metric-grid">
                                <div
                                    class="metric primary-metric"
                                    :class="{ 'has-progress': displayedRun.kind !== 'ranking' }"
                                >
                                    <span>{{ displayedRun.kind !== 'ranking' ? '任务进度' : '已完成对局' }}</span>
                                    <strong v-if="displayedRun.kind !== 'ranking'" class="progress-value">
                                        {{ displayedRun.observedGames }}<span> / {{ displayedRun.totalGames }}</span>
                                    </strong>
                                    <strong v-else>{{ displayedRun.observedGames }}</strong>
                                    <n-progress
                                        v-if="displayedRun.kind !== 'ranking'"
                                        type="line"
                                        :percentage="progress"
                                        indicator-placement="inside"
                                        :indicator-text-color="darkMode ? '#dfeaed' : '#102a32'"
                                        :height="18"
                                        :border-radius="0"
                                    />
                                </div>
                                <div class="metric">
                                    <span>已创建对局</span>
                                    <strong>{{ displayedRun.launchedGames }}</strong>
                                </div>
                                <div class="metric">
                                    <span v-if="displayedRun.kind === 'ranking'">当前榜首</span>
                                    <span v-else>{{ displayedRun.kind === 'challenge' ? '挑战卡组总胜率' : '新版总胜率' }}</span>
                                    <strong v-if="displayedRun.kind === 'ranking'" class="leader-value">
                                        <span :title="rankingLeader?.label || ''">
                                            {{ rankingLeader?.label || '统计中' }}
                                        </span>
                                        <small v-if="rankingLeader">{{ formatPercent(rankingLeader.currentWinRate) }}</small>
                                    </strong>
                                    <strong v-else-if="displayedRun.kind === 'challenge'" class="challenge-rate-value">
                                        <span :title="displayedRun.config?.targetDeck || ''">
                                            {{ displayedRun.config?.targetDeck || '—' }}
                                            · {{ displayedRun.config?.challengerVersion === 'old' ? '旧版' : '新版' }}
                                        </span>
                                        <small>
                                            {{ formatPercent(currentWinRate) }}
                                            <template v-if="displayedRun.challengeTargetFlee > 0">
                                                · 逃跑 {{ displayedRun.challengeTargetFlee }}
                                            </template>
                                        </small>
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
                                            : displayedRun.kind !== 'ranking' ? '预计完成时间' : '运行方式' }}
                                    </span>
                                    <strong class="time-value">
                                        {{ terminalStatuses.has(displayedRun.status)
                                            ? formatDate(displayedRun.finishedAt)
                                            : displayedRun.kind !== 'ranking'
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
                                        <tr v-for="matchup in regressionRows" :key="matchup.id">
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
                                                <span
                                                    class="flee-count"
                                                    :class="{ 'is-nonzero': matchup.competitors[0]?.flee > 0 }"
                                                >
                                                    {{ matchup.competitors[0]?.flee || 0 }}
                                                </span>
                                            </td>
                                            <td
                                                class="deck-win-rate"
                                                :class="{
                                                    'is-significant-win': matchup.observedGames >= 100
                                                        && matchup.currentWinRate > 0.55,
                                                    'is-significant-loss': matchup.observedGames >= 100
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
                                            <th>统计进度</th>
                                            <th>挑战卡组 胜/负</th>
                                            <th>对手逃跑</th>
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
                                                    {{ matchup.observedGames }} / {{ matchup.targetGames }}
                                                </span>
                                            </td>
                                            <td class="score current-score">
                                                {{ matchup.competitors[0]?.win || 0 }} /
                                                {{ matchup.competitors[0]?.lose || 0 }}
                                            </td>
                                            <td class="score current-score">
                                                <span
                                                    class="flee-count"
                                                    :class="{ 'is-nonzero': matchup.competitors[1]?.flee > 0 }"
                                                >
                                                    {{ matchup.competitors[1]?.flee || 0 }}
                                                </span>
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
                                                <span
                                                    class="flee-count"
                                                    :class="{ 'is-nonzero': entry.competitors[0]?.flee > 0 }"
                                                >
                                                    {{ entry.competitors[0]?.flee || 0 }}
                                                </span>
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
                                        <strong :title="formatHistoryTitle(run)">
                                            {{ formatHistoryTitle(run) }}
                                        </strong>
                                        <small>
                                            {{ formatDate(run.createdAt) }}
                                            · {{ formatDuration(getRunElapsedMilliseconds(run)) }}
                                            · {{ statusLabels[run.status] }}
                                        </small>
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
                <span>
                    {{ hasActiveRuns ? `${activeRuns.length} 个活动任务` : '当前详情数据' }}：
                    {{ formatDate(displayedRun?.latestRankAt, true) }}
                </span>
                <div class="live-state" :class="{ connected: liveConnected }" role="status">
                    <span class="live-dot"></span>
                    {{ liveConnected ? '实时数据已连接' : '正在重新连接' }}
                </div>
            </div>
        </footer>

        <settings-modal
            v-model:show="settingsOpen"
            :disabled="hasActiveRuns"
            :record="settingsRecord"
            :saving="savingSettings"
            @save="saveSettings"
        />

        <n-modal
            :show="inspectorOpen"
            :mask-closable="false"
            @update:show="$event ? null : closeInspector()"
        >
            <n-card
                class="inspector-card"
                :title="inspectorTitle"
                :bordered="false"
                role="dialog"
                aria-modal="true"
            >
                <template #header-extra>
                    <n-button size="small" quaternary @click="closeInspector">关闭</n-button>
                </template>
                <n-alert v-if="inspectorError" type="error" :bordered="false">
                    {{ inspectorError }}
                </n-alert>
                <n-spin :show="inspectorLoading">
                    <template v-if="inspectorKind === 'srvpro'">
                        <div v-if="inspectorRooms.length > 0" class="room-table-wrap">
                            <table class="room-table">
                                <thead>
                                    <tr>
                                        <th>序号</th>
                                        <th>房名</th>
                                        <th>玩家</th>
                                        <th>玩家</th>
                                        <th>状态</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="room in inspectorRooms" :key="room.id">
                                        <td>{{ room.id }}</td>
                                        <td>
                                            <button
                                                type="button"
                                                class="room-name-button"
                                                title="点击复制房名"
                                                @click="copyRoomName(room.name)"
                                            >
                                                {{ room.name }}
                                            </button>
                                        </td>
                                        <td>{{ formatRoomPlayer(room.players[0]) }}</td>
                                        <td>{{ formatRoomPlayer(room.players[1]) }}</td>
                                        <td>{{ room.status || '—' }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <n-empty v-else-if="!inspectorLoading && !inspectorError" description="当前没有房间" />
                    </template>
                    <template v-else>
                        <n-alert
                            v-if="inspectorOutput && !inspectorOutput.available"
                            type="warning"
                            :bordered="false"
                        >
                            远程 WindBot 的命令行不由 Arena 管理，无法读取输出。
                        </n-alert>
                        <pre v-else-if="inspectorOutput?.output" class="command-output">{{ inspectorOutput.output }}</pre>
                        <n-empty
                            v-else-if="!inspectorLoading && !inspectorError"
                            description="本地 WindBot 尚无命令行输出"
                        />
                    </template>
                </n-spin>
                <template #footer>
                    <div class="inspector-footer">
                        <span>每 2 秒自动刷新</span>
                        <n-button size="small" :loading="inspectorLoading" @click="loadInspector()">立即刷新</n-button>
                    </div>
                </template>
            </n-card>
        </n-modal>
    </div>
</template>
