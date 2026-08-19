/**
 * dshteamup — TeamUp 团队编排的 dsh 适配层。
 *
 * TeamUp 是从 Codex 移植的多线程编排 skill（主脑/worker/HR 角色、hub-and-spoke
 * 派工、事件账本审计）。本插件把它的 "thread tools 七件套" 映射到 dsh 官方 API：
 *
 *  - teamup_create_thread  通过 ctx.agents.create（dsh-agent 的 AgentRegistry）
 *    创建真实的 dsh agent + session（多线程），返回 sessionId 作为线程标识；
 *  - teamup_list_threads   列出所有 live agents 及元数据（cwd/preset/父线程等）；
 *  - teamup_send_message   向线程发 followup，并回读 session 事件日志做
 *    "已入账" 回执（TeamUp 证据链要求发送结果可检视）；
 *  - teamup_read_thread    读线程最近会话事件（user/assistant/tool 三类），
 *    带 seq 编号，可供主脑/HR 审计；
 *  - teamup_runtime        透传调用 teamup_runtime.py（事件账本 CLI），
 *    JSON 输出原样返回，TEAMUP_CONFIRMATION_SECRET 环境变量透传；
 *  - teamup_archive_thread 通过 AgentHandle.dispose() 归档线程。
 *
 * 账本与协议（init/dispatch/record-message/submit-return/confirm-return 等）
 * 仍由 teamup_runtime.py 承担，本插件只做 "dsh 线程 <-> 账本" 的传输层。
 * 不修改 teamup_runtime.py 与 SKILL.md。
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'

export const name = 'dshteamup'
export const inject = ['agents', 'timer', 'tools']

const TAG = '[dshteamup]'
const RUNTIME_SCRIPT = 'teamup_runtime.py'
const CONFIRM_TIMEOUT_MS = 2000
const READ_LIMIT_DEFAULT = 20
const READ_LIMIT_MAX = 200
const RUNTIME_TIMEOUT_MS = 120000
const RUNTIME_MAX_BUFFER = 16 * 1024 * 1024

// 插件根目录（lib/ 的上一级），teamup_runtime.py 的绝对路径从这里解析。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const RUNTIME_SCRIPT_PATH = resolve(PLUGIN_DIR, '..', RUNTIME_SCRIPT)

export function apply(ctx, config = {}) {
  // sessionId -> AgentHandle。dispose 能力只在创建者手里（dsh-agent 的
  // CAPABILITY 设计），所以归档只能归档本插件创建的线程。
  const handles = new Map()

  const runtimeScriptPath = config.runtimeScriptPath ?? RUNTIME_SCRIPT_PATH
  const defaultTeamDir = config.teamDir ?? process.cwd()

  // 短睡眠：优先用 timer 服务的 promise 形式（随 ctx 生命周期销毁），
  // 兜底 Node 全局 setTimeout。
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
      await sleep(100)
      evidence = findEvidence(agent, messageId)
    }
    return evidence
  }

  // meta.cwd 必须为绝对路径（session 边界校验），相对路径按主进程 cwd 解析。
  function resolveCwd(cwd) {
    if (!cwd) return defaultTeamDir
    return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
  }

  function textOfBlocks(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push(String(block.text ?? ''))
      else if (block.type === 'reasoning') parts.push('[思考] ' + String(block.text ?? ''))
      else if (block.type === 'tool-call') {
        const argsPreview = String(block.arguments ?? '').slice(0, 120)
        parts.push('[调用工具 ' + (block.name || '?') + (argsPreview ? ' args=' + argsPreview : '') + ']')
      } else if (block.type === 'tool-result') {
        const nested = textOfBlocks(block.content)
        parts.push('[工具结果' + (block.isError ? ' 错误' : '') + ']' + (nested ? '\n' + nested : ''))
      }
    }
    return parts.join('\n').trim()
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
      },
      required: ['title'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
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
        const handle = await ctx.agents.create({ sessionId, meta })
        handles.set(sessionId, handle)
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
            result.seedError = String((error && error.message) || error)
          }
        }
        console.log(TAG, `thread created: ${sessionId} (${args.title})`)
        return result
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
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
        return { ok: false, error: String((error && error.message) || error) }
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
          return { ok: false, sent: false, error: String((error && error.message) || error) }
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
        return { ok: false, error: String((error && error.message) || error) }
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
        return { ok: false, error: String((error && error.message) || error) }
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
        return { ok: false, error: String((error && error.message) || error) }
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
        console.log(TAG, `thread archived: ${args.threadId}`)
        return { ok: true, sessionId: args.threadId, archived: true }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  })

  // 卸载清理：归档本插件创建的所有线程。
  // disposer 执行时服务可能已销毁，dispose 的 Promise 必须挂 catch，
  // 否则 unhandled rejection 会被 cordis 判为 fatal load failure（同 dseyesopen）。
  ctx.effect(function* () {
    yield () => {
      for (const [sessionId, handle] of handles) {
        try {
          const pending = handle.dispose()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
          console.log(TAG, `thread disposed on plugin unload: ${sessionId}`)
        } catch (error) {
          console.error(TAG, 'failed to dispose thread on unload:', error && error.message)
        }
      }
      handles.clear()
    }
  })

  console.log(TAG, 'loaded; TeamUp orchestration tools registered (6 tools, runtime:', runtimeScriptPath + ')')
}
