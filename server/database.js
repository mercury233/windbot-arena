'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createDefaultArenaSettings } = require('./arena-settings');

const activeStatuses = ['queued', 'preparing', 'running', 'settling', 'stopping'];

function now() {
    return new Date().toISOString();
}

function mapCompetitor(row) {
    return {
        botLabel: row.bot_label,
        combo: row.combo,
        deck: row.deck,
        dialog: row.dialog,
        endpointHost: row.endpoint_host,
        endpointPort: row.endpoint_port,
        executionMode: row.execution_mode,
        flee: row.flee,
        games: row.observed_games,
        id: row.id,
        lose: row.lose,
        rankName: row.rank_name,
        slot: row.slot,
        source: row.source,
        win: row.win,
    };
}

function mapRunRow(row) {
    return {
        config: JSON.parse(row.config_json),
        createdAt: row.created_at,
        error: row.error,
        finishedAt: row.finished_at,
        gamesPerMatchup: row.games_per_matchup,
        id: row.id,
        kind: row.kind,
        latestRankAt: row.latest_rank_at,
        launchedGames: row.launched_games,
        roomCount: row.room_count,
        startedAt: row.started_at,
        status: row.status,
        stopReason: row.stop_reason,
        totalGames: row.total_games,
    };
}

class ArenaDatabase {
    constructor(databasePath) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.databasePath = databasePath;
        this.db = new Database(databasePath);
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.migrate();
        this.initializeSettings();
        this.db.exec('PRAGMA optimize');
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
        `);
        const migrationDir = path.join(__dirname, 'migrations');
        const applied = new Set(
            this.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
        );
        for (const fileName of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
            if (applied.has(fileName)) {
                continue;
            }
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.exec(fs.readFileSync(path.join(migrationDir, fileName), 'utf8'));
                this.db.prepare(
                    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
                ).run(fileName, now());
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        }
    }

    close() {
        this.db.close();
    }

    initializeSettings() {
        this.db.prepare(`
            INSERT OR IGNORE INTO arena_settings (singleton, settings_json, updated_at)
            VALUES (1, ?, ?)
        `).run(JSON.stringify(createDefaultArenaSettings()), now());
    }

    getArenaSettings() {
        const row = this.db.prepare(`
            SELECT settings_json, updated_at FROM arena_settings WHERE singleton = 1
        `).get();
        return {
            settings: JSON.parse(row.settings_json),
            updatedAt: row.updated_at,
        };
    }

    saveArenaSettings(settings) {
        const updatedAt = now();
        this.db.prepare(`
            UPDATE arena_settings SET settings_json = ?, updated_at = ? WHERE singleton = 1
        `).run(JSON.stringify(settings), updatedAt);
        return { settings, updatedAt };
    }

    transaction(callback) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = callback();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    createRun(run) {
        this.transaction(() => {
            this.db.prepare(`
                INSERT INTO runs (
                    id, kind, status, games_per_matchup, total_games, created_at, config_json
                ) VALUES (?, ?, 'queued', ?, ?, ?, ?)
            `).run(
                run.id,
                run.kind,
                run.gamesPerMatchup,
                run.matchups.length * run.gamesPerMatchup,
                run.createdAt,
                JSON.stringify(run.config),
            );
            const insertMatchup = this.db.prepare(`
                INSERT INTO matchups (run_id, ordinal, label, ai_level, target_games)
                VALUES (?, ?, ?, ?, ?)
            `);
            const insertCompetitor = this.db.prepare(`
                INSERT INTO competitors (
                    matchup_id, slot, source, deck, bot_label, rank_name, dialog,
                    execution_mode, endpoint_host, endpoint_port
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            run.matchups.forEach((matchup, index) => {
                const result = insertMatchup.run(
                    run.id,
                    index,
                    matchup.label,
                    matchup.aiLevel,
                    run.gamesPerMatchup,
                );
                const matchupId = Number(result.lastInsertRowid);
                for (const competitor of matchup.competitors) {
                    insertCompetitor.run(
                        matchupId,
                        competitor.slot,
                        competitor.source,
                        competitor.deck,
                        competitor.botLabel,
                        competitor.rankName,
                        competitor.dialog,
                        competitor.executionMode,
                        competitor.endpointHost,
                        competitor.endpointPort,
                    );
                }
            });
            this.addEvent(run.id, 'info', 'created', `已创建 ${run.matchups.length} 个卡组`);
        });
        return this.getRun(run.id);
    }

    addEvent(runId, level, eventType, message) {
        this.db.prepare(`
            INSERT INTO run_events (run_id, level, event_type, message, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(runId, level, eventType, message, now());
    }

    setRunStatus(runId, status, fields = {}) {
        const allowed = new Map([
            ['error', 'error'],
            ['finishedAt', 'finished_at'],
            ['latestRankAt', 'latest_rank_at'],
            ['startedAt', 'started_at'],
            ['stopReason', 'stop_reason'],
        ]);
        const assignments = ['status = ?'];
        const values = [status];
        for (const [key, value] of Object.entries(fields)) {
            if (!allowed.has(key)) {
                throw new Error(`不支持更新 runs.${key}`);
            }
            assignments.push(`${allowed.get(key)} = ?`);
            values.push(value);
        }
        values.push(runId);
        this.db.prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    }

    setRoomCount(runId, roomCount) {
        this.db.prepare('UPDATE runs SET room_count = ? WHERE id = ?').run(roomCount, runId);
    }

    recordLaunch(runId, matchupIds) {
        this.transaction(() => {
            const incrementMatchup = this.db.prepare(
                'UPDATE matchups SET launched_games = launched_games + 1 WHERE id = ?',
            );
            for (const matchupId of matchupIds) {
                incrementMatchup.run(matchupId);
            }
            this.db.prepare(
                'UPDATE runs SET launched_games = launched_games + 1 WHERE id = ?',
            ).run(runId);
        });
    }

    recordRank(runId, normalizedRank, rawRank) {
        const receivedAt = now();
        this.transaction(() => {
            this.db.prepare(`
                INSERT INTO rank_reports (run_id, received_at, item_count, payload_json)
                VALUES (?, ?, ?, ?)
            `).run(runId, receivedAt, normalizedRank.length, JSON.stringify(rawRank));
            if (!runId) {
                return;
            }
            const update = this.db.prepare(`
                UPDATE competitors
                SET win = ?, lose = ?, flee = ?, combo = ?, observed_games = ?
                WHERE rank_name = ?
                  AND matchup_id IN (SELECT id FROM matchups WHERE run_id = ?)
            `);
            for (const [rankName, stats] of normalizedRank) {
                update.run(
                    stats.win,
                    stats.lose,
                    stats.flee,
                    stats.combo,
                    stats.games,
                    rankName,
                    runId,
                );
            }
            this.db.prepare('UPDATE runs SET latest_rank_at = ? WHERE id = ?').run(receivedAt, runId);
        });
        return receivedAt;
    }

    getLatestRankAt() {
        const row = this.db.prepare(`
            SELECT received_at FROM rank_reports ORDER BY id DESC LIMIT 1
        `).get();
        return row?.received_at || null;
    }

    getRun(runId) {
        const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!row) {
            return null;
        }
        const run = mapRunRow(row);
        const matchupRows = this.db.prepare(
            'SELECT * FROM matchups WHERE run_id = ? ORDER BY ordinal',
        ).all(runId);
        const competitorRows = this.db.prepare(`
            SELECT competitors.*
            FROM competitors
            JOIN matchups ON matchups.id = competitors.matchup_id
            WHERE matchups.run_id = ?
            ORDER BY matchups.ordinal, competitors.slot
        `).all(runId);
        const competitorsByMatchup = new Map();
        for (const competitor of competitorRows) {
            const items = competitorsByMatchup.get(competitor.matchup_id) || [];
            items.push(mapCompetitor(competitor));
            competitorsByMatchup.set(competitor.matchup_id, items);
        }
        run.matchups = matchupRows.map((matchup) => {
            const competitors = competitorsByMatchup.get(matchup.id) || [];
            if (run.kind === 'challenge' && competitors.length > 1) {
                const opponent = competitors[1];
                competitors[0] = {
                    ...competitors[0],
                    flee: 0,
                    games: opponent.games,
                    lose: opponent.win,
                    win: opponent.lose,
                };
            }
            const observedGames = competitors.length === 1
                ? competitors[0].games
                : competitors.length > 1
                    ? Math.min(...competitors.map((item) => item.games))
                    : 0;
            const decidedGames = competitors.length === 1
                ? competitors[0].win + competitors[0].lose
                : competitors.reduce((sum, item) => sum + item.win, 0);
            return {
                aiLevel: matchup.ai_level,
                competitors,
                id: matchup.id,
                label: matchup.label,
                launchedGames: matchup.launched_games,
                observedGames,
                targetGames: matchup.target_games,
                currentWinRate: decidedGames === 0 ? 0 : competitors[0].win / decidedGames,
            };
        }).sort((left, right) => {
            if (left.aiLevel === null) {
                return right.aiLevel === null ? left.label.localeCompare(right.label) : 1;
            }
            if (right.aiLevel === null) {
                return -1;
            }
            return right.aiLevel - left.aiLevel || left.label.localeCompare(right.label);
        });
        const observedGames = run.matchups.reduce((sum, item) => sum + item.observedGames, 0);
        run.observedGames = run.kind === 'ranking'
            ? run.matchups.reduce((sum, item) => sum + (item.competitors[0]?.win || 0), 0)
            : observedGames;
        run.events = this.db.prepare(`
            SELECT * FROM (
                SELECT id, level, event_type, message, created_at
                FROM run_events
                WHERE run_id = ?
                ORDER BY id DESC
                LIMIT 30
            ) ORDER BY id
        `).all(runId).map((event) => ({
            at: event.created_at,
            id: event.id,
            level: event.level,
            message: event.message.replaceAll('对局组', '卡组'),
            type: event.event_type,
        }));
        return run;
    }

    listRuns(limit = 30, offset = 0) {
        const rows = this.db.prepare(`
            SELECT runs.*, COUNT(matchups.id) AS matchup_count
            FROM runs
            LEFT JOIN matchups ON matchups.run_id = runs.id
            GROUP BY runs.id
            ORDER BY runs.created_at DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);
        return rows.map((row) => ({
            ...mapRunRow(row),
            matchupCount: row.matchup_count,
        }));
    }

    getRunCount() {
        return Number(this.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count);
    }

    findActiveRun() {
        const placeholders = activeStatuses.map(() => '?').join(', ');
        const row = this.db.prepare(`
            SELECT * FROM runs
            WHERE status IN (${placeholders})
            ORDER BY created_at DESC
            LIMIT 1
        `).get(...activeStatuses);
        return row ? mapRunRow(row) : null;
    }

    markActiveRunsInterrupted() {
        const placeholders = activeStatuses.map(() => '?').join(', ');
        const interruptedAt = now();
        return this.transaction(() => {
            const activeRuns = this.db.prepare(`
                SELECT id FROM runs WHERE status IN (${placeholders})
            `).all(...activeStatuses);
            if (activeRuns.length === 0) {
                return 0;
            }
            this.db.prepare(`
                UPDATE runs
                SET status = 'interrupted', finished_at = ?,
                    stop_reason = 'Arena 服务进程已重新启动'
                WHERE status IN (${placeholders})
            `).run(interruptedAt, ...activeStatuses);
            const insertEvent = this.db.prepare(`
                INSERT INTO run_events (run_id, level, event_type, message, created_at)
                VALUES (?, 'warning', 'interrupted', 'Arena 服务进程已重新启动，任务已中断', ?)
            `);
            for (const run of activeRuns) {
                insertEvent.run(run.id, interruptedAt);
            }
            return activeRuns.length;
        });
    }
}

module.exports = { ArenaDatabase, activeStatuses };
