# dshteamup

TeamUp 团队编排的 **dsh 适配层**。TeamUp 是从 Codex 移植的多线程编排 skill（主脑/worker/HR 角色、hub-and-spoke 派工、事件账本审计）。本插件把它的 thread tools 映射到 dsh 官方 API（`ctx.agents`），让 dsh 里的主脑 agent 可以通过工具调用创建、调度、审计真实的 dsh 多线程 worker。

## 这是什么

- `teamup_runtime.py`（事件账本 CLI，已原样移植）继续负责 TeamUp 的协议与证据链：init / add-task / dispatch / record-message / submit-return / confirm-return 等。
- 本插件提供 **dsh 线程 ⇄ 账本** 的传输层：把 "创建线程、派工、读回执、审计、归档" 落到 dsh 的 AgentRegistry / Session 事件日志上。
- `SKILL.md` 与 `teamup_runtime.py` 不被本插件修改。

## 安装

```bash
dsh plugin --profile <profile> add "file:<本目录>"
```

安装后重启 dsh，主脑 agent 即可看到 6 个 `teamup_*` 工具。

## 工具清单

| 工具 | 作用 |
|------|------|
| `teamup_create_thread` | 通过 `ctx.agents.create` 创建真实 dsh agent + session（新线程），生成 sessionId，可发 seedText 首条消息 |
| `teamup_list_threads` | 列出所有 live 线程：id、状态、cwd、preset、父线程血缘、事件数 |
| `teamup_send_message` | 向线程发 `agent.followup`，并回读 session 事件日志给出"已入账"回执（2s 超时如实回报 confirmed:false） |
| `teamup_read_thread` | 读线程最近会话事件（user/assistant/tool，带 seq 编号），供主脑验收 / HR 审计 |
| `teamup_runtime` | spawnSync 透传调用 `teamup_runtime.py` 账本 CLI，JSON 输出原样返回，`TEAMUP_CONFIRMATION_SECRET` 环境变量透传 |
| `teamup_archive_thread` | 通过 `AgentHandle.dispose()` 停掉并移除线程（只能归档本插件创建的线程） |

## 与 teamup_runtime.py 的关系

账本（task board、dispatch 合同、确认密钥校验、stats/validate）全部走 `teamup_runtime` 工具执行，本插件不复制账本逻辑。线程本体（agent/session）由 dsh 管理：账本里的 thread-id 与 `teamup_create_thread` 返回的 sessionId 一一对应，由主脑/HR 在 dispatch 时登记。

## 当前限制

- 归档即销毁：`dispose()` 会移除 session，归档后的线程历史无法再通过本插件读取（账本记录仍在 team store 文件里）。
- 只能归档本插件创建的线程（dsh 的 dispose 是创建者能力）。
- 线程模型默认继承 dsh 默认 agent 组合；需要不同模型时由 preset 或后续版本支持 per-thread agentOptions。
- `teamup_send_message` 的回执以 session 事件日志为准；线程本身是否完成任务需主脑用 `teamup_read_thread` 审计。
