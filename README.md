# WindBot Arena

WindBot Arena 是自托管的 WindBot 对战实验控制台。目前提供“新版与旧版使用同一卡组批量对战”的回归测试，并把系统配置、运行进度、排行快照和最终统计保存到 SQLite。

Node.js 服务同时负责：

- 提供 Vue + Naive UI 网站、JSON API 和实时事件；
- 重启专用 SRVPro、查询房间并创建 Match 模式对局；
- 管理本地 WindBot 进程，或调用用户手动运行的远程 WindBot Server；
- 在网页配置的路径接收 SRVPro 排行 POST。

## 安装与启动

环境要求：

- Node.js 20.19 或更高版本；
- SQLite 数据目录可持久写入；
- Arena 能通过网络访问 SRVPro 和远程 WindBot；
- 使用本地 WindBot 模式时，Arena 所在系统必须能够直接运行 `WindBot.exe`。

安装、构建并启动：

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

打开 `http://127.0.0.1:3000`，进入“系统配置”填写 SRVPro、两套 WindBot 和调度参数。不再使用 `settings.js` 或配置示例文件。

服务启动只读取三个基础环境变量：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WINDBOT_ARENA_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `WINDBOT_ARENA_PORT` | `3000` | 网站、API 和排行接收端口 |
| `WINDBOT_ARENA_DATABASE` | `data/arena.sqlite` | SQLite 文件路径 |

开发模式：

```powershell
npm.cmd run dev
```

前端开发服务器默认位于 `http://127.0.0.1:5173`，API 代理会读取 `WINDBOT_ARENA_PORT`。

## 网页配置

所有业务配置都存储在 SQLite 的 `arena_settings` 表中，包括：

- SRVPro 地址、端口、管理凭据、排行接收路径、排行密钥和容量限制；
- 新版与旧版 WindBot 的运行模式、HTTP 端点和 `bot.conf`；
- 对局创建速度、轮询间隔和统计等待时间。

管理密码和排行密钥不会由读取 API 返回到浏览器。配置页中的密钥输入框留空会保留已有值。

### 本地 WindBot

本地模式由 Arena 启动并在任务结束时关闭 `WindBot.exe`。需要配置：

- WindBot 运行目录；
- `bot.conf` 路径；
- HTTP Server 端口。

Arena 会使用以下参数启动进程：

```text
WindBot.exe ServerMode=True ServerPort=<配置端口> Chat=False
```

Linux NAS 通常无法直接运行 Windows 的 `WindBot.exe`，除非另行提供兼容运行环境。因此 NAS 部署通常应使用远程模式。

### 远程 WindBot

远程模式由用户在其他主机手动启动 WindBot Server。Arena 只负责检查和调用，不会启动或关闭远端进程。需要配置：

- 远端主机名或 IP；
- WindBot HTTP Server 端口；
- 远端当前使用的完整 `bot.conf` 内容。

Arena 无法读取远端文件系统，因此必须把 `bot.conf` 粘贴到网页。它用于生成可选卡组、机器人显示名称和 Dialog 参数；远端更新配置后应同步更新 Arena。

新版和旧版可以分别选择本地或远程模式，但不能指向同一个 HTTP 端点。

## Match 模式

Arena 固定向 WindBot 发送 `password=M`。这是 SRVPro 随机对战 Match 模式的协议值，用于让服务端统计胜率，不是可配置的房间密码。

当前胜负结果仍以 SRVPro 定时发送的排行为准。将来若改用专用 SRVPro 或直接从 WindBot 收集结果，应作为新的结果来源设计，而不是把 `M` 暴露为普通配置。

界面中的“新版胜率”按 `新版胜场 /（新版胜场 + 旧版胜场）` 计算。正常完成的对局中它与新版自身的胜负统计一致；逃跑作为异常计数单独展示，不再提供含义高度重叠的第二个胜率指标。

## SRVPro 排行回报

SRVPro 使用表单提交排行：

```text
POST https://arena.example.com/srvpro/rank
Content-Type: application/x-www-form-urlencoded

accesskey=<网页中配置的排行接收密钥>
rank=<JSON 排行数组>
```

`post_match_scores` 是完整 URL，SRVPro 不会自行追加路径。其中的路径必须与网页配置的“排行接收路径”完全相同；默认值为 `/`，也可以配置为 `/api/rank` 或其他不与 Arena API 冲突的路径。Arena 只接受当前配置路径上的排行 POST。`rank` 使用 `[名称, 统计对象]` 数组格式。未配置密钥或密钥不匹配时，接口返回 `403`。

配置中的 SRVPro 是 Arena 专用实例。每次测试会直接调用管理接口重启服务并清理其房间，无需保护其他业务房间。

## NAS 与专属域名

建议让 Arena 只在 NAS 或容器网络中监听，由 Nginx、Caddy 或 NAS 自带反向代理提供 HTTPS 和域名。

必须注意：

- 当前项目没有内置用户登录。不要把 3000 端口直接暴露到公网；控制台和普通 API 应由反向代理登录、单点登录或私有网络保护。
- 排行 POST 依靠独立的 `accessKey` 校验。反向代理认证规则应单独放行网页中配置的排行接收路径，并让 SRVPro 的完整回报 URL 使用同一路径。
- 实时状态使用 Server-Sent Events。Nginx 等代理应关闭该连接的响应缓冲；服务已经发送 `X-Accel-Buffering: no`。
- 将 `data/` 挂载到持久卷，并定期备份 `arena.sqlite` 及其 WAL 文件。
- NAS 到 SRVPro、远程 WindBot 的 HTTP 端口必须可达；远程主机还需要正确配置 Windows URL ACL 与防火墙。
- 如果 NAS 是 Linux/ARM，安装 `better-sqlite3` 时可能需要对应架构的预编译包或本地编译工具。

## 数据结构

默认数据库位于 `data/arena.sqlite`，启用 WAL。主要数据包括：

- `arena_settings`：唯一一份当前系统配置；
- `runs`：实验类型、状态、计划和时间；
- `matchups`：实验中的独立对局组；
- `competitors`：双方来源、卡组、运行模式、端点和统计；
- `rank_reports`：SRVPro 原始排行快照；
- `run_events`：准备、调度、停止和错误等关键事件。

项目处于积极开发阶段，不提供数据库升级兼容层。开发期修改表结构后，应使用新库重新开始；确有需要的数据只做一次性手动迁移。

## 项目结构

```text
client/                      Vue + Naive UI 控制台
client/src/SettingsModal.vue 网页配置界面
server/app.js                HTTP API、排行 POST 与静态网站
server/arena-settings.js     业务配置默认值、校验与脱敏
server/arena-service.js      测试生命周期、WindBot 与 SRVPro 调度
server/database.js           SQLite 访问与结果聚合
server/migrations/           当前数据库初始结构
server/bot-config.js         本地/远程 bot.conf 解析
```

验证命令：

```powershell
npm.cmd test
npm.cmd run build
```
