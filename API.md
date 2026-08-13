# WindBot Arena 只读任务 API

本文档定义 WindBot Arena 对外提供的只读任务数据 API。当前公开范围仅包括：

- 查询任务列表；
- 查询活动任务；
- 查询单个任务的完整数据。

其他 `/api` 路径属于 Arena 控制台的内部管理接口。即使能够访问，也不属于本文档承诺的公开 API，尤其不应由外部程序调用创建任务、停止任务、修改配置或刷新配置的接口。

## 基本约定

API 与 Arena 网页使用同一个来源。假设网页地址为：

```text
https://arena.example.com/
```

则 API 基础地址为：

```text
https://arena.example.com/api
```

所有普通响应均为 JSON，时间字段均为 ISO 8601 格式的 UTC 时间，例如 `2026-08-13T08:30:00.000Z`。响应带有 `Cache-Control: no-store`，调用方不应依赖 HTTP 缓存。

当前应用本身不要求 API Key。如果站点前方的反向代理配置了登录、Basic Auth 或其他访问控制，API 请求也必须携带对应凭据。

服务端目前没有启用跨域资源共享（CORS）。地址栏访问、curl 和服务端程序不受影响；其他域名中的浏览器脚本应通过同源反向代理访问。

建议调用方忽略不认识的响应字段，以便兼容后续新增数据。

## 快速开始

直接在浏览器中查询最近任务：

```text
https://arena.example.com/api/runs?limit=10&offset=0
```

使用 curl：

```bash
curl "https://arena.example.com/api/runs?limit=10&offset=0"
```

查询指定任务：

```bash
curl "https://arena.example.com/api/runs/42cc5a41-3b25-46e5-b010-9cf47c9a61ea"
```

在与 Arena 同源的网页脚本中查询：

```js
const response = await fetch('/api/runs?limit=10&offset=0');
if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
}
const { runs, total } = await response.json();
```

## 查询任务列表

```http
GET /api/runs?limit=30&offset=0
```

任务按创建时间从新到旧排列。

### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer | `30` | 返回条数，取值范围为 1–100 |
| `offset` | integer | `0` | 跳过的任务数量，不得小于 0 |

### 响应示例

```json
{
  "runs": [
    {
      "config": {
        "duelServer": "srvpro.lan:7911",
        "selection": "selected",
        "srvproId": "srvpro-1",
        "srvproName": "SRVPro 1",
        "targetDeck": null,
        "windbots": {
          "current": { "endpoint": "127.0.0.1:2399", "mode": "local" },
          "old": { "endpoint": "windbot-old.lan:2398", "mode": "remote" }
        }
      },
      "createdAt": "2026-08-13T08:30:00.000Z",
      "deckName": "Dragon",
      "error": null,
      "finishedAt": "2026-08-13T09:10:00.000Z",
      "gamesPerMatchup": 100,
      "id": "42cc5a41-3b25-46e5-b010-9cf47c9a61ea",
      "kind": "regression",
      "latestRankAt": "2026-08-13T09:10:00.000Z",
      "launchedGames": 100,
      "matchupCount": 1,
      "roomCount": 0,
      "srvproId": "srvpro-1",
      "startedAt": "2026-08-13T08:30:08.000Z",
      "status": "completed",
      "stopReason": "测试已完成",
      "totalGames": 100
    }
  ],
  "total": 1
}
```

`runs` 中的记录是任务摘要，不包含 `matchups`、`observedGames` 和 `events`。需要胜负统计时，应继续请求单个任务接口。`total` 是全部任务数量，不受 `limit` 和 `offset` 影响。

`deckName` 只用于列表摘要；完整卡组和对阵信息以单个任务接口的 `matchups` 为准。

## 查询活动任务

```http
GET /api/runs/active
```

返回所有 SRVPro 实例上尚未结束的任务，按创建时间从新到旧排列。由于不同 SRVPro 可以并行运行，`runs` 可能包含多个任务。

响应结构为 `{ "runs": RunDetail[] }`，其中每个任务对象与单个任务接口中的 `run` 使用相同的完整结构。

没有活动任务时返回：

```json
{
  "runs": []
}
```

以下状态属于活动状态：

| 状态 | 含义 |
| --- | --- |
| `preparing` | 正在准备环境 |
| `running` | 正在对局 |
| `settling` | 已停止调度，正在等待结果稳定 |
| `stopping` | 正在停止 |

## 查询单个任务

```http
GET /api/runs/{id}
```

成功时返回：

