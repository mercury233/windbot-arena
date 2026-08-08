# WindBot 新旧版本对战测试

`test-ai.js` 用于让当前 WindBot 与旧版 WindBot 使用相同卡组批量对战，并接收 SRVPro 定时发送的排行榜数据，对比各卡组的新旧版本胜率。

## 目录约定

脚本根据自身位置推导当前项目路径，不依赖当前工作目录。典型目录结构如下：

```text
windbot/
├─ bin/Release/                 # 当前版本 WindBot
├─ BotWrapper/bot.conf          # 当前版本机器人列表
└─ mytest/
   ├─ test-ai.js
   ├─ settings.example.js       # 提交到 Git 的配置示例
   ├─ settings.js               # 本地真实配置，Git 忽略
   ├─ README.md
   └─ test-ai-results/          # 运行后自动创建

windbot-old/
├─ bot.conf                     # 旧版机器人列表
└─ WindBot/                     # 旧版 WindBot 运行目录
```

## 前置条件

- Node.js 18 或更高版本。
- 当前版本已经构建到 `bin/Release`。
- 旧版运行目录包含 `WindBot.exe`、`Decks`、`Dialogs` 和运行依赖。
- 当前 WindBot HTTP 端口为 `2399`，旧版为 `2398`；Windows URL ACL 必须允许当前账户监听这两个端口。
- 一个测试专用的 SRVPro 服务端。
  - 支持在运行测试前重启。
  - 允许多个同一IP的客户端连接。
  - 将排行榜上限改为1000。
  - 向本机发送排行榜数据。
- 本机 `3000` 端口能够接收 SRVPro 的排行榜 POST；如服务端位于其他机器，还需确认防火墙允许访问。
- 已根据 `settings.example.js` 创建并填写本地 `settings.js`。

首次使用时，在项目根目录执行：

```powershell
Copy-Item mytest/settings.example.js mytest/settings.js
```

然后编辑 `settings.js`，填写 SRVPro 地址、账号密码、排行榜密钥和旧版路径。
`settings.js` 已被 Git 忽略，不会提交真实凭据。

## 使用方法

在项目根目录或 `mytest` 目录运行均可：

```powershell
# 测试两份 bot.conf 中全部可用的共同卡组，每个卡组默认 100 局
node mytest/test-ai.js

# 全部共同卡组，每个卡组 20 局
node mytest/test-ai.js all 20

# 只测试一个卡组，默认 500 局
node mytest/test-ai.js Dragunity

# 指定单一卡组的局数
node mytest/test-ai.js Dragunity 200

# 查看实际参与测试的共同卡组
node mytest/test-ai.js --list-decks

# 只校验路径、配置和卡组交集，不启动程序、不访问网络
node mytest/test-ai.js --dry-run
```

如果当前目录是 `mytest`，将命令中的 `mytest/` 去掉即可。

## 运行流程

正式运行时，脚本会：

1. 分别读取新版 `BotWrapper/bot.conf` 和旧版 `bot.conf`。
2. 排除 `AI_LV1` 及需要人工选择牌组文件的 `SELECT_DECKFILE` 条目，取两份列表的交集。
3. 在 `0.0.0.0:3000` 启动排行榜接收器。
4. 调用 SRVPro 管理 API **重启服务端**。**此操作会关闭当前所有房间**；脚本会等待 API 恢复后再继续。
5. 分别在 `2399` 和 `2398` 启动新旧 WindBot HTTP 服务。
6. 按卡组轮询创建对局，同一卡组的新旧版本成对加入，并交替加入顺序。
7. 接收排行榜数据，输出逐卡组统计和总体汇总。

机器人排行榜名称固定为 `新-<bot.conf 显示名称>` 和 `旧-<bot.conf 显示名称>`，因此重复运行不会不断新增排行榜项目。

## 结果文件

结果保存在：

```text
mytest/test-ai-results/<运行标识>-<卡组或 all>.jsonl
```

文件采用 JSON Lines 格式，每行是一条独立记录，主要类型包括：

- `start`：本次运行配置、卡组及机器人名称映射。
- `server-rebooted`：SRVPro 已重启并恢复。
- `rank`：一次排行榜回报及本次测试相关统计。
- `end`：结束原因、已创建局数和最后统计。

控制台中的“严格胜率”按 `胜 / (胜 + 负 + 逃跑)` 计算，逃跑会视为失败；“胜方占比”只比较新旧版本取得的胜局。

按 `Ctrl+C` 可停止调度。脚本会关闭由它启动的两个 WindBot 进程，并保留已经收到的结果。

## 本地配置

服务器地址、端口、认证信息、运行路径、房间上限、调度间隔和等待时间集中
位于 `settings.js`。这些值不是命令行参数，环境变化时直接修改本地配置。

`settings.example.js` 只提供字段结构和安全示例值，应纳入 Git 管理；新增或删除配置项时，
需要同步更新两个配置文件。
