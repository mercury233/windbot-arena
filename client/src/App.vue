<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    NAlert,
    NAutoComplete,
    NButton,
    NButtonGroup,
    NCard,
    NCheckbox,
    NDropdown,
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
    darkMode: { type: Boolean, default: false },
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
const deletingRunId = ref('');
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
const inspectorHalfwayWatchEnabled = ref(null);
const updatingHalfwayWatch = ref(false);
const inspectorOutput = ref(null);
const clockNow = ref(Date.now());
let eventSource;
let clockTimer;
let inspectorTimer;
let inspectorRequest = 0;
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
    regression: '新旧回归',
    challenge: '卡组挑战',
    ranking: '胜率排行',
    tag: '双打冒烟',
};
const runKindIndexes = {
    regression: '01',
    challenge: '02',
    tag: '03',
    ranking: '04',
};
const runKindDescriptions = {
    regression: '新版与旧版使用同一卡组，按计划局数进行回归对战。',
    challenge: '指定卡组按列表顺序轮流对战全部或选中的对手，每组达到计划局数后自动完成。',
    tag: '从选中卡组中每局随机组队进行双打，直到手动停止；创建房间速度自动减半，不统计胜率。',
    ranking: '从选中卡组中每局随机抽取两个对战，直到手动停止。',
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
const historyPlaceholderCount = computed(() => (
    historyPageCount.value > 1 && historyPage.value === historyPageCount.value
        ? Math.max(0, historyPageSize - runs.value.length)
        : 0
));
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
    if (experimentKind.value === 'tag') {
        return selectedCount >= 1;
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
const tagRows = computed(() => {
    if (displayedRun.value?.kind !== 'tag') {
        return [];
    }
    return [...displayedRun.value.matchups].sort((left, right) => (
        right.launchedGames - left.launchedGames || left.label.localeCompare(right.label)
    ));
});
const tagWindBotOutputScannable = computed(() => (
    displayedRun.value?.kind === 'tag'
    && displayedRun.value.config?.windbots?.current?.mode === 'local'
));
const tagIssueCount = computed(() => Number(displayedRun.value?.windbotOutputErrorCount) || 0);
const regressionRetestDecks = computed(() => {
    const availableDecks = new Set(regressionDeckOptions.value.map((option) => option.value));
    return regressionRows.value
        .filter((matchup) => (
            matchup.observedGames >= 100
            && (matchup.currentWinRate > 0.55 || matchup.currentWinRate < 0.45)
            && availableDecks.has(matchup.label)
        ))
        .map((matchup) => matchup.label);
});
const rankingLeader = computed(() => rankingRows.value.find((item) => item.observedGames > 0) || null);
const resultDownloadOptions = [
    { label: '下载文本', key: 'text' },
    { label: '下载 Markdown', key: 'markdown' },
    { label: '下载 JSON', key: 'json' },
];
const elapsedMilliseconds = computed(() => {
    return getRunElapsedMilliseconds(displayedRun.value);
});
const estimatedCompletionAt = computed(() => {
    const run = displayedRun.value;
    if (!run || run.kind === 'ranking' || run.kind === 'tag') {
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

async function deleteRun(runId) {
    deletingRunId.value = runId;
    try {
        await api(`/api/runs/${runId}`, { method: 'DELETE' });
        if (selectedRun.value?.id === runId) {
            runSelectionRequest += 1;
            selectedRun.value = null;
        }
        const remainingTotal = Math.max(0, historyTotal.value - 1);
        const lastPage = Math.max(1, Math.ceil(remainingTotal / historyPageSize));
        historyPage.value = Math.min(historyPage.value, lastPage);
        await refresh(['runs', 'active']);
        message.success('运行历史已删除');
    } catch (error) {
        message.error(error.message);
    } finally {
        deletingRunId.value = '';
    }
}

function shouldConfirmRunDeletion(run) {
    const shortTerminalRun = (run.status === 'stopped' || run.status === 'interrupted')
        && getRunElapsedMilliseconds(run) <= 30_000;
    return run.status !== 'failed'
        && !shortTerminalRun;
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
    if (kind === 'srvpro' && updatingHalfwayWatch.value) {
        return;
    }
    const request = ++inspectorRequest;
    if (!silent) {
        inspectorLoading.value = true;
    }
    try {
        const body = kind === 'srvpro'
            ? await api(`/api/srvpro/rooms?srvproId=${encodeURIComponent(selectedSrvproId.value)}`)
            : await api(`/api/windbots/${kind}/output`);
        if (request !== inspectorRequest || kind !== inspectorKind.value || !inspectorOpen.value) {
            return;
        }
        inspectorError.value = '';
        if (kind === 'srvpro') {
            inspectorRooms.value = body.rooms;
            inspectorHalfwayWatchEnabled.value = body.enableHalfwayWatch;
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
    inspectorHalfwayWatchEnabled.value = null;
    inspectorOutput.value = null;
    inspectorError.value = '';
    inspectorOpen.value = true;
    loadInspector();
    inspectorTimer = setInterval(() => loadInspector(true), 2000);
}

function closeInspector() {
    inspectorOpen.value = false;
    inspectorRequest++;
    clearInterval(inspectorTimer);
}

async function updateHalfwayWatch(enabled) {
    updatingHalfwayWatch.value = true;
    const request = ++inspectorRequest;
    const srvproId = selectedSrvproId.value;
    try {
        const result = await api('/api/srvpro/halfwaywatch', {
            body: JSON.stringify({
                enabled,
                srvproId,
            }),
            method: 'PUT',
        });
        if (
            request !== inspectorRequest
            || !inspectorOpen.value
            || inspectorKind.value !== 'srvpro'
            || selectedSrvproId.value !== srvproId
        ) {
            return;
        }
        inspectorHalfwayWatchEnabled.value = result.enableHalfwayWatch;
        message.success(result.enableHalfwayWatch ? '已启用新建房间的观战' : '已禁用新建房间的观战');
    } catch (error) {
        if (
            request === inspectorRequest
            && inspectorOpen.value
            && inspectorKind.value === 'srvpro'
            && selectedSrvproId.value === srvproId
        ) {
            message.error(error.message);
        }
    } finally {
        updatingHalfwayWatch.value = false;
    }
}

function formatRoomPlayer(player, includeScore = true) {
    if (!player) {
        return '—';
    }
    const details = [];
    if (includeScore && player.status?.score !== null && player.status?.score !== undefined) {
        details.push(`Score: ${player.status.score}`);
    }
    if (player.status?.lp !== null && player.status?.lp !== undefined) {
        details.push(`LP: ${player.status.lp}`);
    }
    return details.length > 0 ? `${player.name} (${details.join(' ')})` : player.name;
}

function getRoomPlayer(room, position) {
    return room.players.find((player) => player.position === position);
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

function serializeResults(run, format) {
    if (format === 'json') {
        return JSON.stringify({
            exportedAt: new Date().toISOString(),
            run: {
                id: run.id,
                kind: run.kind,
                kindLabel: runKindLabels[run.kind] || '实验结果',
                status: run.status,
                statusLabel: statusLabels[run.status] || run.status,
                createdAt: run.createdAt,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                observedGames: run.observedGames,
                launchedGames: run.launchedGames,
                totalGames: run.totalGames,
                gamesPerMatchup: run.gamesPerMatchup,
                config: run.config,
            },
            summary: {
                elapsedMilliseconds: elapsedMilliseconds.value,
                currentWinRate: ['ranking', 'tag'].includes(run.kind) ? null : currentWinRate.value,
                windbotOutputErrorCount: run.kind === 'tag'
                    ? run.windbotOutputErrorCount || 0
                    : null,
                windbotOutputScannable: run.kind === 'tag'
                    ? run.config?.windbots?.current?.mode === 'local'
                    : null,
                rankingLeader: run.kind === 'ranking' && rankingLeader.value ? {
                    deck: rankingLeader.value.label,
                    winRate: rankingLeader.value.currentWinRate,
                } : null,
            },
            matchups: run.matchups,
        }, null, 2);
    }

    const summary = [
        ['任务 ID', run.id],
        ['状态', statusLabels[run.status] || run.status],
        ['创建时间', formatDate(run.createdAt)],
        ['已完成对局', run.kind === 'tag' ? '不统计' : run.observedGames],
        ['已创建对局', `${run.launchedGames}${
            !['ranking', 'tag'].includes(run.kind) ? ` / ${run.totalGames}` : ''
        }`],
    ];
    if (run.kind === 'ranking') {
        summary.push(['当前榜首', rankingLeader.value
            ? `${rankingLeader.value.label}（${formatPercent(rankingLeader.value.currentWinRate)}）`
            : '统计中']);
    } else if (run.kind === 'tag') {
        summary.push(['测试卡组', run.matchups.length]);
        summary.push([
            'WindBot 错误次数',
            tagWindBotOutputScannable.value ? tagIssueCount.value : '无法读取远程输出',
        ]);
    } else {
        if (run.kind === 'challenge') {
            summary.push(['挑战者卡组', run.config?.targetDeck || '—']);
            summary.push(['挑战者版本', run.config?.challengerVersion === 'old' ? '旧版' : '新版']);
            if (run.challengeTargetFlee > 0) {
                summary.push(['挑战者卡组合计逃跑', run.challengeTargetFlee]);
            }
        }
        summary.push([
            `${run.kind === 'challenge' ? '挑战者卡组' : '新版'}总胜率`,
            formatPercent(currentWinRate.value),
        ]);
    }
    summary.push(['已用时间', formatDuration(elapsedMilliseconds.value)]);

    let columns;
    let rows;
    if (run.kind === 'regression') {
        columns = ['卡组', '等级 / Bot', '统计进度', '胜 / 负 / 逃', '新版胜率'];
        rows = regressionRows.value.map((matchup) => {
            const competitor = matchup.competitors[0];
            return [
                matchup.label,
                `${matchup.aiLevel ? `LV${matchup.aiLevel} / ` : ''}${competitor?.botLabel || '—'}`,
                `${matchup.observedGames} / ${matchup.targetGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0} / ${competitor?.flee || 0}`,
                formatPercent(matchup.currentWinRate),
            ];
        });
    } else if (run.kind === 'challenge') {
        columns = ['对手卡组', '等级 / Bot', '统计进度', '挑战者卡组 胜 / 负', '对手逃跑', '挑战者卡组胜率'];
        rows = challengeRows.value.map((matchup) => {
            const competitor = matchup.competitors[0];
            return [
                matchup.label,
                `${matchup.aiLevel ? `LV${matchup.aiLevel} / ` : ''}${matchup.competitors[1]?.botLabel || '—'}`,
                `${matchup.observedGames} / ${matchup.targetGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0}`,
                matchup.competitors[1]?.flee || 0,
                formatPercent(matchup.currentWinRate),
            ];
        });
    } else if (run.kind === 'tag') {
        columns = ['测试卡组', '等级 / Bot', '参与对局'];
        rows = tagRows.value.map((entry) => [
            entry.label,
            `${entry.aiLevel ? `LV${entry.aiLevel} / ` : ''}${entry.competitors[0]?.botLabel || '—'}`,
            entry.launchedGames,
        ]);
    } else {
        columns = ['排名', '卡组', '等级 / Bot', '已统计 / 已创建', '胜 / 负 / 逃', '胜率'];
        rows = rankingRows.value.map((entry, index) => {
            const competitor = entry.competitors[0];
            return [
                index + 1,
                entry.label,
                `${entry.aiLevel ? `LV${entry.aiLevel} / ` : ''}${competitor?.botLabel || '—'}`,
                `${entry.observedGames} / ${entry.launchedGames}`,
                `${competitor?.win || 0} / ${competitor?.lose || 0} / ${competitor?.flee || 0}`,
                formatPercent(entry.currentWinRate),
            ];
        });
    }

    if (format === 'markdown') {
        const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
        return [
            `# WindBot Arena · ${runKindLabels[run.kind] || '实验结果'}`,
            '',
            ...summary.map(([label, value]) => `- ${label}：${value}`),
            '',
            `| ${columns.map(escapeCell).join(' | ')} |`,
            `| ${columns.map(() => '---').join(' | ')} |`,
            ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
            '',
        ].join('\n');
    }

    return [
        `WindBot Arena · ${runKindLabels[run.kind] || '实验结果'}`,
        ...summary.map(([label, value]) => `${label}：${value}`),
        '',
        columns.join('\t'),
        ...rows.map((row) => row.join('\t')),
    ].join('\n');
}

async function copyResults() {
    const run = displayedRun.value;
    if (!run) {
        return;
    }

    try {
        await writeClipboard(serializeResults(run, 'text'));
        message.success('实验结果已复制为文本');
    } catch (error) {
        message.error(`复制失败：${error.message}`);
    }
}

function downloadResults(format) {
    const run = displayedRun.value;
    if (!run) {
        return;
    }

    const fileTypes = {
        text: { extension: 'txt', mime: 'text/plain;charset=utf-8' },
        markdown: { extension: 'md', mime: 'text/markdown;charset=utf-8' },
        json: { extension: 'json', mime: 'application/json;charset=utf-8' },
    };
    const fileType = fileTypes[format];
    if (!fileType) {
        return;
    }

    const content = serializeResults(run, format);
    const blob = new Blob(format === 'json' ? [content] : ['\ufeff', content], { type: fileType.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `windbot-arena-${run.kind}-${run.id.slice(0, 8)}.${fileType.extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    message.success(`实验结果已下载为 ${fileType.extension.toUpperCase()}`);
}

function handleDeckSelection(deck, checked) {
    selectedDecks.value = checked
        ? [...new Set([...selectedDecks.value, deck])]
        : selectedDecks.value.filter((item) => item !== deck);
}

function selectRegressionRetestDecks() {
    allDecks.value = false;
    selectedDecks.value = [...regressionRetestDecks.value];
    deckListExpanded.value = true;
    message.success(`已选中 ${selectedDecks.value.length} 个胜率异常卡组`);
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
                <div class="theme-control" title="切换日间 / 夜间模式">
                    <svg class="theme-icon" :class="{ active: !darkMode }" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="4"></circle>
                        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"></path>
                    </svg>
                    <n-switch
                        :value="darkMode"
                        size="small"
                        aria-label="切换日间 / 夜间模式"
                        @update:value="emit('update:darkMode', $event)"
                    />
                    <svg class="theme-icon" :class="{ active: darkMode }" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M20.6 15.7A9 9 0 0 1 8.3 3.4 9 9 0 1 0 20.6 15.7Z"></path>
                    </svg>
                </div>
                <n-button size="small" quaternary @click="openSettings">系统配置</n-button>
            </div>
        </header>

        <main>
            <section class="hero">
                <div class="hero-copy">
                    <span class="eyebrow">DUEL EXPERIMENT LAB</span>
                    <h1>让每一次 AI 变更<br><em>都有数据可循</em></h1>
                    <p>运行新旧版本回归、单卡组挑战、双打冒烟与随机胜率排行，实时观察卡组表现并完整留档。</p>
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
                                <n-radio-button value="tag">双打冒烟</n-radio-button>
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
                                    <span class="section-index">{{ runKindIndexes[experimentKind] }}</span>
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
                                                v-if="experimentKind === 'regression'
                                                    && displayedRun?.kind === 'regression'
                                                    && terminalStatuses.has(displayedRun.status)"
                                                text
                                                type="primary"
                                                size="tiny"
                                                :disabled="!!activeRun || regressionRetestDecks.length === 0"
                                                @click="selectRegressionRetestDecks"
                                            >
                                                一键复测
                                            </n-button>
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
                                    <label
                                        v-if="!['ranking', 'tag'].includes(experimentKind)"
                                        class="field games-field"
                                    >
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
                                        已创建的对局不会撤销，现有记录会保留。确认停止？
                                    </n-popconfirm>
                                </div>
                            </div>
                        </article>

                        <article v-if="displayedRun" class="panel results-panel">
                            <div class="results-header">
                                <div>
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
                                    <n-button-group size="small">
                                        <n-button secondary @click="copyResults">复制文本</n-button>
                                        <n-dropdown
                                            trigger="click"
                                            :options="resultDownloadOptions"
                                            @select="downloadResults"
                                        >
                                            <n-button secondary aria-label="下载实验结果">▾</n-button>
                                        </n-dropdown>
                                    </n-button-group>
                                </div>
                            </div>

                            <div class="metric-grid">
                                <div class="metric primary-metric">
                                    <span v-if="displayedRun.kind === 'tag'">测试卡组</span>
                                    <span v-else>{{ displayedRun.kind !== 'ranking' ? '任务进度' : '已完成对局' }}</span>
                                    <strong v-if="displayedRun.kind === 'tag'">{{ displayedRun.matchups.length }}</strong>
                                    <strong v-else-if="displayedRun.kind !== 'ranking'" class="progress-value">
                                        {{ displayedRun.observedGames }}<span> / {{ displayedRun.totalGames }}</span>
                                    </strong>
                                    <strong v-else>{{ displayedRun.observedGames }}</strong>
                                    <n-progress
                                        v-if="!['ranking', 'tag'].includes(displayedRun.kind)"
                                        type="line"
                                        :percentage="progress"
                                        :height="5"
                                        :show-indicator="false"
                                        :border-radius="0"
                                    />
                                </div>
                                <div class="metric">
                                    <span>已创建对局</span>
                                    <strong>{{ displayedRun.launchedGames }}</strong>
                                </div>
                                <div class="metric">
                                    <span v-if="displayedRun.kind === 'ranking'">当前榜首</span>
                                    <span
                                        v-else-if="displayedRun.kind === 'tag'"
                                        title="扫描本次任务运行期间新版 WindBot 写入 stderr 的错误记录"
                                    >
                                        WindBot 错误次数
                                    </span>
                                    <span v-else>{{ displayedRun.kind === 'challenge' ? '挑战卡组总胜率' : '新版总胜率' }}</span>
                                    <strong v-if="displayedRun.kind === 'ranking'" class="leader-value">
                                        <span :title="rankingLeader?.label || ''">
                                            {{ rankingLeader?.label || '统计中' }}
                                        </span>
                                        <small v-if="rankingLeader">{{ formatPercent(rankingLeader.currentWinRate) }}</small>
                                    </strong>
                                    <strong
                                        v-else-if="displayedRun.kind === 'tag'"
                                        :class="{ 'unavailable-value': !tagWindBotOutputScannable }"
                                    >
                                        {{ tagWindBotOutputScannable ? tagIssueCount : '无法读取远程输出' }}
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
                                            : !['ranking', 'tag'].includes(displayedRun.kind) ? '预计完成时间' : '运行方式' }}
                                    </span>
                                    <strong class="time-value">
                                        {{ terminalStatuses.has(displayedRun.status)
                                            ? formatDate(displayedRun.finishedAt)
                                            : !['ranking', 'tag'].includes(displayedRun.kind)
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
                            <div v-else-if="displayedRun.kind === 'tag'" class="table-wrap">
                                <table class="result-table">
                                    <thead>
                                        <tr>
                                            <th>测试卡组</th>
                                            <th>参与对局</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="entry in tagRows" :key="entry.id">
                                            <td class="deck-cell">
                                                <strong>{{ entry.label }}</strong>
                                                <small>
                                                    <span v-if="entry.aiLevel">LV{{ entry.aiLevel }} · </span>
                                                    {{ entry.competitors[0]?.botLabel }}
                                                </small>
                                            </td>
                                            <td><span class="progress-number">{{ entry.launchedGames }}</span></td>
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
                                    <h2>运行历史</h2>
                                </div>
                                <span>{{ historyTotal }}</span>
                            </div>
                            <div v-if="runs.length" class="history-list">
                                <div
                                    v-for="run in runs"
                                    :key="run.id"
                                    class="history-entry"
                                    :class="{ active: displayedRun?.id === run.id }"
                                >
                                    <button class="history-item" @click="selectRun(run.id)">
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
                                    </button>
                                    <n-popconfirm
                                        v-if="terminalStatuses.has(run.status)"
                                        :disabled="!shouldConfirmRunDeletion(run)"
                                        @positive-click="deleteRun(run.id)"
                                    >
                                        <template #trigger>
                                            <button
                                                class="history-delete"
                                                type="button"
                                                title="删除运行历史"
                                                :aria-label="`删除运行历史 ${formatHistoryTitle(run)}`"
                                                :disabled="deletingRunId === run.id"
                                                @click.stop="!shouldConfirmRunDeletion(run) && deleteRun(run.id)"
                                            >
                                                ×
                                            </button>
                                        </template>
                                        确定删除这项运行历史？此操作无法撤销。
                                    </n-popconfirm>
                                </div>
                                <div
                                    v-for="index in historyPlaceholderCount"
                                    :key="`placeholder-${index}`"
                                    class="history-entry history-entry-placeholder"
                                    aria-hidden="true"
                                >
                                    <div class="history-item">
                                        <span class="history-status"></span>
                                        <span class="history-main">
                                            <strong>&nbsp;</strong>
                                            <small>&nbsp;</small>
                                        </span>
                                    </div>
                                </div>
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
                    <div class="inspector-header-actions">
                        <label v-if="inspectorKind === 'srvpro'" class="halfwaywatch-control">
                            <span>允许观战</span>
                            <n-switch
                                :value="inspectorHalfwayWatchEnabled === true"
                                :disabled="inspectorHalfwayWatchEnabled === null"
                                :loading="updatingHalfwayWatch"
                                size="small"
                                @update:value="updateHalfwayWatch"
                            />
                        </label>
                        <n-button size="small" secondary @click="closeInspector">关闭</n-button>
                    </div>
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
                                        <th>玩家（队伍 A）</th>
                                        <th>玩家（队伍 B）</th>
                                        <th>状态</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="room in inspectorRooms" :key="room.id">
                                        <td>{{ room.id }}</td>
                                        <td>
                                            <button
                                                v-if="inspectorHalfwayWatchEnabled"
                                                type="button"
                                                class="room-name-button"
                                                title="点击复制房名"
                                                @click="copyRoomName(room.name)"
                                            >
                                                {{ room.name }}
                                            </button>
                                            <span v-else class="room-name-text">{{ room.name }}</span>
                                        </td>
                                        <td>
                                            <div v-if="room.mode === 2" class="room-team-members">
                                                <span>{{ formatRoomPlayer(getRoomPlayer(room, 0), false) }}</span>
                                                <span>{{ getRoomPlayer(room, 1)?.name || '—' }}</span>
                                            </div>
                                            <span v-else>{{ formatRoomPlayer(getRoomPlayer(room, 0)) }}</span>
                                        </td>
                                        <td>
                                            <div v-if="room.mode === 2" class="room-team-members">
                                                <span>{{ formatRoomPlayer(getRoomPlayer(room, 2), false) }}</span>
                                                <span>{{ getRoomPlayer(room, 3)?.name || '—' }}</span>
                                            </div>
                                            <span v-else>{{ formatRoomPlayer(getRoomPlayer(room, 1)) }}</span>
                                        </td>
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
