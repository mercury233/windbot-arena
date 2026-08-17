# WindBot Arena

WindBot Arena 是面向 [WindBot](https://github.com/IceYGO/windbot) 的自托管自动对战实验控制台，使用专用的 [arena-srvpro](https://github.com/mercury233/arena-srvpro) 实例承载对局。

通过网页即可创建实验、查看进度和导出结果，配置与运行记录保存在 SQLite。

项目将开发者希望验证的 WindBot 称为“新版”，将用于对照的基线版本称为“旧版”。两者可以是不同的 AI 策略或卡组；新旧回归会让它们使用同名卡组反复对战，通过胜率和异常记录判断改动是否造成退化。

## 实验模式

- **新旧回归**：新版和旧版使用同名卡组进行指定局数的对战；
- **卡组挑战**：新版或旧版的指定卡组依次挑战选中的对手；
- **双打冒烟**：从选中卡组中随机抽取四个卡组组队双打；
- **胜率排行**：从选中卡组中持续随机配对。

## 安装与启动

环境要求：

- Node.js 20.19 或更高版本；
- SQLite 数据目录可持久写入；
- 使用 Arena 专用版本的 SRVPro；
- 本地 WindBot 模式需要系统能直接运行 `WindBot.exe`。

安装、构建并启动：

```powershell
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3000`，在“系统配置”中填写所需信息。

服务启动会读取三个基础环境变量：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WINDBOT_ARENA_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `WINDBOT_ARENA_PORT` | `3000` | 网站和 API 端口 |
| `WINDBOT_ARENA_DATABASE` | `data/arena.sqlite` | SQLite 文件路径 |

## WindBot 配置

- **本地模式**：Arena 负责启停 `WindBot.exe`，需要填写运行目录、`bot.conf` 路径和服务端口。
- **远程模式**：用户自行运行 WindBot Server，Arena 需要其地址、端口，以及粘贴或通过 URL 提供的 `bot.conf`。

新版和旧版可以分别使用本地或远程模式，但不能指向同一个服务端点；新旧回归和使用旧版挑战者的卡组挑战需要两套 WindBot，其他模式只需要新版 WindBot。

## 结果统计

需要胜负结果的实验使用 SRVPro 累计排行；新旧回归中的“新版胜率”为 `新版胜场 /（新版胜场 + 旧版胜场）`，卡组挑战同理计算挑战者胜率，逃跑则单独展示。双打冒烟不统计胜率。

## 自托管

建议仅在 NAS 或容器网络中监听，由 Nginx、Caddy 等反向代理提供 HTTPS 和域名。

- 项目没有内置登录，不要将服务端口直接暴露到公网；应通过反向代理登录、单点登录或私有网络保护。
- 反向代理需要支持实时连接并关闭响应缓冲。
- 将 `data/` 挂载到持久卷并定期备份。

## 开发

```powershell
npm run dev
npm test
npm run build
```
