<a name="top"></a>

# xCloud Subscriber Console

**电信签约与 OCS 运营控制台** · 基于 React / Vite / Go / MongoDB 构建

[![Go 1.24+](https://img.shields.io/badge/Go-1.24%2B-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![Node.js 20.19+](https://img.shields.io/badge/Node.js-20.19%2B-339933?style=flat-square&logo=nodejs&logoColor=white)](https://nodejs.org/)
[![React 19](https://img.shields.io/badge/React-19.2-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![MongoDB](https://img.shields.io/badge/MongoDB-xcloud%20%2B%20xcloud__ops-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://www.mongodb.com/)

xCloud Subscriber Console 是 xCloud 平台的签约与在线计费（OCS）运营控制台。它负责管理 IMSI 签约记录、Profile 模板，以及带审计元数据生命周期管理的网络与平台资源清单，同时覆盖 OCS 资费计划、签约合同、余额账户、批价策略、流量分析、CSV 导入导出、操作日志、本地告警、系统健康检查与基于角色的访问控制。

> **一句话定位**：面向电信运维团队的签约与计费治理平面 —— 生产环境由 Nginx 边缘统一入口，前端为构建后内嵌进 Go 二进制的静态 React SPA，全部生产 API 由 Go 后端独占。

---

<a name="toc"></a>

## 📑 目录

- [🌐 项目简介](#overview)
- [🏗️ 系统架构](#architecture)
  - [生产架构](#arch-production)
  - [本地开发架构](#arch-development)
  - [架构演进状态](#arch-evolution)
- [✨ 核心功能](#features)
- [📡 OCS 管理面状态](#ocs)
- [🧱 技术栈](#stack)
- [🚀 快速开始](#quickstart)
- [⚙️ 环境变量](#env)
- [📜 可用脚本](#scripts)
- [🗄️ 数据与集合](#database)
- [🚢 部署](#deployment)
- [📚 文档索引](#docs)
- [✅ 质量校验](#checks)
- [🔐 角色与权限](#rbac)
- [📞 联系方式](#contact)

---

<a name="overview"></a>

## 🌐 项目简介

| 项 | 值 |
| --- | --- |
| 产品名 | `xCloud` |
| 仓库 | `YGone-001/subscriber-console`（`develop` 分支） |
| 规范前端源码 | `frontend/` — React 19 + TypeScript + Vite SPA |
| 后端 | `backend/` — Go REST API + 内嵌静态 SPA 托管 |
| 生产入口 | Nginx 边缘（唯一对外源站）→ Go `127.0.0.1:18888` |
| 本地开发入口 | Vite `0.0.0.0:13333` → Go `127.0.0.1:18888` |
| 数据库 | MongoDB（`xcloud` + `xcloud_ops`） |

核心域涵盖：IMSI 签约、Profile、OCS、Tariff / Rating、用户管理与认证、审计、告警、系统健康、运营分析。

---

<a name="architecture"></a>

## 🏗️ 系统架构

### 仓库结构

```text
subscriber-console/
├── frontend/          # 规范 React + TypeScript + Vite SPA 源码
├── backend/           # Go REST API + 内嵌静态 SPA 托管
│   ├── cmd/
│   ├── internal/
│   └── go.mod
├── deploy/            # Nginx 生产配置
├── docs/              # 项目文档
│   ├── architecture/
│   ├── database/
│   ├── operations/
│   ├── archive/
│   └── README.md      # 文档权威模型 / 索引
├── scripts/           # 验收测试与运维脚本
├── README.md
├── CLAUDE.md
└── AGENTS.md
```

<a name="arch-production"></a>

### 生产架构

```text
Browser → Nginx（唯一对外源站）
           └── /*, /api/* → Go 127.0.0.1:18888（API + 内嵌静态 React SPA）
```

Nginx 边缘将全部生产公开流量路由至唯一的 Go 上游（`127.0.0.1:18888`）。
Go 后端独占全部生产 API 操作（90 个精确的 METHOD+PATH 注册）、会话认证，以及内嵌静态 React SPA 托管。
Next.js 运行时已完全退役。生产环境需要 Node.js 运行时 = **否**。

<a name="arch-development"></a>

### 本地开发架构

```text
Browser → Vite 开发服务器 0.0.0.0:13333
           └── /api/* → Go 127.0.0.1:18888
```

本地开发时，Vite 开发服务器运行在 `0.0.0.0:13333`，并将 `/api/*` 代理到 `127.0.0.1:18888` 的 Go 后端。
本地开发**不需要** Nginx。

<a name="arch-evolution"></a>

### 架构演进状态

| 维度 | 状态 |
| --- | --- |
| 当前运行时 | Nginx → Go `127.0.0.1:18888`（API + 内嵌静态 SPA） |
| 运行时整合与前端规范化 | ✅ 已完成 |
| 前端视觉与交互一致性恢复 | ✅ 已完成（历史 xCloud 运维界面表现层已前向移植） |
| Next.js 业务后端 | 已退役，不得重建 |
| API 路径 | 保持 `/api/...` 不变 |

- 双权威约定：历史 UI 参考 SHA = `2c40903fea1e56650736ee862e3ddab33d9f64fc`（仅决定外观与交互）；当前架构权威 = 当前 `develop`（决定运行方式）。UI 恢复绝不恢复已退役的 Next 运行时权威。
- 长期方向：模块化运维平台（inventory / topology、workflow、assurance、telemetry、厂商中立 adapter 边界）。逻辑边界先于部署拆分；仅在规模、故障隔离、运维归属或可用性要求时才引入独立服务。

---

<a name="features"></a>

## ✨ 核心功能

### 📇 签约管理

- 签约记录 CRUD、分页、搜索、单个创建、批量创建、CSV 导入与删除。
- 生成 xCloud 兼容的 MongoDB 签约文档。

### 🧩 Profile 模板

- Profile 模板管理，支持版本历史与回滚（restore）。

### 💳 OCS 管理面

- OCS 管理：资费计划（Tariff Plans）、签约合同（Contracts）、余额账户（Balances）、仪表盘。
- Rating Group 管理，用于 OCS 策略模板。

### 📈 运营分析

- 基于 MongoDB 签约文档计算的分析仪表盘。

### 🛡️ 治理与安全

- 直接执行（Direct Execution）运营模型，配合 RBAC、操作日志与 CAS 并发冲突保护。
- 审计日志、告警确认，以及系统文档一致性检查。
- 加固的 JWT 认证：IP + 用户名双重限流、连续 10 次失败自动锁定、响应隐私保护，以及规范化的 `admin` / `operator` / `viewer` 角色（含历史别名归一化）；由 Go 后端权威治理（全部 90 个注册均为 Go 所有，经 Nginx 边缘路由）。

### 👤 用户生命周期管理

- 创建、更新、管理员解锁、软删除、密码重置，以及通过 `sessionVersion` 实现的会话失效。

### 🎨 前端体验

- 中文 / 英文双语界面、主题切换、命令面板，以及响应式仪表盘布局。
- React / Vite 前端已恢复 xCloud 运维界面：带快速过滤的分组侧边栏、头部 NOC sentinel 与通知中心、命令面板、标签栏、面包屑、运维驾驶舱（Operator Dashboard Cockpit），以及共享设计令牌系统。

---

<a name="ocs"></a>

## 📡 OCS 管理面状态

**OCS 管理面已冻结（frozen）。**

| 受管域 | 状态 |
| --- | --- |
| 资费计划（Tariff Plans） | 已冻结 |
| 签约合同（Contract Subscribers） | 已冻结 |
| 余额管理（Balance Management） | 已冻结 |

计费面（Charging Plane）保持冻结且不在范围内。

---

<a name="stack"></a>

## 🧱 技术栈

### 规范前端（SPA）

| 技术 | 版本 / 说明 |
| --- | --- |
| React | 19.2.4 |
| Vite | 8 |
| React Router | 7 |
| TypeScript | 5 |
| Lucide React | 图标 |
| Recharts | 图表 |
| SWR | 客户端数据同步 |

样式为 `frontend/src/styles/` 下的纯 CSS 设计令牌分层（tokens、base、shell、components、pages、utilities）。
静态资源由 `frontend/` 构建后直接内嵌进 Go 后端二进制。

### 后端

| 技术 | 说明 |
| --- | --- |
| Go | 1.24+ |
| 标准库 `net/http` | HTTP 服务 |
| `log/slog` | 结构化日志 |
| `mongo-driver/v2` | MongoDB 驱动 |

### 边缘与存储

| 组件 | 说明 |
| --- | --- |
| Nginx | 唯一对外边缘，单一上游 `xcloud_go` |
| MongoDB | 数据库 `xcloud` + `xcloud_ops` |

### 历史前端

- 已退役（Next.js App Router 退役；原端口 13333 已重新分配给 Vite 本地开发）。

---

<a name="quickstart"></a>

## 🚀 快速开始

生产应用由 Nginx 边缘提供，前端指向 Go `127.0.0.1:18888`。
本地开发时，应用运行在 Vite `0.0.0.0:13333`，代理至 Go `127.0.0.1:18888`。

### 环境要求

| 组件 | 版本 / 说明 |
| --- | --- |
| Go | 1.24+ |
| Node.js | 20.19.0 或更高 |
| MongoDB | 本地或远程实例，需 `xcloud` + `xcloud_ops` 两个库 |
| Nginx | 仅生产边缘需要，本地开发不需要 |

### 组件与端口

```text
MongoDB     xcloud + xcloud_ops
Go backend  127.0.0.1:18888   内部应用服务（API + 内嵌静态 SPA）
Vite dev    0.0.0.0:13333   本地前端开发服务器（/api 代理至 Go）
Nginx edge  生产公网浏览器入口，默认 http://localhost
```

> **端口铁律**：规范端口 `13333` / `18888` 不可被环境变量覆盖，也绝不通过修改端口来"解决"端口占用 —— 先诊断占用者。

### 本地开发流程

```text
1. npm run local:preflight    检查端口/进程归属（只读）
2. 启动 MongoDB
3. npm run local:dev          启动受管的 Go + Vite 开发进程
4. npm run local:doctor       校验本地开发拓扑
5. 浏览 http://localhost:13333
```

### 1. 安装依赖

```bash
# 在仓库根目录：安装 scripts/ 所需的依赖
npm ci
cp .env.example .env
# 继续之前，请在 .env 中填入预期的本地配置值

# 安装前端依赖：
cd frontend
npm ci
cd ..
```

在运行 `npm run mongo:init` 之前，请在根目录 `.env` 中设置相同的强 `JWT_SECRET` 与 `INITIAL_ADMIN_PASSWORD`。初始化脚本会在初始 `admin` 账号不存在时创建它。

### 2. 初始化 MongoDB

```bash
npm run mongo:init
```

### 3. 检查规范端口

```bash
npm run local:preflight
```

只读操作。它会在任何进程启动之前，对端口 13333、18888、27017 的占用者进行分类判定。
绝不要通过修改 13333 / 18888 来"解决"规范端口污染；应先诊断占用者。

### 4. 启动所需服务

自行启动 MongoDB（系统**永不**自动启动它）。

随后启动项目自有的 Go 与 Vite 开发进程：

```bash
npm run local:dev
```

该命令会在 `127.0.0.1:18888` 构建并运行 Go、在 `0.0.0.0:13333` 运行 Vite，并写入进程归属记录。
本地开发不需要 Nginx。

### 5. 验证

```bash
npm run local:status
npm run local:doctor
```

当完整拓扑就绪时，`local:doctor` 会打印 `FULL_STACK_READY`。

### 6. 访问

在浏览器中打开本地应用：

```text
http://localhost:13333
```

### 7. 停止

```bash
npm run local:stop
```

在核验进程归属记录后，仅停止由 `local:dev` 启动的 Go 与 Vite 进程。
它不会停止 MongoDB、系统 Nginx 或任何非本项目进程。

---

<a name="env"></a>

## ⚙️ 环境变量

| 变量 | 说明 |
| --- | --- |
| `MONGODB_URI` | MongoDB 连接 URI，通常为 xCloud MongoDB 主机 |
| `MONGODB_DB` | xCloud 数据数据库名，默认 `xcloud` |
| `MONGODB_XCLOUD_DB` | 可选的 xCloud 数据库显式覆盖项；未设置时回退到 `MONGODB_DB` |
| `MONGODB_APP_DB` | `app_*` 集合所属的应用运维数据库，默认 `xcloud_ops` |
| `MONGODB_MAX_POOL_SIZE` | 可选的连接池最大连接数 |
| `MONGODB_MIN_POOL_SIZE` | 可选的连接池最小连接数 |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | 可选的 MongoDB 选择超时 |
| `JWT_SECRET` | JWT 签名密钥，至少 32 字节 |
| `INITIAL_ADMIN_PASSWORD` | 可选的首个 admin 密码 |

---

<a name="scripts"></a>

## 📜 可用脚本

### 仓库根目录运维脚本

> 先在仓库根目录执行 `npm ci`。

```bash
npm run mongo:init           # 创建 MongoDB 索引
npm run mongo:migrate-app-db # 将 app_* 集合从 xcloud 迁移到应用数据库
npm run mongo:test-core      # 针对临时数据库运行 MongoDB 核心集成冒烟测试
npm run mongo:perf           # 分析关键 MongoDB 查询并标记慢扫描
npm run local:preflight      # 启动任何服务前检查规范端口归属
npm run local:dev            # 启动受管的 Go + Vite 开发进程
npm run local:status         # 报告组件与拓扑状态
npm run local:doctor         # 诊断运行中的本地全栈拓扑
npm run local:stop           # 仅停止由 local:dev 启动的进程
```

### 前端脚本（在 `frontend/` 下执行）

```bash
npm run dev                 # 启动本地 Vite 开发服务器
npm run build               # 构建生产静态 SPA
npm run preview             # 本地预览已构建的 SPA；非生产运行时
npm run lint                # 运行 ESLint
npm run typecheck           # 运行 TypeScript 检查且不产出文件
npm test                    # 运行前端测试
npm run check               # 依次运行 lint、typecheck、测试与构建
```

Production does not start a frontend server.
The production SPA is built from frontend/, staged for Go embedding,
compiled into the Go binary, and served through Nginx -> Go.

生产环境**不**启动前端服务器。
生产 SPA 由 `frontend/` 构建、为 Go 内嵌做暂存、编译进 Go 二进制，并经 Nginx → Go 提供。

> MongoDB 运维脚本默认将 JSON 报告写入 `reports/ops/`。可通过 `OPS_REPORT_DIR` 覆盖输出位置。
>
> 请使用 Node.js 20.19.0 或更高版本。依赖需在仓库根目录与 `frontend/` 中**分别**安装；切勿在二者之间、或跨操作系统共享/复制 `node_modules`。

---

<a name="database"></a>

## 🗄️ 数据与集合

`xcloud` 库存储 HSS 签约数据于 `subscribers`，存储 OCS 预置数据于 `ocs_tariff_plans`、`ocs_subscribers`、`ocs_balances`。

项目自有集合（如 `app_users`、`app_profiles`、`app_audit_logs`、`app_alerts`、`app_rate_limits`、`app_metrics`）位于 `MONGODB_APP_DB`。

`npm run mongo:init` 会创建索引、写入默认 OCS 资费计划、导入历史批价规则，并在不覆盖既有余额的前提下插入缺失的 OCS 签约/余额行。

---

<a name="deployment"></a>

## 🚢 部署

生产环境作为单一回环内部 Go 应用服务运行在 Nginx 边缘之后：
Go 在 `127.0.0.1:18888` 同时提供 API 与内嵌静态 React SPA。
Nginx 边缘将全部公网流量（`/*`、`/api`、`/api/*`）直接路由至 Go；安装方式为
`sudo ./deploy/nginx/setup.sh [listen_port]`（脚本会先以 `nginx -t` 校验）。
全栈浏览器入口是 Nginx 边缘 URL（默认 `http://localhost`），**绝不是**任何内部组件端口。

### 生产构建与部署流水线

```bash
# 1. 构建生产静态 SPA
cd frontend
npm ci
npm run build
cd ..

# 2. 为 Go 二进制内嵌暂存 SPA 静态资源
node scripts/stage-spa-for-go.mjs

# 3. 编译打包后的 Go 服务二进制
cd backend
go build -o bin/server ./cmd/server
cd ..

# 4. 初始化数据库索引
npm run mongo:init

# 5. 启动 Go 应用服务（回环内部）
./backend/bin/server

# 6. 配置并启用公网 Nginx 边缘路由
sudo ./deploy/nginx/setup.sh
```

更多细节见 [部署文档](docs/operations/deployment.md)。

---

<a name="docs"></a>

## 📚 文档索引

| 文档 | 位置 |
| --- | --- |
| 文档索引 / 权威模型 | [docs/README.md](docs/README.md) |
| 架构 | `docs/architecture/` |
| 数据库 | `docs/database/` |
| 运维 | `docs/operations/` |
| 归档（仅简明历史摘要） | `docs/archive/` |
| 项目规则 | `CLAUDE.md` |
| 当前状态 | `AGENTS.md` |

---

<a name="checks"></a>

## ✅ 质量校验

提交前请运行：

```bash
# 前端
cd frontend && npm run check

# 后端
cd backend && go vet ./... && go build ./...
```

---

<a name="rbac"></a>

## 🔐 角色与权限

系统采用三标准角色模型（Canonical Three-Role Model）：

| 角色 | 权限范围 |
| --- | --- |
| **admin** | 全系统与用户管理，包含用户生命周期管理、角色分配与业务直接变更 |
| **operator** | 业务直接变更（签约、余额、Profile、资费、计费等）与核心网运维配置，**不可**管理用户 |
| **viewer** | 只读查看；所有业务变更与用户管理均被拒绝（HTTP 403） |

- 历史角色透明映射：`root` / `super_admin` → `admin`，`ops_admin` → `operator`，`auditor` → `viewer`。
- 写入边界：用户创建与角色更新仅接受 `admin` / `operator` / `viewer`；写入历史角色直接返回 HTTP 400 `INVALID_ROLE`。

---

<a name="contact"></a>

## 📞 联系方式

- 问题反馈：[GitHub Issues](https://github.com/YGone-001/subscriber-console/issues)
- 仓库地址：https://github.com/YGone-001/subscriber-console

---

<p align="right"><a href="#top">⬆ 返回顶部</a></p>
