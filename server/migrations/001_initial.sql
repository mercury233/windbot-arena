CREATE TABLE arena_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    games_per_matchup INTEGER NOT NULL,
    total_games INTEGER NOT NULL,
    launched_games INTEGER NOT NULL DEFAULT 0,
    room_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    latest_rank_at TEXT,
    stop_reason TEXT,
    error TEXT,
    config_json TEXT NOT NULL
);

CREATE TABLE matchups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    label TEXT NOT NULL,
    ai_level INTEGER,
    target_games INTEGER NOT NULL,
    launched_games INTEGER NOT NULL DEFAULT 0,
    UNIQUE (run_id, ordinal)
);

CREATE TABLE competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matchup_id INTEGER NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
    source TEXT NOT NULL,
    deck TEXT NOT NULL,
    bot_label TEXT NOT NULL,
    rank_name TEXT NOT NULL,
    dialog TEXT,
    execution_mode TEXT NOT NULL,
    endpoint_host TEXT NOT NULL,
    endpoint_port INTEGER NOT NULL,
    win INTEGER NOT NULL DEFAULT 0,
    lose INTEGER NOT NULL DEFAULT 0,
    flee INTEGER NOT NULL DEFAULT 0,
    combo INTEGER NOT NULL DEFAULT 0,
    observed_games INTEGER NOT NULL DEFAULT 0,
    UNIQUE (matchup_id, slot)
);

CREATE TABLE rank_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    received_at TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_runs_status_created_at ON runs(status, created_at DESC);
CREATE INDEX idx_matchups_run_id ON matchups(run_id, ordinal);
CREATE INDEX idx_competitors_matchup_id ON competitors(matchup_id, slot);
CREATE INDEX idx_rank_reports_run_id_received_at ON rank_reports(run_id, received_at DESC);
CREATE INDEX idx_run_events_run_id_created_at ON run_events(run_id, created_at DESC);