```json
{
  "run": {
    "config": {
      "duelServer": "srvpro.lan:7911",
      "selection": "selected",
      "srvproId": "srvpro-1",
      "srvproName": "SRVPro 1",
      "targetDeck": null,
      "windbots": {
        "current": { "endpoint": "127.0.0.1:2399", "mode": "local" },
        "old": { "endpoint": "windbot-old.lan:2398", "mode": "remote" }
      }
    },
    "createdAt": "2026-08-13T08:30:00.000Z",
    "error": null,
    "events": [
      {
        "at": "2026-08-13T08:30:00.000Z",
        "id": 101,
        "level": "info",
        "message": "已创建 1 个卡组",
        "type": "created"
      }
    ],
    "finishedAt": null,
    "gamesPerMatchup": 100,
    "id": "42cc5a41-3b25-46e5-b010-9cf47c9a61ea",
    "kind": "regression",
    "latestRankAt": "2026-08-13T08:45:00.000Z",
    "launchedGames": 40,
    "matchups": [
      {
        "aiLevel": 4,
        "competitors": [
          {
            "botLabel": "Dragon",
            "combo": 3,
            "deck": "Dragon",
            "dialog": null,
            "endpointHost": "127.0.0.1",
            "endpointPort": 2399,
            "executionMode": "local",
            "flee": 1,
            "games": 37,
            "id": 201,
            "lose": 15,
            "rankName": "新-Dragon",
            "slot": 1,
            "source": "current",
            "win": 22
          },
          {
            "botLabel": "Legacy Dragon",
            "combo": 2,
            "deck": "Dragon",
            "dialog": null,
            "endpointHost": "windbot-old.lan",
            "endpointPort": 2398,
            "executionMode": "remote",
            "flee": 0,
            "games": 37,
            "id": 202,
            "lose": 22,
            "rankName": "旧-Dragon",
            "slot": 2,
            "source": "old",
            "win": 15
          }
        ],
        "currentWinRate": 0.5945945945945946,
        "id": 301,
        "label": "Dragon",
        "launchedGames": 40,
        "observedGames": 37,
        "targetGames": 100
      }
    ],
    "observedGames": 37,
    "roomCount": 3,
    "srvproId": "srvpro-1",
    "startedAt": "2026-08-13T08:30:08.000Z",
    "status": "running",
    "stopReason": null,
    "totalGames": 100
  }
}
```

任务不存在时返回 HTTP `404`：

```json
{
  "error": "测试记录不存在"
}
```

### 任务字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务 UUID |
| `kind` | string | `regression`、`challenge` 或 `ranking` |
| `status` | string | 当前任务状态 |
| `srvproId` | string | 使用的 SRVPro 实例 ID |
| `config` | object | 创建任务时保存的环境和选择快照 |
| `gamesPerMatchup` | integer | 每个卡组或对手的计划局数；排行任务为 0 |
| `totalGames` | integer | 计划总局数；无限排行任务为 0 |
| `launchedGames` | integer | 已调度的对局组数量 |
| `observedGames` | integer | 已从累计排行确认的对局数量 |
| `roomCount` | integer | 最近一次查询到的 SRVPro 房间数 |
| `createdAt` | string | 创建时间 |
| `startedAt` | string \| null | 开始运行时间 |
| `finishedAt` | string \| null | 结束时间 |
| `latestRankAt` | string \| null | 最近一次成功读取排行的时间 |
| `stopReason` | string \| null | 停止或完成原因 |
| `error` | string \| null | 失败详情 |
| `matchups` | array | 卡组或对阵统计 |
| `events` | array | 最近最多 30 条任务事件，按时间正序排列 |
| `challengeTargetFlee` | integer | 仅挑战任务提供，挑战者累计异常次数 |

终态包括：

| 状态 | 含义 |
| --- | --- |
| `completed` | 正常完成 |
| `stopped` | 被用户停止 |
| `failed` | 执行失败，详情见 `error` |
| `interrupted` | Arena 进程重启等原因造成任务中断 |

### 对阵字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 对阵记录 ID |
| `label` | string | 卡组或对手的显示名称 |
| `aiLevel` | integer \| null | AI 等级；无法识别时为 `null` |
| `targetGames` | integer | 计划局数；排行任务为 0 |
| `launchedGames` | integer | 已调度次数 |
| `observedGames` | integer | 已确认的胜负局数 |
| `currentWinRate` | number | 第一方胜率，范围为 0–1，不是百分数 |
| `competitors` | array | 参赛方统计 |

`currentWinRate` 的分母只包含双方胜场，不包含 `flee`。例如值 `0.5946` 表示约 `59.46%`。没有已判定对局时该字段为 `0`。

### 参赛方字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 参赛方记录 ID |
| `slot` | integer | 对阵位置，取值为 1 或 2 |
| `source` | string | 参赛方来源，例如 `current`、`old`、`target` 或 `opponent` |
| `deck` | string | 卡组名称 |
| `botLabel` | string | Bot 显示名称 |
| `rankName` | string | SRVPro 排行中的名称 |
| `dialog` | string \| null | WindBot Dialog |
| `executionMode` | string | `local` 或 `remote` |
| `endpointHost` | string | WindBot 主机地址 |
| `endpointPort` | integer | WindBot 端口 |
| `win` | integer | 胜场 |
| `lose` | integer | 负场 |
| `flee` | integer | 异常断开次数，独立统计，不计入胜率分母 |
| `combo` | integer | SRVPro 返回的 combo 统计 |
| `games` | integer | `win + lose` |

回归任务中 `slot = 1` 是新版，`slot = 2` 是旧版。挑战任务中第一方是挑战者，第二方是对手。排行任务的每个 `matchup` 通常只有一个参赛方。

## 错误响应

错误响应统一使用 JSON：

```json
{
  "error": "错误说明"
}
```

公开查询接口常见状态码：

| 状态码 | 说明 |
| --- | --- |
| `200` | 查询成功 |
| `404` | 指定任务不存在 |
| `500` | Arena 内部错误 |

调用方应先检查 HTTP 状态码，再读取响应内容，不应仅根据 JSON 是否能够解析来判断请求成功。
