# WindBot Arena 项目说明

WindBot Arena 是一个自托管的 Node.js 对战实验控制台。它通过网页管理实验，调用两套 WindBot Server 向专用 SRVPro 创建约战模式对局，接收 SRVPro 排行回报，并把配置、实验过程和统计保存到 SQLite。

## 技术结构

- `client/`：Vue 3 + Naive UI 前端，通过同源 JSON API 和 Server-Sent Events 与服务端通信。
- `server/app.js`：网站、API、排行 POST 和实时事件入口。
- `server/arena-service.js`：SRVPro 重启、WindBot 生命周期、房间调度及结果等待。
- `server/arena-settings.js`：存储在 SQLite 中的业务配置模型、校验和敏感字段脱敏。
- `server/database.js` 与 `server/migrations/`：SQLite 数据访问和当前初始结构。
- `server/bot-config.js`：解析本地文件或远程模式粘贴的 `bot.conf`。

服务启动阶段只有监听地址、HTTP 端口和 SQLite 路径属于环境基础信息。SRVPro、WindBot 和调度参数都应通过网页配置并保存在 SQLite，不要重新引入 `settings.js` 一类项目配置文件。

WindBot 有两种运行方式：

- 本地模式：Arena 负责启动和关闭 `WindBot.exe`，并直接读取本地 `bot.conf`。
- 远程模式：用户手动运行 WindBot Server，Arena 只调用远程 HTTP 端点；由于无法读取远端文件系统，`bot.conf` 内容由用户在网页粘贴并保存在 SQLite。

Arena 为每组 Bot 生成 `M#123456789` 形式的唯一约战房名并传给双方。SRVPro 会保证相同房名的双方进入同一房间，并把普通约战结果记录到独立的 `private_duel` 累计排行。约战房名不是用户配置。当前胜负统计来源仍是 SRVPro 排行 POST。

## 对局配对与统计限制

- 每组 Bot 使用相同的唯一约战房名，因此可以保证组内双方进入同一房间；不同组不得复用房名。
- WindBot Server 的 HTTP 请求只能确认某一方已接受启动请求，无法直接撤销已经加入的 Bot；若任一方启动失败或超时，Arena 应使用 SRVPro 的关房 API 清理该组唯一房间。只有关房也失败时，先加入的一方才会暂时留在不会与后续对局错配的孤立房间。
- 当前没有独立的逐局结果来源，胜负只能使用 SRVPro 的累计约战排行回报。

## 手动读取 SQLite 胜率

默认数据库是 `data/arena.sqlite`。可在项目根目录使用项目依赖 `better-sqlite3` 以只读方式打开数据库；不要直接读取已废弃的预计算胜率字段。`competitors.slot = 1` 是新版，`slot = 2` 是旧版。界面中的新版胜率统一按“新版胜场 /（新版胜场 + 旧版胜场）”计算，`flee` 只作为异常次数单独查看，不要再次加入分母而重复惩罚。

读取最新任务的总体胜率：

```sql
WITH latest_run AS (
    SELECT id FROM runs ORDER BY created_at DESC LIMIT 1
)
SELECT
    latest_run.id AS run_id,
    SUM(CASE WHEN competitors.slot = 1 THEN competitors.win ELSE 0 END) AS current_wins,
    SUM(CASE WHEN competitors.slot = 2 THEN competitors.win ELSE 0 END) AS old_wins,
    ROUND(
        100.0 * SUM(CASE WHEN competitors.slot = 1 THEN competitors.win ELSE 0 END)
        / NULLIF(SUM(competitors.win), 0),
        1
    ) AS current_win_rate
FROM latest_run
JOIN matchups ON matchups.run_id = latest_run.id
JOIN competitors ON competitors.matchup_id = matchups.id
GROUP BY latest_run.id;
```

读取最新任务中每个卡组的胜率与完成次数：

```sql
WITH latest_run AS (
    SELECT id FROM runs ORDER BY created_at DESC LIMIT 1
)
SELECT
    matchups.label AS deck,
    matchups.ai_level,
    MIN(competitors.observed_games) AS observed_games,
    MAX(CASE WHEN competitors.slot = 1 THEN competitors.win END) AS current_wins,
    MAX(CASE WHEN competitors.slot = 2 THEN competitors.win END) AS old_wins,
    ROUND(
        100.0 * MAX(CASE WHEN competitors.slot = 1 THEN competitors.win END)
        / NULLIF(SUM(competitors.win), 0),
        1
    ) AS current_win_rate
FROM latest_run
JOIN matchups ON matchups.run_id = latest_run.id
JOIN competitors ON competitors.matchup_id = matchups.id
GROUP BY matchups.id, matchups.label, matchups.ai_level
ORDER BY matchups.ai_level IS NULL, matchups.ai_level DESC, matchups.label;
```

## 开发要求

- 项目正在积极开发中，不要考虑可迁移性，不要编写兼容旧版、自动升级旧配置或升级旧数据库的代码。数据结构改变时直接修改当前初始迁移；最多对少量确有价值的配置做一次性手动迁移。
- 用户在配置中提供的 SRVPro 仅用于本项目，可以随意连接、查询、重启和清理房间，不需要保护其中的其他任务。
- 同一时间只运行一个实验，因为 SRVPro 排行、房间池和两套 WindBot 端点都是共享资源。
- 运行记录不得保存 SRVPro 管理密码或排行密钥；配置读取 API 也不得把这些值返回浏览器。
- 本地模式启动的进程必须由 Arena 在任务结束、失败、停止或服务关闭时清理；远程模式的进程不归 Arena 管理。
- NAS/反向代理部署保持同源 API。排行接收路径属于 SQLite 业务配置，Arena 只在当前配置的路径接受排行 POST，并依靠 `accessKey` 校验；普通控制台应由反向代理保护，排行路径可单独放行。

## 关联源码

在开发中，可以读取以下项目的源码。相对本项目根目录：

- `../ygopro-server`：SRVPro 源码。排行回报行为参考 `ygopro-server.coffee`（编译产物为 `ygopro-server.js`）和 `data/default_config.json`；`post_match_scores` 是原样请求的完整 URL，表单字段为 `accesskey` 与 JSON 字符串 `rank`。
- `../windbot`：WindBot 源码。ServerMode 的 HTTP 请求协议参考 `Program.cs`，卡组与运行资源也以该项目的实现为准。

## 验证重点

- 修改配置模型时，覆盖配置校验、敏感字段脱敏和 SQLite 持久化测试。
- 修改对局构建时，同时覆盖本地与远程 WindBot，确认卡组交集、Dialog 和端点正确。
- 修改调度时，不要在测试中真实重启 SRVPro 或启动 WindBot；使用单元测试和不访问外部服务的 HTTP 冒烟检查。
- 前端改动至少运行 `npm.cmd run build`，后端与数据层改动至少运行 `npm.cmd test`。
