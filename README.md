# subscriber-console

一个基于 Next.js、React 和 Redis 的 4G/5G/OCS 订阅者运营管理控制台，支持 IMSI 订阅用户管理、Profile 模板、计费策略、流量分析、CSV 导入导出、审计日志、系统健康检查和角色权限控制。

## 功能特性

- IMSI 订阅者管理：查询、分页、排序、复制、单个创建、批量开户、编辑和删除。
- Profile 模板管理：维护 Slice、Session、QoS、AMBR、PCC Rule 等 4G/5G 订阅配置。
- Rating Group 管理：维护 Time、Volume、Event、Flat 等计费策略和币种费率。
- 数据导入导出：支持 CSV/JSON 导出、CSV 模板下载、导入预检、冲突跳过或覆盖。
- 流量分析仪表盘：展示总流量、PLMN 分布、Top 使用者、Rating 覆盖等运营指标。
- 审计日志：记录创建、更新、删除、导入、批量开户、修复等操作，并支持筛选和导出。
- 系统健康检查：扫描 Redis 中 SUB/OCS 数据一致性问题，并提供受控修复流程。
- 告警与 Sentinel：检测流量耗尽、异常大流量下降等场景，记录本地告警并支持确认。
- 认证与权限：基于 JWT Cookie 的登录态，支持 root、operator、viewer 角色权限。
- 运营体验：中英文切换、主题切换、命令面板、响应式后台布局。

## 技术栈

项目技术栈来自当前 `package.json`：

- Framework: Next.js 16.2.2 App Router
- UI: React 19.2.4, React DOM 19.2.4
- Language: TypeScript 5
- Styling: Tailwind CSS 4, CSS variables
- Data fetching: SWR 2.4.1
- Data store: Redis via ioredis 5.10.1
- Authentication: jose JWT, bcryptjs password hashing
- Charts: Recharts 2.15.4
- Icons: lucide-react
- Tooling: ESLint 9, eslint-config-next, npm

## 目录结构

```text
.
├── public/                    # 静态资源和 PLMN 数据
├── src/
│   ├── app/                   # Next.js App Router 页面和 API Route Handlers
│   │   ├── (dashboard)/       # 登录后的后台页面
│   │   ├── api/               # 认证、订阅者、Profile、Rating、审计等接口
│   │   └── login/             # 登录页
│   ├── components/            # 业务组件、弹窗、仪表盘和布局控件
│   ├── hooks/                 # 认证和表单相关 React hooks
│   ├── lib/                   # Redis、审计、鉴权、CSV、分析、告警等服务逻辑
│   └── types/                 # Subscriber、PLMN 等类型定义
├── docs/                      # 项目文档
├── .github/                   # Issue 和 PR 模板
├── package.json               # 依赖和脚本
├── next.config.ts             # Next.js 配置
└── tsconfig.json              # TypeScript 配置
```

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

然后访问 `http://localhost:3000`。

首次登录需要在 `.env` 中配置强密码形式的 `INITIAL_ADMIN_PASSWORD`，系统会在管理员账号不存在时自动创建 `admin` 账号。

## 本地开发

1. 安装 Node.js 20 或更高版本。
2. 启动本地 Redis，并确认 `.env` 中的 `REDIS_HOST` 和 `REDIS_PORT` 指向正确实例。
3. 设置 `JWT_SECRET`，长度至少 32 bytes，不能使用占位值。
4. 运行 `npm run dev` 启动开发服务器。

常用脚本：

```bash
npm run dev       # 启动开发服务器
npm run lint      # 运行 ESLint
npm run build     # 生产构建
npm run start     # 启动生产服务器
npm run clean     # 清理 Next.js 开发缓存
npm run rebuild   # 清理后重新构建
```

## 配置说明

配置通过环境变量提供。不要提交真实 `.env` 文件，只提交 `.env.example`。

| 变量 | 说明 |
| --- | --- |
| `REDIS_HOST` | Redis 主机地址 |
| `REDIS_PORT` | Redis 端口 |
| `JWT_SECRET` | JWT 签名密钥，至少 32 bytes |
| `INITIAL_ADMIN_PASSWORD` | 初始 `admin` 用户密码，必须满足强度策略 |

## 构建与运行

```bash
npm run build
npm run start
```

当前应用依赖 Redis 和服务端 Route Handlers，不适合作为纯静态站点导出。

## 测试说明

当前项目尚未配置完整自动化测试套件。提交前至少运行：

```bash
npm run lint
npm run build
```

建议后续补充：

- API Route Handler 单元测试和集成测试
- Redis 数据读写用例
- 权限矩阵测试
- 订阅者导入、批量开户、审计日志等关键流程测试

## 部署说明

推荐以 Node.js 服务方式部署：

1. 准备 Node.js 20+ 和 Redis。
2. 设置生产环境变量，尤其是 `JWT_SECRET` 和 Redis 连接信息。
3. 执行 `npm ci && npm run build`。
4. 使用 `npm run start` 启动服务。

更多细节见 [docs/deployment.md](docs/deployment.md)。

## Git 工作流

- 默认分支：`main`
- 功能分支：`feat/<short-description>`
- 修复分支：`fix/<short-description>`
- 文档或维护分支：`chore/<short-description>`
- 提交信息建议使用 Conventional Commits，例如 `feat: add subscriber import precheck`。

## 贡献说明

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。提交 PR 前确保未包含 `.env`、token、证书、Redis dump 或其他敏感/本地文件。

## License

本项目基于 [MIT License](LICENSE) 发布。
