# AI 模拟狼人杀研究平台

> 面向 AI 行为与博弈研究的狼人杀模拟平台：为每个座位配置不同的 AI 模型，自动进行完整狼人杀对局，以「上帝视角」实时观察，并沉淀分析报告、经验指南、胜率推测与量化人格研究。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## ✨ 核心特性

- **多模型对战**：每个座位独立配置 AI 提供方（Kimi / OpenAI / DeepSeek / Anthropic / 自定义 OpenAI 兼容端点）与 API Key。
- **完整狼人杀规则**：11 种版型；警长竞选/退水、狼人自爆、白日交刀、屠边、平票 PK；预言家/女巫/猎人/守卫/白痴/骑士/摄梦人/守墓人/猎魔人/乌鸦/通灵师等 19 种角色。
- **上帝视角实时观察**：事件流直播、AI 心理活动（thought）、阶段呼吸灯、阵营胜率推测条。
- **赛后研究**：心理学 × 博弈论分析报告、经验指南蒸馏、MVP/SVP 评选、赛后讨论。
- **人格研究库（铸魂师）**：把现实/虚构人物蒸馏为量化人格参数卡（大五/依恋/黑暗四联/认知偏差/防御机制/情绪调节/SDT），三步 AI 铸造；对局中运行「心镜→涌现」双程人格管线。
- **赛前图书馆学习**：上传资料，开局前各座位 AI 自主学习并形成心得注入对局。
- **对局回放**：历史对局按真实节奏回放（倍速/跳章/拖拽）。
- **断点恢复**：崩溃后经决策日志重放自动恢复续跑。

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 7 · TypeScript · Tailwind CSS v3 · shadcn/ui · tRPC |
| 后端 | Hono · tRPC · Drizzle ORM（MySQL/TiDB 与 SQLite 双方言） |
| 引擎 | TypeScript 生成器 Flow（`advance()`/`decide()` 驱动，事件缓冲） |
| 桌面端 | Electron（本地 SQLite，数据不出本机） |
| 测试 | Vitest |

## 📁 目录结构

```
.
├── api/          # 后端：引擎 / AI 接入 / 人格管线 / 查询层 / tRPC 路由
├── contracts/    # 前后端共享类型契约（唯一事实源）
├── db/           # Drizzle schema（MySQL ↔ SQLite 双方言镜像）
├── desktop/      # Electron 桌面客户端
├── scripts/      # 运维 / 端到端测试脚本
├── src/          # 前端（页面 / 组件 / hooks / providers）
└── public/       # 静态资源
```

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20
- 一个 MySQL 实例（云端部署用）；或使用桌面客户端（内置 SQLite，免 MySQL）

### 安装与配置

```bash
npm install
cp .env.example .env   # 然后填写 APP_ID / APP_SECRET / DATABASE_URL / PRESET_SECRET
```

### 启动客户端

本项目有**两种客户端**，任选其一：

**① Web 客户端（浏览器）** —— 前后端一体，适合开发调试：

```bash
npm run dev            # 启动后浏览器访问 http://localhost:3000
```

**② 桌面客户端（Electron）** —— 本地 SQLite、数据不出本机，见下文「🖥️ 桌面客户端」。

> 注意：浏览器访问的 `/` 由 `dist/public` 生产构建供给；改前端后需 `npx vite build`，改后端需重建 `dist/boot.js`（或直接 `npm run build` 全量构建）。

### 测试与检查

```bash
npx vitest run         # 全量测试
npx tsc -b --force     # 类型检查
npm run build          # 构建前端 + 后端产物
```

## 🖥️ 桌面客户端

桌面客户端把对局数据保存在本机 SQLite，不依赖云端数据库。**打开方式如下：**

### 🚀 一键安装（推荐，Windows）

双击项目根目录的 **`install-client.bat`**，脚本会自动完成「安装依赖 → 构建 → 打包安装程序」全流程，最后弹出 `release` 目录：

- `desktop\release\AI狼人杀研究平台-<版本号>-setup.exe` —— **安装版**（安装向导里可自选安装目录）
- `desktop\release\AI狼人杀研究平台-<版本号>-portable.exe` —— 便携版（免安装，双击即用）

> 前提：本机已安装 Node.js ≥ 20（脚本会自动检测）。

### 开发模式启动

```bash
# 1. 安装依赖（根目录 + 桌面端各装一次）
npm install
cd desktop && npm install && cd ..

# 2. 构建产物（前端 dist/public + 后端 dist/boot.js）
npm run build

# 3. 启动桌面客户端
npm run app:start
```

### 打包成便携 exe

```bash
npm run app:pack        # → desktop/release/AI狼人杀研究平台-<版本号>-portable.exe（双击即可运行）
```

> **首次登录**：桌面端首启会用 `OWNER_EMAIL`（默认 `owner@example.com`）自动建 owner 账户；初始密码在 `desktop-config.json` 的 `ownerPassword` 字段（首启随机生成）。
> **环境要求**：桌面端依赖 Electron 内嵌的 Node（`node:sqlite`），构建需 Node.js ≥ 20。

## ⚙️ 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ID` | ✅ | 应用标识 |
| `APP_SECRET` | ✅ | JWT 会话签名密钥 |
| `DATABASE_URL` | MySQL 部署时必填 | MySQL 连接串；`DB_DIALECT=sqlite` 时不需要 |
| `PRESET_SECRET` | ✅ | API Key 存档的 AES-256-GCM 加密密钥 |
| `DB_DIALECT` | 可选 | `sqlite` 时走本地 SQLite（桌面端） |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | 可选 | 桌面端 owner 账户（不设密码则随机生成） |
| `AI_TIMEOUT_MS` / `AI_DECISION_DEADLINE_MS` | 可选 | AI 调用超时 / 决策预算调优 |

## ⚠️ 免责声明

- 本平台仅做研究与教学用途；各座位 AI 的 **API Key 由用户自备**，费用与合规责任由使用者承担。
- AI 生成的对局发言、分析报告、人格解读可能存在错误或偏见，仅供研究参考。

## 📄 License

[MIT](LICENSE)
