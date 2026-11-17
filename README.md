# AI 模拟狼人杀研究平台

> 面向 AI 行为与博弈研究的狼人杀模拟平台：为每个座位配置不同的 AI 模型，自动进行完整狼人杀对局，以「上帝视角」实时观察，并沉淀分析报告、经验指南、胜率推测与量化人格研究。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 📌 当前状态

| 项目 | 状态 |
|---|---|
| 最新客户端 | **v0.3.168**（Windows x64 便携版，未签名） |
| 客户端下载 | [GitHub Releases](https://github.com/Raincy2000/ai-werewolf-research-platform/releases) |
| 开发工作区 | `werewolf-workspace.zip`（五区结构，1.7 MB） |
| 开源源码 | `main` 分支（本仓库，扁平源码镜像） |
| CI | GitHub Actions：check / test / build 通过 |
| 安装版 | 当前 Release 不提供 `setup.exe`；可从源码构建（见下文） |

> 便携版未做代码签名，Windows SmartScreen 可能提示；这是预期行为。客户端数据保存在本机 SQLite，不上传云端。

## ⬇️ 下载与入口

到 [Releases](https://github.com/Raincy2000/ai-werewolf-research-platform/releases) 下载：

| 资产 | 用途 | 适合谁 |
|---|---|---|
| `WerewolfAI-0.3.168-portable.exe` | 免安装客户端，双击即用 | 想直接玩/研究对局 |
| `werewolf-workspace.zip` | 五区开发工作区（源码 + 空 release/records/data/cache + 模板） | 想改代码、做研究、二次开发 |
| `SHA256SUMS` | 校验 Portable 与 Workspace | 需要完整性校验 |

**两种使用方式：**

1. **只想使用客户端**：下载 `WerewolfAI-*-portable.exe`，双击启动。无需 Node.js、无需安装数据库。
2. **想开始开发**：下载 `werewolf-workspace.zip`，解压后按「开发工作区」一节操作。需要 Node.js ≥ 22.5。

> `werewolf-workspace.zip` 文件名不带版本号，版本写在包内 `WORKSPACE-VERSION.txt` / `WORKSPACE.json`。

## 🧭 五区工作区架构

本项目的开发工作区按五个区组织；这五个区是**本地开发结构**，公开仓库 `main` 只承载去敏后的源码镜像，不包含私有的 `records/`、`data/`、`cache/` 内容。

```text
werewolf-workspace/
  dev/       源码区：应用源码、测试、启动脚本、开发者文档
  release/   发布区：版本目录、安装包、源码包、manifest；由脚本生成
  records/   记录区：journal、decisions、runbooks、incidents、releases、research、skills
  data/      数据区：研究数据 raw/sanitized/archive；不是运行时数据库
  cache/     缓存区：可删除、可重建的临时物
```

| 区 | 作用 | 是否进入公开仓库 |
|---|---|---|
| `dev/` | 唯一可写源码区 | 去敏源码以扁平结构进入 `main` |
| `release/` | 发布产物 | 安装包/工作区包进 Releases，不进入源码树 |
| `records/` | 开发记录、决策、runbook | 否（私人/内部） |
| `data/` | 研究数据归档 | 否（私有数据） |
| `cache/` | 临时缓存 | 否 |

这种拆分解决的问题：

- 源码只有一份可写副本（`dev/`），不再维护 `app-clone`/`open-source` 多套镜像；
- 发布物版本化、有 manifest/SHA256、可回溯；
- 开发记录与研究数据不再混在源码目录；
- 缓存与构建产物可安全清理，不污染发布；
- 公开仓库保持干净，只展示可直接阅读/构建的源码。

## 🛠️ 开发工作区（推荐开发者使用）

### 1. 解压

把 `werewolf-workspace.zip` 解压到任意目录，得到上面的五区结构。

### 2. 环境要求

- Windows 10/11
- **Node.js ≥ 22.5**（开发版默认 SQLite，不需要 MySQL）
- 首次安装依赖需要联网

### 3. 安装与启动

```bat
cd dev
npm install
npm --prefix desktop install
start-dev.cmd
```

也可以：

```bat
set NODE_OPTIONS=--experimental-sqlite
npm run dev:desktop
```

`start-dev.cmd` 会优先使用 `dev/tools/node/node.exe`（如果你放了便携 Node），否则回退系统 `node`。开发数据保存在 `dev/.local/data/`，不会进入 Git，也不会上传。

### 4. 常用命令（在 `dev/` 下）

```bat
npm test
npm run check
npm run build
```

- `npm test` 需要 `NODE_OPTIONS=--experimental-sqlite`；`start-dev.cmd` 已自动设置。
- 浏览器版：`npm run dev`（Web 端部署需要 MySQL/TiDB；桌面版默认 SQLite）。
- MySQL 是可选的；见工作区 `dev/tools/README.md`。

### 5. 不要提交什么

`.env`、`.env.local`、`.local/`、`node_modules/`、`dist/`、`desktop/release/`、`desktop/electron-dist/`、`tools/` 二进制、私有 `data/`/`records/`。  
工作区包已经按这些规则排除了。

## 💻 从公开源码构建（本仓库）

本仓库 `main` 是扁平源码镜像，适合阅读源码或从零构建：

```bash
npm install
npm --prefix desktop install
npm run check
npm test
npm run build
```

> Windows 下单独运行 `npm test` 时需设置 `NODE_OPTIONS=--experimental-sqlite`（`start-dev.cmd` 已自动设置）。

Windows 下从源码构建客户端：

```bat
install-client.bat
```

或：

```bat
cd desktop
node pack.mjs
```

产物在 `desktop/release/`。当前 Release 只提供 portable；`setup.exe` 可由本地构建生成，但未随 Release 发布。

## 🚀 发布工作流（维护者）

五区工作区内的发布链：

```powershell
# 1) 版本 + check/test/build + source + 安装包 + workspace 包 + manifest + 校验
powershell -NoProfile -ExecutionPolicy Bypass -File dev\scripts\release.ps1 -Version 0.3.169

# 2) 生成 GitHub 开源 staging（可复现、去敏）
node dev\tools\release\stage-oss.mjs

# 3) 推送源码 + tag + Release（默认 portable + werewolf-workspace.zip）
node dev\tools\release\push-to-github.mjs
```

- `release.ps1` 自动调用 `stage-oss.mjs` 与 `stage-workspace.mjs`，并执行 `verify-release.ps1` 校验。
- GitHub 发布默认上传 **portable + 五区开发工作区包**；`--with-setup` 可追加安装版，`--with-source` 可追加源码包/校验和。
- 发布前会执行 check/test/build、敏感文件门禁、PE/哈希校验。
- 发布记录在 `records/releases/`，开发记录在 `records/journal/`。

## ✨ 核心特性

- **多模型对战**：每个座位独立配置 AI 提供方（Kimi / OpenAI / DeepSeek / Anthropic / 自定义 OpenAI 兼容端点）与 API Key。
- **完整狼人杀规则**：11 种版型；警长竞选/退水、狼人自爆、白日交刀、屠边、平票 PK；预言家/女巫/猎人/守卫/白痴/骑士/摄梦人/守墓人/猎魔人/乌鸦/通灵师等 19 种角色。
- **犯规裁判**：分析师 AI 实时巡检公开发言（违规亮牌自证 / AI 身份泄露 / 元游戏言论），犯规即终局、对立阵营判胜。
- **上帝视角实时观察**：事件流直播、AI 心理活动（thought）、阶段呼吸灯、阵营胜率推测条。
- **赛后研究**：心理学 × 博弈论分析报告、经验指南蒸馏、MVP/SVP 评选、赛后讨论、人格心理检查。
- **人格研究库（铸魂师）**：把现实/虚构人物蒸馏为量化人格参数卡；对局中运行「心镜→涌现」双程人格管线，跨对局记忆与关系图谱持续演进。
- **赛前图书馆学习**：上传资料，开局前各座位 AI 自主学习并形成心得注入对局。
- **对局回放 / 断点恢复**：按真实节奏回放；崩溃后经决策日志重放恢复。

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 7 · TypeScript · Tailwind CSS v3 · shadcn/ui · tRPC |
| 后端 | Hono · tRPC · Drizzle ORM（MySQL/TiDB 与 SQLite 双方言） |
| 引擎 | TypeScript 生成器 Flow（`advance()`/`decide()` 驱动，事件缓冲） |
| 桌面端 | Electron（本地 SQLite，数据不出本机） |
| 测试 | Vitest |

## 📁 公开仓库结构

```text
.
├── .github/      # CI workflow
├── api/          # 后端：引擎 / AI 接入 / 人格管线 / 查询层 / tRPC 路由
├── contracts/    # 前后端共享类型契约
├── db/           # Drizzle schema（MySQL ↔ SQLite 双方言镜像）
├── desktop/      # Electron 桌面客户端
├── public/       # 静态资源
├── scripts/      # 构建 / 端到端测试脚本
├── src/          # 前端页面 / 组件 / hooks / providers
├── build-backend.mjs
├── install-client.bat
└── package.json
```

> 公开仓库是扁平源码镜像；五区结构只在 `werewolf-workspace.zip` 与本地开发工作区中存在。

## ⚙️ 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ID` | ✅ | 应用标识 |
| `APP_SECRET` | ✅ | JWT 会话签名密钥 |
| `DATABASE_URL` | Web/MySQL 部署必填 | MySQL/TiDB 连接串；`DB_DIALECT=sqlite` 不需要 |
| `PRESET_SECRET` | ✅ | API Key 存档的 AES-256-GCM 加密密钥 |
| `DB_DIALECT` | 可选 | `sqlite` 时走本地 SQLite（桌面端） |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | 可选 | 桌面端 owner 账户（不设密码则随机生成） |
| `AI_TIMEOUT_MS` / `AI_DECISION_DEADLINE_MS` | 可选 | AI 调用超时 / 决策预算调优 |

不要把自己的 `.env`、API Key、生产数据库连接提交到仓库；开发工作区已排除这些文件。

## 🪟 Windows 构建注意

| 问题 | 处理 |
|---|---|
| Node 版本 | 需要 Node ≥ 22.5；`install-client.bat` 可准备便携 Node |
| NSIS 中文路径 | 打包输出走英文临时目录，再复制回 `release` |
| Defender 锁文件 | `pack.mjs` 内置 7za 重试；可先把 Electron 放 `desktop/electron-dist/` |
| `npm run build` 引号 | Windows 下可用 `build-backend.mjs` 分步构建 |

## ⚠️ 免责声明

- 本平台仅做研究与教学用途；各座位 AI 的 **API Key 由用户自备**，费用与合规责任由使用者承担。
- AI 生成的对局发言、分析报告、人格解读可能存在错误或偏见，仅供研究参考。
- 客户端未签名；正式分发前请自行做安全审查/签名。

## 📄 License

[MIT](LICENSE)
