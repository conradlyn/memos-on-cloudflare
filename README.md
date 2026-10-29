# Memos on Cloudflare

将 [Memos](https://github.com/usememos/memos) 笔记应用完整迁移到 Cloudflare 边缘平台，使用 Workers + D1 + R2 替代原有的 Go + SQLite + 本地存储架构。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 (SQLite) |
| 文件存储 | Cloudflare R2 |
| AI | Cloudflare Workers AI (Whisper) |
| 前端 | React + Vite + TailwindCSS |
| 认证 | JWT (HS256) + bcrypt |

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 4.14
- Cloudflare 账号（已开通 Workers、D1、R2）

## 快速部署

### 1. 克隆仓库

```bash
git clone https://github.com/jkjoy/memos-on-cloudflare.git
cd memos-on-cloudflare
```

### 2. 安装依赖

```bash
npm install
cd web && npm install && cd ..
```

### 3. 创建 Cloudflare 资源

```bash
# 创建 D1 数据库
wrangler d1 create cfmemos-db

# 创建 R2 存储桶
wrangler r2 bucket create cfmemos
```

### 4. 配置 wrangler.toml

将第 3 步创建 D1 时返回的 `database_id` 填入 `wrangler.toml`：

```toml
[assets]
directory = "./web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/file/*", "/u/*"]

[[d1_databases]]
binding = "DB"
database_name = "cfmemos-db"
database_id = "你的实际数据库ID"
```

### 5. 设置生产密钥

```bash
# 设置 JWT 密钥（务必使用强随机字符串）
wrangler secret put JWT_SECRET
```

### 6. 初始化数据库

```bash
npm run db:migrate:remote
```

### 7. 构建并部署

```bash
npm run deploy
```

部署完成后，访问 Workers 分配的域名，首次访问会进入管理员注册页面。

## Git 自动部署（推荐：Cloudflare Workers Builds）

Cloudflare 原生支持把 Worker 连接到 GitHub 仓库，**推送即构建部署**。相比 GitHub Actions，它不需要在 GitHub 侧启用工作流（fork 仓库默认不运行 Actions），也不需要在 GitHub 配置 Cloudflare 凭据。

### 连接步骤

1. Dashboard → **Workers & Pages** → 选择已存在的 Worker（名称必须是 `cfmemos`，需与 `wrangler.toml` 的 `name` 一致）→ **Settings → Builds → Connect**
2. 授权 GitHub，选择仓库与生产分支 `main`
3. 填写构建配置：

| 配置项 | 值 |
|--------|-----|
| Build command | `npm run build:ci` |
| Deploy command | `npm run deploy:ci` |
| Root directory | 留空（仓库根目录） |
| Build variables | `NODE_VERSION=22` |

4. 保存后推一次提交，或在 **Deployments → View build history** 中 Retry 触发首次构建。

### 为什么需要 `build:ci`

`web/` 是独立子包，根目录的依赖安装不会带入前端依赖，因此 `build:ci` 先安装两级依赖再执行 `vite build`；`--include=dev` 确保 `NODE_ENV=production` 环境下构建工具链（`vite` 等在 `devDependencies`）不会被跳过。`deploy:ci` 会在部署前解析上游最新版本号并注入 `APP_VERSION`。

### 注意事项

- **D1 迁移不会自动执行**：Workers Builds 自动生成的 API Token 只含 Workers Scripts / KV / R2 权限，没有 D1 编辑权限。新增 migration 时需本地执行 `npm run db:migrate:remote`；若希望 CI 内执行，需在 Builds 设置里改用带 **D1:Edit** 的自定义 Token，并把 Deploy command 改为 `npx wrangler d1 migrations apply cfmemos-db --remote && npm run deploy:ci`
- **运行时变量以 `wrangler.toml` 为准**：`INSTANCE_NAME` / `APP_VERSION` / `MEMOS_COMPAT_VERSION` 由配置文件下发；`JWT_SECRET` 属于 secret，用 `wrangler secret put` 设置后不会被部署覆盖
- 非 `main` 分支默认走 Preview 构建（`npx wrangler preview`），不影响生产
- **与 GitHub Actions 二选一**，同时启用会导致同一次推送部署两次

## GitHub Actions 自动部署

推送到 `main` 分支会自动触发部署。需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers Scripts:Edit、D1:Edit、R2:Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（在 Dashboard 右侧栏可找到） |

工作流会自动完成：安装依赖 → 构建前端 → 执行数据库迁移 → 部署 Worker。

> fork 仓库的 Actions 默认不会运行，需先在仓库 **Actions** 页面点击启用工作流，之后可用 **Run workflow** 手动触发（`workflow_dispatch`）。

## 本地开发

需要两个终端窗口：

```bash
# 终端 1：启动 Worker 后端（端口 8787）
npm run db:migrate   # 首次运行需要初始化本地数据库
npm run dev

# 终端 2：启动前端开发服务器（端口 3001，自动代理 API 到 8787）
npm run dev:web
```

浏览器访问 `http://localhost:3001`。

## 项目结构

```
├── wrangler.toml          # Cloudflare 配置（D1、R2、AI 绑定）
├── package.json           # 根 package，部署脚本
├── migrations/
│   └── 0001_initial.sql   # D1 数据库 schema
├── worker/
│   └── src/
│       ├── index.ts       # Hono 入口，路由挂载
│       ├── types.ts       # Env 绑定类型定义
│       ├── routes/        # API 路由
│       │   ├── auth.ts    # 登录/注册/刷新令牌
│       │   ├── memos.ts   # 备忘录 CRUD + 评论/反应/分享
│       │   ├── users.ts   # 用户管理 + 设置/PAT/通知
│       │   ├── attachments.ts  # 文件上传（R2）
│       │   ├── files.ts   # 文件下载服务
│       │   ├── instance.ts # 实例配置
│       │   ├── ai.ts      # Workers AI 转写
│       │   ├── idp.ts     # SSO 身份提供商
│       │   ├── shortcuts.ts # 快捷过滤器
│       │   └── sse.ts     # 实时更新
│       ├── auth/          # JWT、密码哈希、PAT
│       ├── db/            # D1 查询模块
│       └── middleware/    # 认证中间件
└── web/
    └── src/
        ├── connect.ts     # REST 客户端（替代 Connect RPC）
        ├── contexts/      # React Context（实例、认证）
        ├── components/    # UI 组件
        ├── pages/         # 页面路由
        ├── locales/       # i18n 翻译文件
        └── shims/         # @bufbuild/protobuf 兼容层
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥，生产环境必须使用强随机字符串 | 是 |
| `INSTANCE_NAME` | 实例名称，显示在页面标题 | 否 |
| `APP_VERSION` | 本项目版本号，随 `/api/v1/instance/profile` 的 `appVersion` 字段返回 | 否 |
| `MEMOS_COMPAT_VERSION` | 向 API 客户端通告的 Memos 版本号，默认 `0.28.0`（设置页显示的「版本」即此值） | 否 |

生产环境通过 `wrangler secret put` 设置敏感变量，非敏感变量在 `wrangler.toml` 的 `[vars]` 中配置。

## Cloudflare 资源绑定

| 绑定名 | 类型 | 用途 |
|--------|------|------|
| `DB` | D1 Database | 存储用户、备忘录、设置等所有结构化数据 |
| `BUCKET` | R2 Bucket | 存储附件文件（图片、音频、文档） |
| `AI` | Workers AI | 音频转写（@cf/openai/whisper） |
| `ASSETS` | Static Assets | 托管前端构建产物 |

## 自定义域名

在 Cloudflare Dashboard 中为 Worker 添加自定义域名：

1. Workers & Pages → cfmemos → Settings → Domains & Routes
2. 添加自定义域名（需要域名已在 Cloudflare DNS 中）

## 原生客户端兼容性

本项目对外提供 Memos v1 REST API，可被 [MoeMemos](https://github.com/mudkipme/MoeMemos) 等原生客户端直接连接。

- **服务地址**：填写 Worker 域名（如 `https://memos.example.com`），**不要**带 `/api/v1` 后缀
- **访问令牌**：在「设置 → 访问令牌」中创建，形如 `memos_pat_xxx`；不要使用网页登录的 JWT（15 分钟即过期）
- **版本协商**：`/api/v1/instance/profile` 的 `version` 字段返回 `MEMOS_COMPAT_VERSION`（默认 `0.28.0`）。MoeMemos 2.x 支持 v1 服务端 `0.27.0 ~ 0.31.0`，若该值超出范围，客户端会提示「服务器版本不受支持」或要求二次确认，因此**不要**把它设为 `APP_VERSION`（如 `1.0.0`）

接口契约按 MoeMemos 生成客户端所用的 OpenAPI 规范实现，涉及以下易错点：

| 约束 | 说明 |
|------|------|
| `User.state` | 必填枚举（`NORMAL`/`ARCHIVED`），仅返回 `rowStatus` 会导致客户端解码失败 |
| `Attachment.size` | int64，必须以**字符串**返回（`"70"` 而非 `70`） |
| 创建类接口 | `CreateMemo`/`CreateComment`/`CreateAttachment` 一律返回 `200`，返回 `201` 会被判为未文档化状态码 |
| `UserStats` | 路径为 `/api/v1/users/{user}:getStats`（自定义动词后缀），`pinnedMemos` 为资源名字符串数组 |
| `MemoRelation` | 返回 `{memo:{name,snippet}, relatedMemo:{...}, type}`，而非数据库原始行 |
| 时间戳格式 | 所有 `date-time` 字段必须是**整秒** RFC 3339（`2026-08-02T01:11:30Z`），**不能带毫秒**（`...30.000Z`）。Swift 客户端的 `ISO8601DateFormatter()` 默认不含 `.withFractionalSeconds`，遇到毫秒直接返回 `nil`，解码抛错。统一走 `worker/src/time.ts` 的 `protoTimestamp()` |
| `Memo.property.hasIncompleteTasks` | 字段名是**复数**。历史数据里存的是单数 `hasIncompleteTask`，`formatMemo` 在输出时补成复数，否则客户端读不到该属性（不报错，但功能静默失效） |
| `Memo.location` | `latitude`/`longitude` 必须是 **number**。若历史数据存成字符串（`"30.25"`），Swift 解 `Double` 会抛 `DecodingError`，整个备忘录列表都解不出来。`normalizeLocation()` 在输出时统一转数值，非法坐标直接丢弃 |

> 最后一条是最容易踩的坑：JSON 完全合法、字段类型全对，但客户端仍报「未能读取数据，因为它的格式不正确」。原因是 `Date#toISOString()` 永远输出 `.000Z`，而原版 Memos（Go protojson）输出的是不带小数的 `Z`。

### 备忘录视图（Memo Views）

对齐上游 Memos 0.31 的 `UserService.*MemoView`。一个视图就是一条命名的、可复用的 CEL 过滤表达式，把 `filter` 原样传给 `ListMemos` 即可复用。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/users/{user}/views` | 返回 `{ memoViews: MemoView[] }` |
| `GET` | `/api/v1/users/{user}/views/{view}` | 单个视图 |
| `POST` | `/api/v1/users/{user}/views` | 请求体即 `MemoView`：`{ title, filter, icon? }`，返回 `200` |
| `PATCH` | `/api/v1/users/{user}/views/{view}` | 支持 `?updateMask=title,filter,icon` |
| `DELETE` | `/api/v1/users/{user}/views/{view}` | 返回 `{}` |

- `icon` 是 oneof，只能给 `{"emoji":"🕐"}` 或 `{"lucide":"pin"}` 其中之一
- 显式传 `updateMask=icon` 且不带 `icon` 表示重置为默认图标；不带 `updateMask` 的 PATCH 不会误清图标
- 视图存在用户设置 `memo_views` 里，**无需数据库迁移**；首次读取时会从旧版 `shortcuts` 自动播种一次
- 旧的 `/api/v1/shortcuts` 保持不变，网页端继续可用

过滤表达式支持上游 0.30 起的 CEL 时间变量：

```
created_ts >= now - duration("168h")
timestamp(1750000000)
```

`now`、`duration()`、`timestamp()` 与旧的 `now()` 写法同时可用；`duration` 按 Go 的 `time.ParseDuration` 语义解析（`ns`/`us`/`ms`/`s`/`m`/`h`）。

### 过滤器属性

`filter` 支持以下布尔属性，可单独使用或与 `&&`、`||`、`!` 组合：

| 属性 | 为真的条件 |
|------|-----------|
| `pinned` | 已置顶 |
| `has_link` | 正文含链接 |
| `has_task_list` | 正文含任务列表 |
| `has_code` | 正文含代码块 |
| `has_incomplete_tasks` | 含未勾选的任务项 |
| `has_location` | 带经纬度坐标（仅有空 `location` 对象不算） |
| `has_attachments` | 关联了附件 |
| `has_image` | 关联了 `image/*` 附件，或正文含 Markdown 图片 `![]()` |

### 已合并的上游改进

以下改动来自上游 26.10，属于内部行为修正，**不改变任何响应字段结构**，因此可以安全合并：

| 改动 | 说明 |
|------|------|
| CGNAT 出站拦截 | `linkMetadata` 抓取链接时拒绝 `100.64.0.0/10`（RFC 6598），此前只拦了 `10/8`、`127/8`、`172.16/12`、`192.168/16`、`169.254/16` |
| 评论线程级联删除 | 删除备忘录时一并删除整条评论线程（含嵌套回复），并清理 `memo_relation`、`reaction`、`memo_share`；附件不删，只解除关联 |
| 最后管理员保护 | 删除实例最后一个 `ADMIN` 返回 `400 Cannot remove the last admin` |
| 健康检查探活 | `/api/v1/health` 与 `/healthz` 执行 `SELECT 1`，数据库不可用时返回 `503` |
| 匿名隐藏管理员 | 未认证请求访问 `instance/profile` 时，`admin.username` 与 `admin.name` 返回空字符串（字段本身保留，因为 `User.username` 是必填非可选） |

### 与上游 main 的取舍

上游已改用日历版本号（`26.10.0-rc.2`），并完成一次破坏性重构：REST 从 `/api/v1/*` 迁到 `/api/*`（**v1 路径直接返回 `410 Gone`**，下个版本删除）、proto 包 `memos.api.v1` 改名 `memos.api`、AIP 风格字段批量重命名、枚举与字段号重排、访问令牌绑定密码哈希。

**本项目不跟进这些改动**，兼容基线锁定在 `v0.31.0`——它是 v1 契约的最后一个版本，也正好是 MoeMemos 支持区间的上界。上游维护者在 [MoeMemos#420](https://github.com/mudkipme/MoeMemos/issues/420) 中亦确认 26.10 尚未被客户端支持。

## 功能特性

- Markdown 备忘录（支持标签、代码块、任务列表、Mermaid 图表）
- 多用户支持（管理员/普通用户）
- 备忘录可见性（私有/工作区/公开）
- 文件附件上传（最大 100MB）
- 备忘录分享链接（可设过期时间）
- 备忘录评论和表情反应
- 音频录制 + AI 转写
- SSO 单点登录
- 多语言支持（中文、英文等 30+ 语言）
- 暗色/亮色主题
- 日历热力图
- 标签管理
- Webhook 通知

## 与原版 Memos 的区别

| 项目 | 原版 Memos | 本项目 |
|------|-----------|--------|
| 后端 | Go + gRPC | Cloudflare Workers + Hono |
| 数据库 | SQLite (本地文件) | Cloudflare D1 (托管 SQLite) |
| 文件存储 | 本地/S3 | Cloudflare R2 |
| AI | OpenAI/Gemini API | Cloudflare Workers AI |
| 部署 | Docker/二进制 | `wrangler deploy` |
| 运维 | 需要服务器 | 无服务器，零运维 |
| 前端通信 | Connect RPC (protobuf) | REST JSON |

## 常见问题

**Q: 部署后访问显示空白页？**

确认 `npm run build:web` 已执行且 `web/dist/` 目录存在。`wrangler deploy` 会自动上传该目录。

**Q: 访问 `/api/*` 返回前端 404 页面？**

确认 `wrangler.toml` 的 `[assets]` 配置包含：

```toml
run_worker_first = ["/api/*", "/file/*", "/u/*"]
```

否则 Cloudflare 静态资源层可能会先处理请求，并把不存在的 API 路径回退到 SPA 的 `index.html`，最终显示前端 404 页面，而不是进入 Worker API 路由。

**Q: 数据库报错 "table not found"？**

执行 `npm run db:migrate:remote` 初始化远程数据库 schema。

**Q: 如何备份数据？**

```bash
# 导出 D1 数据库
wrangler d1 export cfmemos-db --remote --output=backup.sql

# R2 文件可通过 rclone 或 Cloudflare Dashboard 下载
```

**Q: 上传大小限制？**

附件上传硬编码为 100MB。Workers 免费版单次请求体限制为 100MB，付费版无此限制。

**Q: 免费额度够用吗？**

Cloudflare Workers Free Plan 包含：每天 10 万次请求、D1 5GB 存储、R2 10GB 存储 + 每月 1000 万次读取。个人使用完全足够。

## Star History

<a href="https://www.star-history.com/?repos=jkjoy%2Fmemos-on-cloudflare&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

</content>
</invoke>
