/**
 * dshteamup — TeamUp 团队编排的 dsh 适配层。
 *
 * TeamUp 多线程团队编排插件：主脑/worker 角色、hub-and-spoke 派工、
 * 事件账本审计。本插件把协作线程映射到 dsh 官方 API：
 *
 *  - teamup_create_thread  通过 ctx.agents.create 创建真实 dsh agent + session
 *    （返回 sessionId 作为线程标识）；新线程通过 composeFrom 继承调用方（主脑）
 *    的 preset 组合，获得完整宿主工具面（bash/read/write/web_search 等）；
 *  - teamup_list_threads   列出所有 live agents 及元数据（cwd/preset/父线程等）；
 *  - teamup_send_message   向线程发 followup，并回读 session 事件日志做
 *    "已入账" 回执（TeamUp 证据链要求发送结果可检视）；
 *  - teamup_read_thread    读线程最近会话事件（user/assistant/tool 三类），
 *    带 seq 编号，可供主脑/HR 审计；
 *  - teamup_runtime        透传调用 teamup_runtime.py（事件账本 CLI），
 *    JSON 输出原样返回，TEAMUP_CONFIRMATION_SECRET 环境变量透传；
 *  - teamup_archive_thread 通过 AgentHandle.dispose() 归档线程。
 *
 * 三层结构：
 *  1. registry    线程注册表落盘到 dsh home 的 profile 目录
 *                 （~/.dsh/profiles/<profile>/dshteamup/registry.json，不随
 *                 process.cwd() 漂移；旧版 cwd 下位置自动迁移），供重启恢复；
 *  2. rehydrate   启动时扫描 registry，对未加载的线程用 ctx.agents.resume()
 *                 重新挂载（0s/1s/3s/10s 阶梯重试），重建 handles，
 *                 让 send/read/archive 跨重启可达；
 *  3. composeFrom 新线程 preset 装配：有调用方 agent 时 composeFrom 继承其
 *                 preset 组合（与主脑一致的完整工具面），否则回退挂载默认 preset。
 *
 * 账本与协议（init/dispatch/record-message/submit-return/confirm-return 等）
 * 仍由 teamup_runtime.py 承担，本插件只做 "dsh 线程 <-> 账本" 的传输层。
 * 不修改 teamup_runtime.py 与 SKILL.md。
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'

export const name = 'dshteamup'
// webServer：/teamup/api 只读路由；webRuntime：提供 trustedHosts（信任围栏的权威来源，
// 与 dsh 的 /api 网关同一份信任清单，见 dsh-web-app 的 resolveLanTrust）。
export const inject = ['agents', 'timer', 'tools', 'workspaceRegistry', 'sessionTitle', 'webServer', 'webRuntime']

const TAG = '[dshteamup]'
const RUNTIME_SCRIPT = 'teamup_runtime.py'
const CONFIRM_TIMEOUT_MS = 2000        // send_message 的入账回执确认超时
const EVIDENCE_POLL_MS = 100           // waitForEvidence 的事件轮询间隔
const READ_LIMIT_DEFAULT = 20
const READ_LIMIT_MAX = 200
const RUNTIME_TIMEOUT_MS = 120000
const RUNTIME_MAX_BUFFER = 16 * 1024 * 1024
const TOOL_ARGS_PREVIEW_LEN = 120      // tool-call 参数在会话文本里的预览截断长度
const REHYDRATE_RETRY_DELAYS_MS = [0, 1000, 3000, 10000] // 启动恢复的重试阶梯

// ---- /teamup/api 只读 API 的信任围栏 ----
// 同源/回环/trustedHosts 权威来源放行；跨站（sec-fetch-site=cross-site）或
// Origin 与 Host 不一致拒绝。与 dsh /api 网关（dsh-client-connection 的
// isTrustedApiRequest）同一信任模型。只读 GET 端点，无 CSRF 面。
//
// 【与官方实现的差异】本版按 dsh-better-sidebar 的请求期宽松解析移植：
//  - 官方在加载期对每个 trustedHosts 条目做 assertTrustedAuthority 严格校验
//    （畸形条目——带路径/userinfo/空白/零填充端口等——启动期大声失败，杜绝
//    "解析后被悄悄改写授权"的配置漂移）；
//  - 本版为请求期宽松解析：畸形条目解析后按嵌入 hostname 参与匹配（如
//    "harness.internal/path" 会按 "harness.internal" 匹配），或解析失败时被
//    静默跳过（.some 短路）。语义偏离官方（官方拒绝加载，本版忽略或窄化），
//    但不可利用：trustedHosts 是部署配置而非攻击者输入，且本端点只读、仅 GET。
//  - 未来可复用官方实现：换用 dsh-client-connection 的 isTrustedApiRequest +
//    加载期 assertTrustedAuthority 校验，即可消除该语义偏离。
function headerValue(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return (Array.isArray(trustedHosts) ? trustedHosts : []).some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (!entryUrl) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = headerValue(request.headers, 'host')
  if (!host) return false
  const hostUrl = parseAuthority(host)
  if (!hostUrl) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headerValue(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  // no-store：面板数据是实时快照，禁止浏览器/中间层缓存（与 client fetch 的
  // cache:'no-store' 双保险）。
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

// ---- 账本（teamup_runtime.py CLI 的 host 侧封装） ----
// 固定 store 路径（不随进程 cwd 漂移，与注册表同策略）：
//   ~/.dsh/profiles/web/dshteamup/ledger/<team_id>/  （events.ndjson / state.json / pending.json）
// 所有 CLI 调用显式传 --store，team_id 固定为 dshteamup。
const LEDGER_STORE_DEFAULT = resolve(os.homedir(), '.dsh', 'profiles', 'web', 'dshteamup', 'ledger')
const LEDGER_TEAM_ID_DEFAULT = 'dshteamup'
const LEDGER_SECRET_FILE_DEFAULT = resolve(LEDGER_STORE_DEFAULT, 'confirmation.secret')
const LEDGER_INIT_EMOJI = '🤝'
const LEDGER_INIT_MODE = 'BUILD MODE'

/** 有界读 JSON 请求体（防无界读取；空体按 {} 处理）。 */
async function readJsonBody(req, maxBytes = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

// ---- TeamUp 治理纪律（从原版 SKILL.md 抽取，create 时注入 worker seed） ----
// worker 侧纪律：主动回报、hub-and-spoke、写所有权、phase gate 停、上下文饱和上报。
// {mainBrainThreadId} 在 create 时替换为创建者（主脑）的 sessionId。
const WORKER_RULES = `你是 TeamUp 协作团队的一名成员。团队纪律（必须遵守）：

1. 只做被指派的任务，不越权扩展范围；遇到边界用回报向主脑报告，不自行决定。
2. 【主动回报】完成任务后，必须用 teamup_send_message 主动发回报给主脑线程
   （threadId = {mainBrainThreadId}），附：任务编号、一句话结论（PASS/FAIL/BLOCKED）、
   改了什么/产出了什么、阻塞点、下一步建议。不完成回报，任务不算结束。
3. 不与其他成员直接通信或协作——所有协调经主脑中转（hub-and-spoke）。
   你只需要知道主脑的线程 id（上面给了），不需要知道其他成员的 id 或分工；
   需要别的成员帮忙时，在回报里写 handoff_request，由主脑决定。
4. 只写你被指派的文件（write ownership）；绝不修改其他成员负责的文件，
   避免两人同时改同一处。不确定归属时先问主脑。
5. 完成一个阶段后停下（phase gate），主动回报结果等主脑验收，不自动进入下一阶段。
6. 上下文接近饱和时，主动回报说明，由主脑决定是否交接给新线程。
7. 回报要报告实际做了什么、结果如何、有没有问题，不夸大成稿。`

// 主脑侧纪律（create 返回的协作须知 + 供主脑自持）：
const MAIN_BRAIN_RULES = `TeamUp 主脑纪律：
1. 主脑负责拆任务、派工、验收、汇总，不直接写产品代码/产物。
2. 【派工标准格式】每次 teamup_send_message 派工，消息必须自包含以下字段：
   - 任务编号（如 T1/T2）
   - 目标：要完成什么（明确、可验收）
   - 边界：允许做什么 / 禁止做什么
   - 验收标准：做到什么程度算完成
   - 停止条件：什么时候停下（phase gate）
   - 回报要求：完成后用 teamup_send_message 回报主脑（threadId = 你的 sessionId），
     附结论（PASS/FAIL/BLOCKED）+ 产出 + 阻塞点 + 下一步建议
3. 【等待回报，不监控】派工后不要轮询/窥探 worker 线程——等待它的主动回报。
   回报来了再验收。仅在回报缺失/卡死/疑似工具错误时，才用 teamup_read_thread 读线程恢复现场。
4. worker 之间不直接协调；handoff_request 由主脑裁决转派。
5. 阶段之间设 gate：worker 停在阶段末，主动回报后主脑验收，重大节点交给用户决策。
6. 每个文件指定唯一写所有权，禁止两个 worker 同时改同一处。
7. 【团队全貌】你掌握所有 worker 的线程 id 与分工（create 返回 + teamup_list_threads），
   worker 彼此不知道对方——所有横向协调经你中转。
8. 【建队流程】用户要求组建 TeamUp 团队后：
   a) 先做任务分解，给出团队部署建议（角色、人数、分工、按任务类型的最小编制参考），
      等用户确认后再建线程——不擅自建队；
   b) 用户确认后建队，并在用户宣布项目结束/小队解散前，保持这套配置；
   c) 中间任务需要加人时，优先用现有成员（最大化现有团队）——只有当新任务会
      搞乱现有成员上下文（角色冲突/上下文饱和/职责混杂）时，才新建线程；
   d) 用户宣布小队解散时，做总账汇总：每个成员的角色、产出、验收结论、遗留问题，
      汇总成一份完整的团队交付报告交给用户，然后归档线程。`

// 插件 lib 目录（与 index.js 同层），teamup_runtime.py 的绝对路径从这里解析。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const RUNTIME_SCRIPT_PATH = resolve(PLUGIN_DIR, RUNTIME_SCRIPT)

export function apply(ctx, config = {}) {
  // sessionId -> AgentHandle。dispose 能力只在创建者手里（dsh-agent 的
  // CAPABILITY 设计），所以归档只能归档本插件创建的线程。
  const handles = new Map()

  const runtimeScriptPath = config.runtimeScriptPath ?? RUNTIME_SCRIPT_PATH
  const defaultTeamDir = config.teamDir ?? process.cwd()

  // ---- 线程注册表（跨重启辨识插件线程） ----
  // 落盘位置：固定到 dsh home 的 profile 目录（不随 process.cwd() 漂移）：
  //   ~/.dsh/profiles/<profile>/dshteamup/registry.json
  // 旧版曾写在 cwd 下（.dshteamup/registry.json），加载时做一次迁移兼容。
  const REGISTRY_DIR = resolve(os.homedir(), '.dsh', 'profiles', 'web', 'dshteamup')
  const REGISTRY_PATH = resolve(REGISTRY_DIR, 'registry.json')
  const LEGACY_REGISTRY_PATH = resolve(defaultTeamDir, '.dshteamup', 'registry.json')

  function loadRegistry() {
    try {
      // 迁移：旧位置有、新位置没有 → 搬过去（老线程恢复用）
      if (!existsSync(REGISTRY_PATH) && existsSync(LEGACY_REGISTRY_PATH)) {
        mkdirSync(REGISTRY_DIR, { recursive: true })
        const legacy = readFileSync(LEGACY_REGISTRY_PATH, 'utf8')
        writeFileSync(REGISTRY_PATH, legacy)
        console.log(TAG, 'registry migrated from legacy path')
      }
      if (!existsSync(REGISTRY_PATH)) return {}
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) || {}
    } catch (error) {
      console.error(TAG, 'failed to load registry:', error && error.message)
      return {}
    }
  }

  function saveRegistry(registry) {
    try {
      mkdirSync(REGISTRY_DIR, { recursive: true })
      writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2))
    } catch (error) {
      console.error(TAG, 'failed to save registry:', error && error.message)
    }
  }

  function rememberThread(sessionId, info) {
    const registry = loadRegistry()
    registry[sessionId] = info
    saveRegistry(registry)
  }

  function forgetThread(sessionId) {
    const registry = loadRegistry()
    delete registry[sessionId]
    saveRegistry(registry)
  }

  // 线程编号：registry 维护 nextNumber（跨重启自增）。create 时若 title 未带
  // 编号前缀（NNN 开头），自动生成 "NNN + 职能名"（如 001代码落地）。
  // 编号不进 registry 的线程条目，只作为 nextNumber 计数器推进。
  function nextThreadNumber() {
    const registry = loadRegistry()
    const n = Number(registry.nextNumber) || 1
    registry.nextNumber = n + 1
    saveRegistry(registry)
    return n
  }

  // 规范化线程标题：已带编号前缀（^\\d{3}）则原样用；否则编号+职能。
  function normalizedTitle(rawTitle) {
    const t = String(rawTitle || '').trim()
    if (/^\d{3}/.test(t)) return t
    if (!t) return String(nextThreadNumber()).padStart(3, '0') + '未命名'
    return String(nextThreadNumber()).padStart(3, '0') + t
  }

  // 给线程设标题：dsh 的自动标题生成只认 source.kind==="user" 的消息，插件发的
  // 消息（seed/派工）source 是 "plugin"，永不触发——侧栏显示无标题 fallback。
  // 显式 rename（append session/title 事件，持久化跨重启保留）补上这个洞。
  function renameThread(session, title) {
    try {
      const st = ctx.sessionTitle
      if (!st || !session || !title || !String(title).trim()) return false
      st.rename(session, String(title).trim())
      return true
    } catch (error) {
      console.error(TAG, `rename failed for ${session && session.id}:`, error && error.message)
      return false
    }
  }

  // 把线程收编进侧栏：侧栏渲染的是工作区成员账本（workspace.json 的 sessionIds），
  // 插件直接 ctx.agents.create 建 session 绕过了正常"新建会话"流程，没人 attach——
  // 线程永远不进侧栏。这里显式补 attach：resolveByPath(cwd) → 无则 create → attachSession。
  // 幂等（attachSession 内部查重）；持久化写 workspace.json，一次生效跨重启保留。
  async function attachToWorkspace(sessionId, cwd) {
    try {
      const wr = ctx.workspaceRegistry
      if (!wr) { console.error(TAG, 'attachToWorkspace: workspaceRegistry unavailable'); return false }
      let ws = await wr.resolveByPath(cwd)
      if (!ws) {
        ws = await wr.create(cwd)
        console.log(TAG, `workspace created for attach: ${cwd}`)
      }
      await ws.attachSession(sessionId)
      console.log(TAG, `thread attached to workspace: ${sessionId} -> ${cwd}`)
      return true
    } catch (error) {
      console.error(TAG, `attachToWorkspace failed for ${sessionId}:`, error && error.message)
      return false
    }
  }

  // 短睡眠：优先 timer 服务 promise（随 ctx 生命周期销毁），兜底 Node setTimeout。
  function sleep(ms) {
    const pending = typeof ctx.setTimeout === 'function'
      ? ctx.setTimeout(ms)
      : new Promise((done) => setTimeout(done, ms))
    return pending && typeof pending.catch === 'function' ? pending.catch(() => {}) : Promise.resolve()
  }

  // 构造 UserMessage：dsh 的 brand 只是类型层标记（运行时无校验），
  // 字面量对象即可通过 Inbox 校验（只查 id 唯一）与 session.append（无损 JSON）。
  function makeUserMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'plugin', plugin: 'dshteamup' },
    }
  }

  // 在 session 事件日志里找某条消息的入账证据：
  //  - agent/inbox/spliced：followup 同步写入的 durable 事件（消息已入会话日志）；
  //  - user/message：driver 认领消息、进入 model-visible surface 的事件（更强证据）。
  function findEvidence(agent, messageId) {
    const events = agent.session.events
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'agent/inbox/spliced') {
        const inserted = event.data && event.data.inserted
        if (Array.isArray(inserted) && inserted.some((m) => m && m.id === messageId)) {
          return { kind: 'inbox-spliced', seq: event.seq }
        }
      } else if (event.type === 'user/message' && event.data && event.data.id === messageId) {
        return { kind: 'user-message', seq: event.seq }
      }
    }
    return null
  }

  async function waitForEvidence(agent, messageId, timeoutMs) {
    let evidence = findEvidence(agent, messageId)
    const deadline = Date.now() + timeoutMs
    while (!evidence && Date.now() < deadline) {
      await sleep(EVIDENCE_POLL_MS)
      evidence = findEvidence(agent, messageId)
    }
    return evidence
  }

  // meta.cwd 必须为绝对路径（session 边界校验），相对路径按主进程 cwd 解析。
  function resolveCwd(cwd) {
    if (!cwd) return defaultTeamDir
    return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
  }

  // 从 partial 字段里挑出非空项，组装 agent options（provider/model/maxTokens）。
  // resolveAgentOptions 与 rehydrate 共用；maxTokens 统一转 Number。
  function pickAgentOptions(partial) {
    const out = {}
    if (partial.provider) out.provider = partial.provider
    if (partial.model) out.model = partial.model
    if (partial.maxTokens) out.maxTokens = Number(partial.maxTokens)
    return out
  }

  // 继承调用方 agent 的模型配置：dsh 的 ReactLoopAgent 一跑 turn 就要求
  // provider/model 非空（buildRequest 里 `if (!proposedConfig.provider || !proposedConfig.model) throw`），
  // 插件动态创建的 agent 不传就会永远 idle。来源优先级：
  //   1. 显式参数 provider/model/maxTokens
  //   2. 当前调用方 agent（主脑）的 options
  //   3. settings 的 agent-default-model（deepseek-official / deepseek-v4-flash 等）
  function resolveAgentOptions(args) {
    const inherited = {}
    try {
      const initiator = ctx.agents.currentInitiator()
      if (initiator && initiator.options) {
        if (initiator.options.provider) inherited.provider = initiator.options.provider
        if (initiator.options.model) inherited.model = initiator.options.model
        if (initiator.options.maxTokens) inherited.maxTokens = initiator.options.maxTokens
      }
    } catch { /* currentInitiator 可能在非 agent 上下文抛错，忽略 */ }
    if (!inherited.provider || !inherited.model) {
      try {
        const section = ctx.settings && ctx.settings.get('agent-default-model')
        if (section) {
          if (!inherited.provider && section.provider) inherited.provider = section.provider
          if (!inherited.model && section.model) inherited.model = section.model
        }
      } catch { /* settings 不可用时忽略 */ }
    }
    return pickAgentOptions({
      provider: args.provider || inherited.provider,
      model: args.model || inherited.model,
      maxTokens: args.maxTokens || inherited.maxTokens,
    })
  }

  // 统一错误消息格式：优先 error.message，失败时 fallback 到 error 本体。
  function errMsg(error) {
    return String((error && error.message) || error)
  }

  // 收集当前 live 线程清单（teamup_list_threads 工具与 /teamup/api 路由共用，
  // 保证 Web 面板数据与工具返回严格一致）。registry 里的 title/teamName 是
  // 插件 create 时落盘的展示元数据（session header 不含标题）。
  function collectThreads() {
    const registry = loadRegistry()
    return ctx.agents.list().map((agent) => {
      const header = agent.session.header
      const meta = registry[agent.id] || {}
      return {
        sessionId: agent.id,
        status: agent.status,
        title: meta.title ?? null,
        teamName: meta.teamName ?? null,
        provider: (agent.options && agent.options.provider) ?? null,
        model: (agent.options && agent.options.model) ?? null,
        cwd: header.cwd ?? null,
        parentSession: header.parentSession ?? null,
        agentPreset: header.agentPreset ?? null,
        origin: header.origin ?? null,
        delegationDepth: header.delegationDepth ?? 0,
        createdAt: header.createdAt ?? null,
        eventCount: agent.session.seq,
        ownedByPlugin: handles.has(agent.id),
      }
    })
  }

  // ---- 账本运行时（host 侧封装，仅调 CLI，不改 teamup_runtime.py） ----
  const ledgerStore = config.ledgerStore ?? LEDGER_STORE_DEFAULT
  const ledgerTeamId = config.ledgerTeamId ?? LEDGER_TEAM_ID_DEFAULT
  const ledgerSecretFile = config.ledgerConfirmationSecretFile ?? resolve(ledgerStore, 'confirmation.secret')

  // 主脑线程 id 解析：config.ledgerMainBrainThreadId > 启发式（最早的顶层非插件
  // agent）> 'unknown'。启发式仅供自动 init 兜底；生产建议显式配置。
  function resolveMainBrainThreadId() {
    if (config.ledgerMainBrainThreadId) return String(config.ledgerMainBrainThreadId)
    try {
      const candidates = ctx.agents
        .list()
        .filter((agent) => agent.session.header.origin !== 'subagent' && !handles.has(agent.id))
        .sort((a, b) => (a.session.header.createdAt || 0) - (b.session.header.createdAt || 0))
      if (candidates.length > 0) return candidates[0].id
    } catch { /* 忽略探测失败 */ }
    return 'unknown'
  }

  // 运行一次 teamup_runtime.py（与 teamup_runtime 工具同一 spawn 模式）。
  // 注意 argparse 契约：--store/--team-id 是主解析器参数，必须位于子命令之前。
  function runLedgerCli(subcommand, ...args) {
    const proc = spawnSync('python3', [runtimeScriptPath, '--store', ledgerStore, '--team-id', ledgerTeamId, subcommand, ...args], {
      cwd: defaultTeamDir,
      encoding: 'utf8',
      timeout: RUNTIME_TIMEOUT_MS,
      env: process.env, // TEAMUP_CONFIRMATION_SECRET 透传
      maxBuffer: RUNTIME_MAX_BUFFER,
    })
    const timedOut = !!(proc.error && proc.error.code === 'ETIMEDOUT')
    const result = {
      ok: proc.status === 0 && !timedOut,
      status: proc.status,
      timedOut,
      command: subcommand,
      stdout: String(proc.stdout || '').trim(),
      stderr: String(proc.stderr || '').trim(),
    }
    if (proc.error && !timedOut) {
      result.ok = false
      result.spawnError = String((proc.error && proc.error.message) || proc.error)
    }
    if (result.stdout) {
      try {
        result.result = JSON.parse(result.stdout)
      } catch { /* 非 JSON 输出保持原样 */ }
    }
    return result
  }

  const ledgerStatePath = () => resolve(ledgerStore, ledgerTeamId, 'state.json')

  // 已初始化判断：state.json 投影（每次账本写入都会重写）带 initialized 标记。
  function ledgerInitialized() {
    try {
      const state = JSON.parse(readFileSync(ledgerStatePath(), 'utf8'))
      return state.initialized === true
    } catch {
      return false
    }
  }

  // 自动 init（幂等）：仅当未初始化时执行。确认密钥优先级：
  //   1. 环境变量 TEAMUP_CONFIRMATION_SECRET（透传 CLI 的默认 env）
  //   2. 配置文件（config.ledgerConfirmationSecretFile 或 <store>/confirmation.secret）
  //   3. 都不存在则生成随机密钥写入 <store>/confirmation.secret（本地 MVP 兜底；
  //      生产建议用环境变量，密钥即确认权柄，见 teamup_runtime.py 的 authority 模型）
  function ensureLedgerInitialized() {
    if (ledgerInitialized()) return true
    const envSecret = process.env.TEAMUP_CONFIRMATION_SECRET
    let secretArgs = []
    if (envSecret) {
      secretArgs = ['--confirmation-secret-env', 'TEAMUP_CONFIRMATION_SECRET']
    } else {
      if (!existsSync(ledgerSecretFile)) {
        mkdirSync(dirname(ledgerSecretFile), { recursive: true })
        writeFileSync(ledgerSecretFile, randomUUID() + randomUUID() + '\n', { mode: 0o600 })
      }
      secretArgs = ['--confirmation-secret-file', ledgerSecretFile]
    }
    const result = runLedgerCli(
      'init',
      '--team-emoji', LEDGER_INIT_EMOJI,
      '--mode', LEDGER_INIT_MODE,
      '--main-brain-thread-id', resolveMainBrainThreadId(),
      ...secretArgs,
    )
    if (!result.ok) {
      throw new Error(`ledger init failed: ${result.stderr || result.stdout || result.spawnError || 'unknown'}`)
    }
    console.log(TAG, `ledger initialized: ${ledgerStore}/${ledgerTeamId}`)
    return true
  }

  // 从 state.json 投影读团队元信息（init 时写入的 team 块）。
  function readLedgerTeamMeta() {
    try {
      const state = JSON.parse(readFileSync(ledgerStatePath(), 'utf8'))
      const team = state.team || {}
      return {
        emoji: team.team_emoji ?? null,
        mode: team.mode ?? null,
        mainBrainThreadId: team.main_brain_thread_id ?? null,
        ledgerSchemaVersion: state.ledger_schema_version ?? null,
        lastSeq: state.last_seq ?? 0,
      }
    } catch {
      return { emoji: null, mode: null, mainBrainThreadId: null, ledgerSchemaVersion: null, lastSeq: 0 }
    }
  }

  // 从 state.json 投影读任务概览（与 CLI stats 同一数据源；stats 给聚合，这里给逐任务）。
  function readLedgerTasks() {
    try {
      const state = JSON.parse(readFileSync(ledgerStatePath(), 'utf8'))
      const tasks = []
      for (const task of Object.values(state.tasks || {})) {
        tasks.push({
          taskId: task.task_id,
          status: task.status,
          kind: task.kind,
          manualGate: task.manual_gate === true,
          dependsOn: task.depends_on || [],
          dispatch: task.dispatch
            ? {
                dispatchId: task.dispatch.dispatch_id,
                roleId: task.dispatch.role_id,
                model: task.dispatch.model ?? null,
                returnChannel: task.dispatch.return_channel ?? null,
              }
            : null,
          submissionId: (task.return && task.return.submission_id) || null,
          lastTransitionAt: task.last_transition_at ?? null,
        })
      }
      tasks.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)))
      return tasks
    } catch {
      return []
    }
  }

  // 线程 preset 装配（create 与 rehydrate 共用）：
  //  - 有 parentAgent：composeFrom 继承其 preset 组合——关键！不 join 的话子 agent
  //    工具面会落到"空全局层"（只有插件工具），让专员线程拥有与主脑一致的
  //    完整宿主工具面（bash/read/write/web_search 等），成功则记 joined 日志；
  //  - 无 parentAgent：回退挂载默认 preset（若有，如 HR 建立流程）。
  // sessionId 用于 joined 日志；logPrefix 区分失败日志来源（rehydrate 传 'resume '）。
  function composePresetFor(agentCtx, parentAgent, sessionId, logPrefix = '') {
    try {
      const presets = agentCtx.get('agentPresets')
      if (!presets) return
      if (parentAgent) {
        const joined = presets.composeFrom(agentCtx, parentAgent.ctx)
        if (joined !== void 0) console.log(TAG, `thread joined preset: ${sessionId} <- ${joined}`)
      } else {
        const id = presets.defaultId
        if (id) void presets.mount(agentCtx, id).catch((e) => console.error(TAG, `${logPrefix}preset mount failed:`, e && e.message))
      }
    } catch (error) {
      console.error(TAG, `${logPrefix}preset compose failed:`, error && error.message)
    }
  }

  function textOfBlocks(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push(String(block.text ?? ''))
      else if (block.type === 'reasoning') parts.push('[思考] ' + String(block.text ?? ''))
      else if (block.type === 'tool-call') {
        const argsPreview = String(block.arguments ?? '').slice(0, TOOL_ARGS_PREVIEW_LEN)
        parts.push('[调用工具 ' + (block.name || '?') + (argsPreview ? ' args=' + argsPreview : '') + ']')
      } else if (block.type === 'tool-result') {
        const nested = textOfBlocks(block.content)
        parts.push('[工具结果' + (block.isError ? ' 错误' : '') + ']' + (nested ? '\n' + nested : ''))
      }
    }
    return parts.join('\n').trim()
  }

  // 组装 create 线程的会话参数：meta（cwd/血缘/深度）、agentOptions（模型配置）、
  // setup（preset 装配回调）。execute 只负责 create 调用、落盘与 seed 发送。
  //
  // 注意：不设 origin —— dsh 前端侧栏 sessionVisible 硬编码跳过 origin==="subagent"，
  // 而 TeamUp 的 worker 是平级协作线程（不是 subagent），与用户手动会话同为顶层会话
  // （origin=undefined）。设置 origin 会导致线程永远进不了侧栏（实测确认）。
  function buildCreatePlan(args, parentAgent) {
    const sessionId = randomUUID()
    const cwd = resolveCwd(args.cwd)
    const parent = args.parentSession ? ctx.agents.get(args.parentSession) : undefined
    const meta = {
      cwd,
      delegationDepth: parent ? ((parent.session.header.delegationDepth ?? 0) + 1) : 1,
      ...(args.parentSession ? { parentSession: args.parentSession } : {}),
      ...(args.preset ? { agentPreset: args.preset } : {}),
    }
    const agentOptions = resolveAgentOptions(args)
    const setup = (agentCtx) => composePresetFor(agentCtx, parentAgent, sessionId)
    return { sessionId, cwd, meta, agentOptions, setup }
  }

  // ---------------- 工具注册 ----------------
  // 注意：dsh 的 register 路径不做 PropertyMap 转换，parameters 必须是标准
  // JSON Schema（{type:'object', properties, required}），output.schema 用
  // {type:'object'}（参照 dseyesopen 的已验证写法）。

  ctx.tools.register({
    name: 'teamup_create_thread',
    description:
      '【TeamUp 编排 - 建线程】Create a new worker thread as a real dsh agent/session. ' +
      '生成 sessionId 作为线程标识（threadId），可选指定工作目录、父线程、agent preset，' +
      '并可通过 seedText 发送线程首条消息（boot prompt / 任务书，自动附加团队纪律）。' +
      '返回的 sessionId 用于 teamup_send_message / teamup_read_thread / teamup_archive_thread。' +
      '主脑纪律：你负责拆任务/派工/验收/汇总，不直接写产品代码；每个任务书要自包含' +
      '（目标/边界/验收/停止条件/回报要求）；派工后等待 worker 主动回报，不轮询不监控' +
      '（仅回报缺失/卡死时读线程恢复）；worker 之间不直接协作，协调经你中转；' +
      '每个文件唯一写所有权，禁止两个 worker 同时改同一处；阶段之间设 gate，重大节点交给用户决策。' +
      '回报协议：worker 的 seed 已注入"完成后必须 teamup_send_message 回报主脑"纪律，' +
      '你收到回报后验收即可，无需主动查岗。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '线程标题（职能名，如"代码落地"）。自动加编号前缀成为"001代码落地"；已带 NNN 前缀则原样使用。' },
        cwd: { type: 'string', description: '线程工作目录，建议绝对路径；缺省为主进程当前目录。' },
        parentSession: { type: 'string', description: '父线程 sessionId（fork 血缘，记账用）；缺省为顶层线程。' },
        preset: { type: 'string', description: 'agent preset id；缺省继承默认 agent 组合。' },
        seedText: { type: 'string', description: '线程首条消息（boot prompt / 任务书），创建成功后立即作为首轮 followup 发送。' },
        provider: { type: 'string', description: '模型 provider（缺省继承主脑/默认配置）。' },
        model: { type: 'string', description: '模型 id（缺省继承主脑/默认配置）。' },
        maxTokens: { type: 'integer', description: '最大输出 token（缺省继承主脑/默认配置）。' },
        teamName: { type: 'string', description: '团队名（可选）。同一团队的线程记同一 teamName，list_threads 按团队分组；用于"保持团队配置"的归属追踪。' },
      },
      required: ['title'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        // 父 agent 决定新线程的工具面继承（composeFrom），见 buildCreatePlan/composePresetFor。
        const parentAgent = ctx.agents.currentInitiator() ?? (args.parentSession ? ctx.agents.get(args.parentSession) : undefined)
        const title = normalizedTitle(args.title)
        const { sessionId, cwd, meta, agentOptions, setup } = buildCreatePlan(args, parentAgent)
        const handle = await ctx.agents.create({ sessionId, meta, agentOptions, setup })
        handles.set(sessionId, handle)
        rememberThread(sessionId, {
          title,
          cwd,
          parentSession: args.parentSession ?? null,
          preset: args.preset ?? null,
          provider: agentOptions.provider ?? null,
          model: agentOptions.model ?? null,
          teamName: args.teamName ?? null,
          createdAt: new Date().toISOString(),
        })
        void attachToWorkspace(sessionId, cwd)
        renameThread(handle.agent.session, title)
        const result = {
          ok: true,
          sessionId,
          title,
          cwd,
          parentSession: args.parentSession ?? null,
          preset: args.preset ?? null,
          seedSent: false,
          // 主脑纪律注入点：create 返回附带完整主脑纪律，主脑每次建线程即被提醒
          // （建队流程/派工标准格式/等待回报不监控/解散总账）。主脑是唯一面向用户的
          // 角色，这是纪律送达的自然渠道。
          mainBrainRules: MAIN_BRAIN_RULES,
        }
        // seed = 用户任务书 + 自动附加团队纪律（worker 侧）。
        // 纪律已含在用户 seed 里则不重复注入（幂等）。
        // 主脑回报地址 = 创建者（currentInitiator）的 sessionId，让 worker 知道回报给谁。
        const mainBrainId = (parentAgent && parentAgent.id) || (args.parentSession || '')
        const workerRules = WORKER_RULES.replace(/\{mainBrainThreadId\}/g, mainBrainId || '（见任务书）')
        let seed = typeof args.seedText === 'string' ? args.seedText.trim() : ''
        if (seed && !seed.includes('TeamUp 协作团队的一名成员')) seed = seed + '\n\n' + workerRules
        if (!seed) seed = workerRules
        try {
          handle.agent.followup(makeUserMessage(seed))
          result.seedSent = true
        } catch (error) {
          result.seedSent = false
          result.seedError = errMsg(error)
        }
        result.seedWithRules = seed.includes('TeamUp 协作团队的一名成员')
        console.log(TAG, `thread created: ${sessionId} (${title})`)
        return result
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'teamup_list_threads',
    description:
      '【TeamUp 编排 - 线程清单】List all live agent threads (id, status, cwd, preset, parent lineage, event count). ' +
      '列出当前存活的全部线程及其元数据，供主脑/HR 掌握团队现状。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      try {
        const threads = collectThreads()
        return { ok: true, count: threads.length, threads }
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'teamup_send_message',
    description:
      '【TeamUp 编排 - 派工】Send a message to a worker thread (agent.followup) and return a durable receipt. ' +
      '发送后回读 session 事件日志确认消息已入账（agent/inbox/spliced 或 user/message 事件），' +
      '2 秒内未确认则返回 confirmed:false——TeamUp 的证据链要求发送结果可检视。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '目标线程 sessionId（teamup_create_thread 返回）。' },
        message: { type: 'string', description: '发送给线程的消息内容（任务/指令/问题）。' },
      },
      required: ['threadId', 'message'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        const agent = ctx.agents.get(args.threadId)
        if (!agent) return { ok: false, error: `thread not found: ${args.threadId}` }
        const userMessage = makeUserMessage(args.message)
        try {
          agent.followup(userMessage)
        } catch (error) {
          return { ok: false, sent: false, error: errMsg(error) }
        }
        // followup 同步把 agent/inbox/spliced 事件写入 session 日志；
        // 轮询兜底等 driver 认领（user/message），超时 2s 则如实回报。
        const evidence = await waitForEvidence(agent, userMessage.id, CONFIRM_TIMEOUT_MS)
        return {
          ok: true,
          sent: true,
          confirmed: evidence !== null,
          messageId: userMessage.id,
          threadId: args.threadId,
          evidence: evidence ?? null,
          status: agent.status,
        }
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'teamup_read_thread',
    description:
      '【TeamUp 编排 - 读线程】Read the recent conversation of a worker thread from its session event log. ' +
      '按 seq 倒序读取该线程最近的 user/assistant/tool 事件并转成带 seq 编号的文本，' +
      'limit 缺省 20，上限 200。' +
      '【使用约束】仅用于验收/审计（worker 主动回报之后核对产出），或异常恢复' +
      '（回报缺失/卡死/疑似工具错误）。禁止日常轮询窥探 worker 进度——' +
      '正常信息流是 worker 主动回报，不读线程看它干到哪了。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '目标线程 sessionId。' },
        limit: { type: 'number', description: '读取的最近消息条数，缺省 20，上限 200。' },
      },
      required: ['threadId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        const agent = ctx.agents.get(args.threadId)
        if (!agent) return { ok: false, error: `thread not found: ${args.threadId}` }
        const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || READ_LIMIT_DEFAULT, 1), READ_LIMIT_MAX)
        const events = agent.session.events
        const lines = []
        let collected = 0
        for (let i = events.length - 1; i >= 0 && collected < limit; i--) {
          const event = events[i]
          let text = ''
          if (event.type === 'user/message') {
            text = textOfBlocks(event.data && event.data.content)
          } else if (event.type === 'assistant/message') {
            text = textOfBlocks(event.data && event.data.message && event.data.message.content)
          } else if (event.type === 'tool/result') {
            text = textOfBlocks(event.data && event.data.message && event.data.message.content)
          } else {
            continue
          }
          if (!text) continue
          lines.push(`[seq ${event.seq}] ${event.type.toUpperCase()} ${text}`)
          collected++
        }
        lines.reverse()
        return {
          ok: true,
          threadId: args.threadId,
          status: agent.status,
          messages: collected,
          totalEvents: events.length,
          text: lines.join('\n\n'),
        }
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'teamup_runtime',
    description:
      '【TeamUp 编排 - 账本 CLI】Invoke the TeamUp event-ledger CLI (teamup_runtime.py) directly. ' +
      '子命令：init / add-task / add-dependency / dispatch / record-message / submit-return / ' +
      'confirm-return / set-mission-state / watchdog-tick / block / reconcile / ready-wave / ' +
      'stats / validate / rebuild。argsJson 传子命令参数数组（字符串），例如 ' +
      '["--store","/path/to/store","--team-id","t1",...]。stdout 为 JSON 时原样解析进 result 字段，' +
      '原始 stdout/stderr 与退出码一并返回。TEAMUP_CONFIRMATION_SECRET 环境变量透传。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'teamup_runtime.py 的子命令名（见工具描述）。' },
        argsJson: { type: 'array', items: { type: 'string' }, description: '子命令的 CLI 参数数组（每个元素一个字符串）。' },
        teamDir: { type: 'string', description: 'python 进程的工作目录（team store 所在目录）；缺省为插件默认目录。' },
      },
      required: ['command'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        const command = String(args.command || '')
        const argList = args.argsJson ?? []
        if (!Array.isArray(argList) || argList.some((a) => typeof a !== 'string')) {
          return { ok: false, error: 'argsJson must be an array of strings' }
        }
        const cwd = resolveCwd(args.teamDir)
        const proc = spawnSync('python3', [runtimeScriptPath, command, ...argList], {
          cwd,
          encoding: 'utf8',
          timeout: RUNTIME_TIMEOUT_MS,
          env: process.env, // TEAMUP_CONFIRMATION_SECRET 透传
          maxBuffer: RUNTIME_MAX_BUFFER,
        })
        const timedOut = !!(proc.error && proc.error.code === 'ETIMEDOUT')
        const result = {
          ok: proc.status === 0 && !timedOut,
          status: proc.status,
          signal: proc.signal ?? null,
          timedOut,
          command,
          args: argList,
          cwd,
          stdout: String(proc.stdout || '').trim(),
          stderr: String(proc.stderr || '').trim(),
        }
        if (proc.error && !timedOut) {
          result.ok = false
          result.spawnError = String((proc.error && proc.error.message) || proc.error)
        }
        if (result.stdout) {
          try {
            result.result = JSON.parse(result.stdout)
          } catch {
            // 非 JSON 输出保持原样文本，不解析
          }
        }
        return result
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'teamup_archive_thread',
    description:
      '【TeamUp 编排 - 归档线程】Archive a worker thread: stop its loop, unregister the agent and remove its session. ' +
      '调用 AgentHandle.dispose() 彻底停掉并移除线程。dsh 的 dispose 是创建者持有的能力，' +
      '因此只能归档由本插件（teamup_create_thread）创建的线程。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '要归档的线程 sessionId。' },
      },
      required: ['threadId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        const handle = handles.get(args.threadId)
        if (!handle) {
          const live = ctx.agents.get(args.threadId)
          if (live) {
            return {
              ok: false,
              error: `thread ${args.threadId} is live but was not created by this plugin; dispose is a creator-only capability, cannot archive foreign threads`,
            }
          }
          return { ok: false, error: `thread not found: ${args.threadId}` }
        }
        await handle.dispose()
        handles.delete(args.threadId)
        forgetThread(args.threadId)
        console.log(TAG, `thread archived: ${args.threadId}`)
        return { ok: true, sessionId: args.threadId, archived: true }
      } catch (error) {
        return { ok: false, error: errMsg(error) }
      }
    },
  })

  // ---- Web 协作面板数据通道 ----
  // /teamup/api 前缀路由：向 client bundle（侧栏面板）提供线程清单、注册表与
  // 账本概览。信任围栏（同源/回环/trustedHosts 放行，跨站 403）包住全部方法。
  // 写面最小化：仅 POST /ledger/submit、/ledger/confirm（面板一键记账），
  // 其余一律只读 GET。线程/账本数据与 teamup_list_threads / teamup_runtime
  // 工具同一数据源（collectThreads / CLI stats），保证一致。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/teamup/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime ? ctx.webRuntime.trustedHosts : [])) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const rest = pathname.startsWith('/teamup/api') ? pathname.slice('/teamup/api'.length) : ''
      try {
        if (req.method === 'GET') {
          if (rest === '' || rest === '/' || rest === '/threads') {
            const threads = collectThreads()
            writeJson(res, 200, { ok: true, count: threads.length, threads })
          } else if (rest === '/registry') {
            writeJson(res, 200, { ok: true, registry: loadRegistry() })
          } else if (rest === '/ledger') {
            ensureLedgerInitialized()
            const statsRun = runLedgerCli('stats')
            const tasks = readLedgerTasks()
            if (!statsRun.ok) throw new Error(`ledger stats failed: ${statsRun.stderr || statsRun.stdout}`)
            writeJson(res, 200, {
              ok: true,
              store: ledgerStore,
              teamId: ledgerTeamId,
              initialized: true,
              team: readLedgerTeamMeta(),
              stats: statsRun.result, // 与 CLI stats 输出同源（同一进程同一命令）
              tasks,
            })
          } else {
            writeJson(res, 404, { ok: false, error: 'not found' })
          }
          return
        }
        if (req.method === 'POST') {
          if (rest !== '/ledger/submit' && rest !== '/ledger/confirm') {
            writeJson(res, 404, { ok: false, error: 'not found' })
            return
          }
          ensureLedgerInitialized()
          const body = await readJsonBody(req)
          const taskId = String(body.taskId || '').trim()
          // taskId 白名单（与 teamup_runtime.py 的 TEAM_ID_RE 同风格纵深防御）；
          // 缺失或含非法字符一律 400，不让脏输入进账本 CLI。
          if (!taskId || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
            writeJson(res, 400, { ok: false, error: 'invalid taskId (allowed: A-Za-z0-9._-)' })
            return
          }
          if (rest === '/ledger/submit') {
            // 一键「记回报」：worker 回报到达、主脑确认后点击 → submit-return
            const submissionId = randomUUID()
            const run = runLedgerCli('submit-return', taskId, '--submission-id', submissionId)
            if (!run.ok) throw new Error(run.stderr || run.stdout || 'submit-return failed')
            writeJson(res, 200, { ok: true, taskId, submissionId, event: run.result })
          } else {
            // 一键「确认」：主脑验收回报 → confirm-return（需确认权柄：
            // 环境变量 TEAMUP_CONFIRMATION_SECRET 或 <store>/confirmation.secret）
            const tasks = readLedgerTasks()
            const task = tasks.find((t) => t.taskId === taskId)
            const submissionId = String(body.submissionId || '').trim() || (task && task.submissionId) || null
            if (!submissionId) throw new Error('submissionId is required (task has no recorded submission)')
            const secretArgs = process.env.TEAMUP_CONFIRMATION_SECRET
              ? ['--confirmation-secret-env', 'TEAMUP_CONFIRMATION_SECRET']
              : ['--confirmation-secret-file', ledgerSecretFile]
            const receiptId = randomUUID()
            const run = runLedgerCli(
              'confirm-return', taskId,
              '--submission-id', submissionId,
              '--receipt-id', receiptId,
              // 面板「确认」= 主脑声明已观察/验收该回报（destination-observed 收据）
              '--destination-observed',
              '--confirmed-by-thread-id', resolveMainBrainThreadId(),
              ...secretArgs,
            )
            if (!run.ok) throw new Error(run.stderr || run.stdout || 'confirm-return failed')
            writeJson(res, 200, { ok: true, taskId, submissionId, receiptId, event: run.result })
          }
          return
        }
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errMsg(error) })
      }
    },
  }), 'dshteamup: /teamup/api routes')

  // 卸载清理：只清 handles 内存映射，不 dispose 线程。
  // 线程是用户资产（持续存在的协作会话），插件重载/部署时 dispose 会导致线程团灭；
  // 明确的归档（teamup_archive_thread）才调用 dispose。handles 引用随插件消失后，
  // 线程仍在 agents 注册表里存活，可被 teamup_list/read/send 继续访问。
  ctx.effect(function* () {
    yield () => {
      const count = handles.size
      handles.clear()
      if (count > 0) console.log(TAG, `plugin unload: cleared ${count} handle refs (threads kept alive)`)
    }
  })

  // ---- 启动恢复（rehydration） ----
  // 重启后落盘线程不在 agent 注册表里（agents 是内存态）。启动时扫描 registry，
  // 对未加载的线程用 ctx.agents.resume() 重新挂载，重建 handles，让
  // send/read/archive 重新可达。失败（会话损坏/服务未就绪）不阻塞启动。
  async function rehydrateThreads() {
    const registry = loadRegistry()
    // nextNumber 是计数器字段，不是线程条目，跳过
    const ids = Object.keys(registry).filter((k) => k !== 'nextNumber')
    if (ids.length === 0) return 0
    let restored = 0
    for (const sessionId of ids) {
      try {
        if (ctx.agents.get(sessionId)) continue
        const info = registry[sessionId]
        const agentOptions = pickAgentOptions(info)
        // rehydrate 无调用方 agent，只挂默认 preset（若有）。
        const setup = (agentCtx) => composePresetFor(agentCtx, undefined, sessionId, 'resume ')
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        handles.set(sessionId, handle)
        restored += 1
        console.log(TAG, `thread rehydrated: ${sessionId} (${info.title || '?'})`)
        void attachToWorkspace(sessionId, info.cwd || defaultTeamDir)
        if (info.title) renameThread(handle.agent.session, info.title)
      } catch (error) {
        console.error(TAG, `rehydrate failed for ${sessionId}:`, error && error.message)
      }
    }
    return restored
  }

  // 启动即尝试；agentPresets/sessionPersistence 服务可能晚于本插件初始化，
  // 按阶梯重试直到全部线程恢复或确认无法恢复。
  REHYDRATE_RETRY_DELAYS_MS.forEach((delay, index) => {
    setTimeout(() => {
      rehydrateThreads().then((n) => {
        if (n > 0 || index === REHYDRATE_RETRY_DELAYS_MS.length - 1) console.log(TAG, `rehydration pass ${index + 1}: restored ${n}/${Object.keys(loadRegistry()).length}`)
      }, (e) => console.error(TAG, 'rehydration pass failed:', e && e.message))
    }, delay)
  })

  console.log(TAG, 'loaded; TeamUp orchestration tools registered (6 tools, runtime:', runtimeScriptPath + ')')
}
