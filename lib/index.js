/**
 * dshteamup — TeamUp 团队编排的 dsh 适配层。
 *
 * TeamUp 是从 Codex 移植的多线程编排 skill（主脑/worker/HR 角色、hub-and-spoke
 * 派工、事件账本审计）。本插件把它的线程工具映射到 dsh 官方 API：
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
export const inject = ['agents', 'timer', 'tools', 'workspaceRegistry']

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
  function buildCreatePlan(args, parentAgent) {
    const sessionId = randomUUID()
    const cwd = resolveCwd(args.cwd)
    const parent = args.parentSession ? ctx.agents.get(args.parentSession) : undefined
    const meta = {
      cwd,
      origin: 'subagent',
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
      '并可通过 seedText 发送线程首条消息（boot prompt / 任务书）。' +
      '返回的 sessionId 用于 teamup_send_message / teamup_read_thread / teamup_archive_thread。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '线程标题/用途说明（如 worker 角色名），用于识别与日志。' },
        cwd: { type: 'string', description: '线程工作目录，建议绝对路径；缺省为主进程当前目录。' },
        parentSession: { type: 'string', description: '父线程 sessionId（fork 血缘，记账用）；缺省为顶层线程。' },
        preset: { type: 'string', description: 'agent preset id；缺省继承默认 agent 组合。' },
        seedText: { type: 'string', description: '线程首条消息（boot prompt / 任务书），创建成功后立即作为首轮 followup 发送。' },
        provider: { type: 'string', description: '模型 provider（缺省继承主脑/默认配置）。' },
        model: { type: 'string', description: '模型 id（缺省继承主脑/默认配置）。' },
        maxTokens: { type: 'integer', description: '最大输出 token（缺省继承主脑/默认配置）。' },
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
        const { sessionId, cwd, meta, agentOptions, setup } = buildCreatePlan(args, parentAgent)
        const handle = await ctx.agents.create({ sessionId, meta, agentOptions, setup })
        handles.set(sessionId, handle)
        rememberThread(sessionId, {
          title: args.title,
          cwd,
          parentSession: args.parentSession ?? null,
          preset: args.preset ?? null,
          provider: agentOptions.provider ?? null,
          model: agentOptions.model ?? null,
          createdAt: new Date().toISOString(),
        })
        void attachToWorkspace(sessionId, cwd)
        const result = {
          ok: true,
          sessionId,
          title: args.title,
          cwd,
          parentSession: args.parentSession ?? null,
          preset: args.preset ?? null,
          seedSent: false,
        }
        if (typeof args.seedText === 'string' && args.seedText.trim().length > 0) {
          try {
            handle.agent.followup(makeUserMessage(args.seedText))
            result.seedSent = true
          } catch (error) {
            result.seedSent = false
            result.seedError = errMsg(error)
          }
        }
        console.log(TAG, `thread created: ${sessionId} (${args.title})`)
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
        const threads = ctx.agents.list().map((agent) => {
          const header = agent.session.header
          return {
            sessionId: agent.id,
            status: agent.status,
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
      '供主脑验收 worker 产出或 HR 审计（证据链）。limit 缺省 20，上限 200。',
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
    const ids = Object.keys(registry)
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
