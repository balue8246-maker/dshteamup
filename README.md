# dshteamup

**TeamUp 多线程团队编排插件**——主脑/worker 角色、hub-and-spoke 派工、事件账本审计，全部落在 dsh 官方 API 上。

主脑（你的主会话）通过 6 个 `teamup_*` 工具创建/调度/审计真实的多线程 worker：每个 worker 是一个**平级顶层会话**（侧栏可见、满工具面、跨重启恢复）。

## 核心能力

| 能力 | 说明 |
|------|------|
| 建线程 | `teamup_create_thread`：满工具面（与主脑一致）、自动编号标题（`001职能名`）、自动收编工作区、自动写会话标题、seedText 自动附加团队纪律 |
| 派工 | `teamup_send_message`：带"已入账"回执（证据链可查） |
| 审计 | `teamup_read_thread`：带 seq 编号的完整事件日志 |
| 跨重启存活 | rehydrate 阶梯重试恢复，历史/编号/工具面全保留 |
| 侧栏可见 | worker 与手动会话同级，标题正确（编号+职能） |
| 归档 | `teamup_archive_thread`：彻底销毁（含注册表记录） |
| 账本 | `teamup_runtime`：init/dispatch/submit-return/confirm-return 协议层 |

## 团队纪律（create 时自动注入 worker seed）

**Worker 侧**：
1. 只做被指派的任务，不越权扩展；边界用回传向主脑报告
2. 不与其他成员直接通信——所有协调经主脑中转（hub-and-spoke）；需要帮手时写 `handoff_request` 由主脑裁决
3. 只写被指派的文件（write ownership），绝不改其他成员负责的文件
4. 完成一个阶段停下（phase gate），回传等主脑验收，不自动进入下一阶段
5. 上下文接近饱和时回传说明，由主脑决定交接
6. 回传报告实际做了什么，不夸大成稿

**主脑侧**：拆任务/派工/验收/汇总，不直接写产品代码；任务书自包含（目标/边界/验收/停止/回传）；worker 协调经主脑中转；唯一写所有权；阶段 gate 交用户决策。

## 线程编号

- title 未带 `NNN` 前缀 → 自动生成 `001职能名`（nextNumber 跨重启自增，存 registry）
- 已带编号（如 `010验收`）→ 原样使用，不干扰自动序列

## 安装

```bash
dsh plugin --profile <profile> add "file:<本目录>"
```

重启 dsh 后主脑即可看到 6 个 `teamup_*` 工具。

## Web 协作面板（仅限 web profile）

> **兼容性前提**：本插件的 Web 面板**仅限 dsh 的 web profile**。host 侧 `inject`
> 硬依赖 `webServer`/`webRuntime` 服务（`lib/index.js`），装入没有 web 服务的
> profile（如纯 headless/CLI profile）时，插件无法激活，6 个 `teamup_*` 工具会
> **静默失效**——请只在 `dsh web` 承载的 profile 中使用本插件。

侧栏底部的「团队」按钮（展开态显示 `TeamUp`）打开浮层面板，实时展示 live 线程
清单：标题、状态（空闲/运行中）、团队名（按 `teamName` 分组，未分组垫底）、
事件数、短 sessionId。支持手动刷新，面板打开期间每 15s 自动刷新（in-flight
去重，无重叠请求）。

**数据通道（只读）**——`/teamup/api` 前缀路由，仅 GET，与
`teamup_list_threads` 工具共用 `collectThreads()`，数据严格一致：

| 路径 | 返回 |
|------|------|
| `/teamup/api`、`/teamup/api/threads` | live 线程清单（含 registry 合并的 title/teamName） |
| `/teamup/api/registry` | `registry.json` 原文 |

响应头带 `cache-control: no-store`（client fetch 亦带 `no-store`，双保险）。

**信任围栏**（与 dsh `/api` 网关同一信任模型）：请求的 `Host` 必须是回环地址
（`localhost` / `127.*` / `[::1]`）或部署配置的 `trustedHosts` 权威来源；
`sec-fetch-site: cross-site` 直接拒绝；携带 `Origin` 时要求与 `Host` 同源。
不满足任一条件 → `403`。端点为只读 GET，无 CSRF 面。

**生效方式**：host 路由（`/teamup/api`）与 client bundle（`lib/client.js`）都
在 dsh 启动时装配——修改后需**重启 dsh，再刷新页面**才生效（未运行 dev HMR
时不做热替换）。

**client bundle 说明**：遵循 dsh 的 client 纯度门——`package.json` 的
`dsh.client.inject` 声明的是模块表依赖边（`@deepseek-ai/dsh-client-runtime`、
`@deepseek-ai/dsh-client-ui-slots`），bundle 内部实际只 `require` 平台种子词
`react` / `react-dom`，零跨插件 value import、零第三方依赖（与
dsh-better-sidebar 风格一致）。

## 工具清单

| 工具 | 作用 |
|------|------|
| `teamup_create_thread` | 创建 worker 线程（满工具面 + 编号 + 纪律 + 侧栏可见） |
| `teamup_list_threads` | 列出所有 live 线程（id/状态/cwd/血缘/事件数） |
| `teamup_send_message` | 向线程发消息 + "已入账"回执 |
| `teamup_read_thread` | 读线程事件日志（带 seq，供验收/审计） |
| `teamup_runtime` | 透传 `teamup_runtime.py` 账本 CLI（协议与证据链） |
| `teamup_archive_thread` | 归档线程（dispose + 注册表清理） |

## 架构

```
lib/
├── index.js            # dsh 适配层（6 工具 + registry + rehydrate + attach + 纪律注入 + /teamup/api 只读路由）
├── client.js           # Web 协作面板 client bundle（sidebar.footer.action 挂载，仅 require react/react-dom）
└── teamup_runtime.py   # 事件账本 CLI（stdlib-only，1742 行）
docs/TeamUp-SKILL-original.md  # 原版治理文本存档（不打包）
```

- **注册表**：`~/.dsh/profiles/<profile>/dshteamup/registry.json`（线程清单 + nextNumber，不随 cwd 漂移）
- **worker = 顶层平级会话（origin 空）**——不是 subagent，这是侧栏可见的前提
- 账本协议（dispatch 合同、确认密钥、stats）走 `teamup_runtime`，本插件只做 dsh 线程 ⇄ 账本的传输层

## 限制

- 归档即销毁：`dispose()` 移除 session，归档后历史无法再经插件读取（账本记录仍在 team store）
- 只能归档本插件创建的线程（dsh 的 dispose 是创建者能力）
- `teamup_send_message` 回执以 session 事件日志为准；任务是否完成需主脑 `teamup_read_thread` 审计
- **仅限 web profile**：Web 面板（含 6 工具本身）依赖 `webServer`/`webRuntime` 服务，装入无 web 服务的 profile 会静默失效（见上节）
