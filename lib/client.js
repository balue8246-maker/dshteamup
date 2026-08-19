/**
 * dshteamup — Web 协作面板（client half，最小可用版）。
 *
 * 形态：client bundle 纯度门约束下的手写 bundle（`window.__ModuleLoader__.load`），
 * factory 只 require 平台种子词（react / react-dom，见 dsh-client-web 的
 * PLATFORM_MODULES），不跨插件 value import，不引第三方依赖。
 *
 * 挂载点：官方 list slot `sidebar.footer.action`（不抢注 single slot「sidebar」，
 * 不与任何单占位冲突）。按钮点击后经 createPortal 挂到 document.body 的
 * 浮层面板，数据来自 host 侧 /teamup/api（同源 fetch，host 有 trustedHosts 围栏）。
 *
 * 面板内容（四个标签页，均 15s 自动刷新 + in-flight 去重，无重叠请求）：
 *  - 状态：主脑状态板——每线程「期望状态（badge + 手动覆盖 select）」vs
 *    「实际状态（idle/running + 最后活动 staleness）」+ 偏差高亮（期望 working
 *    但 idle 超阈值→🔴 疑似中断；期望 idle/paused/done 但 running→🟡）；
 *    数据来自 /teamup/api/expectations（host 端 computeStatusBoard）。
 *  - 账本：任务概览（编号/状态/阶段/依赖/派发角色）+ 聚合 stats，与
 *    teamup_runtime CLI stats 同源；一键记账——DISPATCHED 任务「记回报」
 *    （submit-return）、已回报任务「确认」（confirm-return，主脑验收后点击）。
 *  - 锁：文件锁列表（路径/持有者/时间/原因）+ 主脑强制释放按钮（面板=主脑
 *    操作台）；与 teamup_list_locks 工具同源（host 共用 lockList()）。
 *  - 审批：待裁决审批（谁/操作/原因/时间 + 批准/拒绝）与最近已裁决列表。
 *
 * 依赖边说明：package.json 的 dsh.client.inject 声明的是模块表依赖边
 * （@deepseek-ai/dsh-client-runtime / dsh-client-ui-slots，供 host 侧
 * ClientModuleRegistry 组 boot graph），与 bundle 内部实际 require 无关——
 * 本 bundle 实际只 require 平台种子词 react / react-dom（dsh-client-web 的
 * PLATFORM_MODULES 静态模块），风格与 dsh-better-sidebar 一致：跨插件
 * value import 一律禁止（纯度门），本 bundle 零跨插件依赖。
 */

window.__ModuleLoader__.load({
  id: 'dshteamup',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useState, useEffect, useCallback, useRef } = React

    // ---- 样式（一次性注入；.tu- 前缀防污染 shell） ----
    const STYLE_TEXT = [
      '.tu-action{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa3b5);cursor:pointer;font-size:12px;line-height:1}',
      '.tu-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e9ef)}',
      '.tu-panel{position:fixed;right:16px;bottom:64px;width:360px;max-width:calc(100vw - 32px);max-height:min(60vh,560px);display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#1f2430);color:var(--dsw-alias-label-primary,#e6e9ef);border:1px solid var(--dsw-alias-border-l2,#333a4a);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);z-index:2147483000;font-size:13px;overflow:hidden;font-family:inherit}',
      '.tu-panel-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#333a4a);flex:none}',
      '.tu-tabs{display:flex;gap:4px;flex:1;min-width:0}',
      '.tu-tab{cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,#9aa3b5);border:none;border-radius:6px;padding:2px 10px;font-size:12px;line-height:20px}',
      '.tu-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
      '.tu-tab-active{background:var(--dsw-alias-button-elevated-fill,#2b3242);color:var(--dsw-alias-label-primary,#e6e9ef)}',
      '.tu-btn{cursor:pointer;background:var(--dsw-alias-button-elevated-fill,#2b3242);color:inherit;border:1px solid var(--dsw-alias-border-l2,#3a4256);border-radius:6px;padding:2px 8px;font-size:12px;line-height:18px}',
      '.tu-btn:disabled{opacity:.5;cursor:default}',
      '.tu-btn-close{padding:2px 6px}',
      '.tu-btn-mini{padding:0 6px;font-size:11px;line-height:16px}',
      '.tu-thread-list,.tu-ledger-list{overflow-y:auto;flex:1;min-height:0;padding:4px 0}',
      '.tu-group-head{display:flex;align-items:center;gap:6px;padding:6px 12px 2px;color:var(--dsw-alias-label-secondary,#9aa3b5);font-size:12px}',
      '.tu-group-name{font-weight:600}',
      '.tu-group-count{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.tu-thread,.tu-ledger-task{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}',
      '.tu-thread-main{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tu-thread-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.tu-thread-meta{display:flex;gap:10px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow:hidden}',
      '.tu-thread-id,.tu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.tu-status-idle{color:var(--dsw-alias-label-tertiary,#8b93a5)}',
      '.tu-status-running{color:#34d399}',
      '.tu-ledger-meta{padding:6px 12px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;display:flex;flex-wrap:wrap;gap:2px 10px}',
      '.tu-ledger-status{font-size:11px;flex:none}',
      '.tu-ledger-status-pending,.tu-ledger-status-hold{color:var(--dsw-alias-label-tertiary,#8b93a5)}',
      '.tu-ledger-status-dispatched{color:#60a5fa}',
      '.tu-ledger-status-claimed,.tu-ledger-status-submitted{color:#fbbf24}',
      '.tu-ledger-status-confirmed{color:#34d399}',
      '.tu-ledger-status-blocked,.tu-ledger-status-stale{color:#f87171}',
      '.tu-ledger-actions{display:flex;gap:6px;margin-top:4px}',
      '.tu-ledger-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b93a5)}',
      '.tu-lock{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}',
      '.tu-lock-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.tu-lock-meta{display:flex;gap:10px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow:hidden}',
      '.tu-approval{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}',
      '.tu-approval-action{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.tu-approval-meta{display:flex;gap:10px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow:hidden}',
      '.tu-approval-reason{margin-top:2px;color:var(--dsw-alias-label-secondary,#9aa3b5);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tu-approval-actions{display:flex;gap:6px;margin-top:4px}',
      '.tu-approval-allow{color:#34d399}',
      '.tu-approval-reject{color:#f87171}',
      '.tu-approval-cancelled,.tu-approval-unavailable{color:var(--dsw-alias-label-tertiary,#8b93a5)}',
      '.tu-exp{font-size:11px;flex:none;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a4256);color:var(--dsw-alias-label-secondary,#9aa3b5)}',
      '.tu-exp-working{color:#60a5fa;border-color:rgba(96,165,250,.45)}',
      '.tu-exp-done{color:#34d399;border-color:rgba(52,211,153,.45)}',
      '.tu-exp-paused{color:#fbbf24;border-color:rgba(251,191,36,.45)}',
      '.tu-exp-awaiting-return{color:#c084fc;border-color:rgba(192,132,252,.45)}',
      '.tu-dev-red{color:#f87171;font-weight:600}',
      '.tu-dev-yellow{color:#fbbf24}',
      '.tu-board-row{border-left:3px solid transparent}',
      '.tu-board-row.tu-dev-red-row{border-left-color:#f87171;background:rgba(248,113,113,.06)}',
      '.tu-board-row.tu-dev-yellow-row{border-left-color:#fbbf24;background:rgba(251,191,36,.05)}',
      '.tu-panel-hint,.tu-panel-error{padding:16px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa3b5)}',
      '.tu-panel-error{color:#f87171}',
      '.tu-panel-foot{display:flex;justify-content:space-between;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2,#333a4a);color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;flex:none}'
    ].join('')

    function ensureStyles() {
      if (document.getElementById('dshteamup-client-styles')) return
      const style = document.createElement('style')
      style.id = 'dshteamup-client-styles'
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
    }

    // ---- 数据 ----
    const STATUS_LABELS = { idle: '空闲', running: '运行中' }
    // 期望状态（主脑状态板）中文标签
    const EXPECTED_LABELS = {
      working: '应干活',
      idle: '应空闲',
      paused: '应暂停',
      'awaiting-return': '等回报',
      done: '已完成',
    }
    const LEDGER_STATUS = {
      PENDING: { label: '待派发', cls: 'tu-ledger-status-pending' },
      DISPATCHED: { label: '已派发', cls: 'tu-ledger-status-dispatched' },
      RETURN_CLAIMED_UNOBSERVED: { label: '回报待观察', cls: 'tu-ledger-status-claimed' },
      RETURN_SUBMITTED_UNCONFIRMED: { label: '已回报待确认', cls: 'tu-ledger-status-submitted' },
      RETURN_CONFIRMED: { label: '已确认', cls: 'tu-ledger-status-confirmed' },
      BLOCKED: { label: '阻塞', cls: 'tu-ledger-status-blocked' },
      STALE: { label: '过期', cls: 'tu-ledger-status-stale' },
      HOLD: { label: '挂起', cls: 'tu-ledger-status-hold' },
    }

    function statusLabel(status) {
      return STATUS_LABELS[status] || String(status || 'unknown')
    }

    function ledgerStatusMeta(status) {
      return LEDGER_STATUS[status] || { label: String(status || 'unknown'), cls: 'tu-ledger-status-pending' }
    }

    function shortId(id) {
      return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id || '?')
    }

    // 统一 fetch：同源 + no-store；错误面统一为 {ok:false,error} 的 message。
    function fetchJson(url, options) {
      const opts = options || {}
      return fetch(url, {
        method: opts.method || 'GET',
        headers: { accept: 'application/json', ...(opts.headers || {}) },
        body: opts.body,
        cache: 'no-store',
      }).then(async (res) => {
        let body = null
        try {
          body = await res.json()
        } catch { /* 非 JSON 响应按 HTTP 状态报错 */ }
        if (!res.ok || body === null || body.ok !== true) {
          throw new Error(body && body.error ? String(body.error) : `HTTP ${res.status}`)
        }
        return body
      })
    }

    function fetchLedger() {
      return fetchJson('/teamup/api/ledger')
    }

    // 一键记账：submit-return / confirm-return（信任围栏在 host 侧把关）
    function postLedgerAction(action, taskId, submissionId) {
      return fetchJson('/teamup/api/ledger/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submissionId ? { taskId, submissionId } : { taskId }),
      })
    }

    function fetchLocks() {
      return fetchJson('/teamup/api/locks')
    }

    // 面板=主脑操作台：释放任意锁（host 侧按 panel/主脑身份放行）
    function releaseLock(path) {
      return fetchJson('/teamup/api/locks/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }

    function fetchApprovals() {
      return fetchJson('/teamup/api/approvals')
    }

    // 主脑裁决审批：批准 allowed-once / 拒绝 rejected（与 teamup_decide_approval 同路径）
    function decideApproval(approvalId, approved) {
      return fetchJson('/teamup/api/approval/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId, outcome: approved ? 'allowed-once' : 'rejected' }),
      })
    }

    function fetchExpectations() {
      return fetchJson('/teamup/api/expectations')
    }

    // ---- 面板 ----
    function TeamUpPanel({ onClose }) {
      const [tab, setTab] = useState('threads')
      const [boardData, setBoardData] = useState({ loading: true, error: null, rows: [], fetchedAt: null })
      const [ledgerData, setLedgerData] = useState({ loading: true, error: null, data: null, fetchedAt: null })
      const [locksData, setLocksData] = useState({ loading: true, error: null, locks: [], fetchedAt: null })
      const [approvalData, setApprovalData] = useState({ loading: true, error: null, data: null, fetchedAt: null })
      const [actionBusy, setActionBusy] = useState(null) // 正在记账/释放/裁决/设期望的 id
      // in-flight 去重（状态板/账本/锁/审批各自独立）：上一请求未返回时，15s 自动刷新/
      // 手动刷新直接跳过本次，杜绝重叠请求（慢响应 + 周期 tick 不会并发堆积）。
      const inFlightRef = useRef({ board: false, ledger: false, locks: false, approvals: false })

      // 主脑状态板：期望 vs 实际 + 偏差
      const loadBoard = useCallback(() => {
        if (inFlightRef.current.board) return
        inFlightRef.current.board = true
        let alive = true
        // loading 只在无数据时置位：已有数据的刷新不再重置 loading 态（防闪烁）
        setBoardData((prev) => (prev.rows.length === 0 ? { ...prev, loading: true, error: null } : prev))
        fetchExpectations().then(
          (body) => {
            if (!alive) return
            inFlightRef.current.board = false
            setBoardData({ loading: false, error: null, rows: body.rows || [], fetchedAt: new Date() })
          },
          (error) => {
            if (!alive) return
            inFlightRef.current.board = false
            setBoardData((prev) => ({
              ...prev,
              loading: false,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
        return () => {
          alive = false
        }
      }, [])

      const loadLedger = useCallback(() => {
        if (inFlightRef.current.ledger) return
        inFlightRef.current.ledger = true
        let alive = true
        setLedgerData((prev) => (prev.data === null ? { ...prev, loading: true, error: null } : prev))
        fetchLedger().then(
          (body) => {
            if (!alive) return
            inFlightRef.current.ledger = false
            setLedgerData({ loading: false, error: null, data: body, fetchedAt: new Date() })
          },
          (error) => {
            if (!alive) return
            inFlightRef.current.ledger = false
            setLedgerData((prev) => ({
              ...prev,
              loading: false,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
        return () => {
          alive = false
        }
      }, [])

      const loadLocks = useCallback(() => {
        if (inFlightRef.current.locks) return
        inFlightRef.current.locks = true
        let alive = true
        setLocksData((prev) => (prev.locks.length === 0 ? { ...prev, loading: true, error: null } : prev))
        fetchLocks().then(
          (body) => {
            if (!alive) return
            inFlightRef.current.locks = false
            setLocksData({ loading: false, error: null, locks: body.locks || [], fetchedAt: new Date() })
          },
          (error) => {
            if (!alive) return
            inFlightRef.current.locks = false
            setLocksData((prev) => ({
              ...prev,
              loading: false,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
        return () => {
          alive = false
        }
      }, [])

      const loadApprovals = useCallback(() => {
        if (inFlightRef.current.approvals) return
        inFlightRef.current.approvals = true
        let alive = true
        setApprovalData((prev) => (prev.data === null ? { ...prev, loading: true, error: null } : prev))
        fetchApprovals().then(
          (body) => {
            if (!alive) return
            inFlightRef.current.approvals = false
            setApprovalData({ loading: false, error: null, data: body, fetchedAt: new Date() })
          },
          (error) => {
            if (!alive) return
            inFlightRef.current.approvals = false
            setApprovalData((prev) => ({
              ...prev,
              loading: false,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => loadBoard(), [loadBoard])
      useEffect(() => loadLedger(), [loadLedger])
      useEffect(() => loadLocks(), [loadLocks])
      useEffect(() => loadApprovals(), [loadApprovals])
      // 面板打开期间每 15s 自动刷新四个数据源（与手动刷新同一条 load 路径）
      useEffect(() => {
        const timer = window.setInterval(() => {
          loadBoard()
          loadLedger()
          loadLocks()
          loadApprovals()
        }, 15000)
        return () => window.clearInterval(timer)
      }, [loadBoard, loadLedger, loadLocks, loadApprovals])

      // 一键记账：成功后刷新账本；失败把错误展示在账本区块
      const doLedgerAction = useCallback((action, taskId, submissionId) => {
        if (actionBusy) return
        setActionBusy(taskId)
        postLedgerAction(action, taskId, submissionId).then(
          () => {
            setActionBusy(null)
            loadLedger()
          },
          (error) => {
            setActionBusy(null)
            setLedgerData((prev) => ({
              ...prev,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
      }, [actionBusy, loadLedger])

      // 主脑强制释放锁（面板=主脑操作台）：成功后刷新锁列表
      const doReleaseLock = useCallback((path) => {
        if (actionBusy) return
        setActionBusy(path)
        releaseLock(path).then(
          () => {
            setActionBusy(null)
            loadLocks()
          },
          (error) => {
            setActionBusy(null)
            setLocksData((prev) => ({
              ...prev,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
      }, [actionBusy, loadLocks])

      // 主脑裁决审批：批准/拒绝后刷新审批中心
      const doDecideApproval = useCallback((approvalId, approved) => {
        if (actionBusy) return
        setActionBusy(approvalId)
        decideApproval(approvalId, approved).then(
          () => {
            setActionBusy(null)
            loadApprovals()
          },
          (error) => {
            setActionBusy(null)
            setApprovalData((prev) => ({
              ...prev,
              error: error && error.message ? error.message : String(error),
            }))
          }
        )
      }, [actionBusy, loadApprovals])

      // ---- 主脑状态板标签页内容（期望 vs 实际 + 偏差，纯只读展示） ----
      let threadContent
      if (boardData.error) {
        threadContent = React.createElement('div', { className: 'tu-panel-error' }, '加载失败：', boardData.error)
      } else if (boardData.loading && boardData.rows.length === 0) {
        threadContent = React.createElement('div', { className: 'tu-panel-hint' }, '加载中…')
      } else if (boardData.rows.length === 0) {
        threadContent = React.createElement('div', { className: 'tu-panel-hint' }, '暂无 live 线程')
      } else {
        const devRows = boardData.rows.filter((r) => r.deviation)
        threadContent = React.createElement('div', { className: 'tu-thread-list' },
          boardData.rows.map((r) => {
            const dev = r.deviation
            const rowCls = 'tu-thread tu-board-row' + (dev ? (dev.level === 'red' ? ' tu-dev-red-row' : ' tu-dev-yellow-row') : '')
            const staleness = r.stalenessSeconds === null
              ? '无活动记录'
              : (r.stalenessSeconds < 60 ? r.stalenessSeconds + ' 秒前活动' : Math.floor(r.stalenessSeconds / 60) + ' 分钟前活动')
            return React.createElement('div', {
              className: rowCls,
              key: r.threadId,
              title: r.threadId,
            },
              React.createElement('div', { className: 'tu-thread-main' },
                React.createElement('span', { className: 'tu-thread-title' }, r.title || shortId(r.threadId)),
                React.createElement('span', {
                  className: 'tu-thread-status tu-status-' + String(r.status || 'unknown').toLowerCase(),
                }, statusLabel(r.status)),
                // 期望状态 badge（纯只读，由派工/验收/暂停/恢复自动流转）
                React.createElement('span', {
                  className: 'tu-exp tu-exp-' + (r.expected || ''),
                  title: r.expectedSetBy ? '自动/内部维护：' + r.expectedSetBy : '',
                }, r.expected ? EXPECTED_LABELS[r.expected] || r.expected : '未设')
              ),
              React.createElement('div', { className: 'tu-thread-meta' },
                r.taskId ? React.createElement('span', { className: 'tu-mono' }, '任务 ', r.taskId) : null,
                r.expectedSetBy ? React.createElement('span', null, '来源 ', r.expectedSetBy) : null,
                React.createElement('span', null, staleness)
              ),
              dev
                ? React.createElement('div', { className: 'tu-thread-meta tu-dev-' + dev.level },
                    React.createElement('span', null, dev.level === 'red' ? '🔴' : '🟡', ' ', dev.label)
                  )
                : null
            )
          })
        )
        if (devRows.length > 0) {
          threadContent = React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'tu-group-head' },
              React.createElement('span', { className: 'tu-group-name tu-dev-red' }, '偏差 ', devRows.length)
            ),
            threadContent
          )
        }
      }

      // ---- 账本标签页内容 ----
      let ledgerContent
      if (ledgerData.error) {
        ledgerContent = React.createElement('div', { className: 'tu-panel-error' }, '加载失败：', ledgerData.error)
      } else if (ledgerData.loading && ledgerData.data === null) {
        ledgerContent = React.createElement('div', { className: 'tu-panel-hint' }, '加载中…')
      } else {
        const d = ledgerData.data || {}
        const team = d.team || {}
        const stats = d.stats || {}
        const tasks = d.tasks || []
        ledgerContent = React.createElement('div', { className: 'tu-ledger-list' },
          React.createElement('div', { className: 'tu-ledger-meta' },
            React.createElement('span', null, team.emoji || '📒', ' ', team.mode || '—'),
            team.mainBrainThreadId ? React.createElement('span', null, '主脑 ', shortId(team.mainBrainThreadId)) : null,
            React.createElement('span', null, 'seq ', team.lastSeq ?? 0),
            React.createElement('span', null, '派发 ', stats.dispatch_count ?? 0, ' · 确认 ', stats.confirmed_count ?? 0, ' · 过期 ', stats.stale_count ?? 0)
          ),
          tasks.length === 0
            ? React.createElement('div', { className: 'tu-panel-hint' }, '账本已初始化，暂无任务（主脑用 teamup_runtime add-task 建任务）')
            : tasks.map((t) => {
                const meta = ledgerStatusMeta(t.status)
                const actions = []
                const hints = []
                if (t.status === 'DISPATCHED') {
                  actions.push(React.createElement('button', {
                    className: 'tu-btn tu-btn-mini',
                    key: 'submit',
                    disabled: actionBusy !== null,
                    onClick: () => doLedgerAction('submit', t.taskId),
                    title: 'worker 回报已到达、主脑确认后点击：记 submit-return',
                  }, actionBusy === t.taskId ? '记账中…' : '记回报'))
                }
                // 仅 RETURN_SUBMITTED_UNCONFIRMED 可确认（CLI 拒绝从
                // RETURN_CLAIMED_UNOBSERVED confirm——需先 DIRECT_RETURN_OBSERVED
                // 观察证据，见 teamup_runtime.py RETURN_CONFIRMED 分支）
                if (t.status === 'RETURN_SUBMITTED_UNCONFIRMED') {
                  actions.push(React.createElement('button', {
                    className: 'tu-btn tu-btn-mini',
                    key: 'confirm',
                    disabled: actionBusy !== null,
                    onClick: () => doLedgerAction('confirm', t.taskId, t.submissionId),
                    title: '主脑验收回报后点击：记 confirm-return',
                  }, actionBusy === t.taskId ? '记账中…' : '确认'))
                }
                if (t.status === 'RETURN_CLAIMED_UNOBSERVED') {
                  hints.push(React.createElement('span', {
                    key: 'claimed-hint',
                    className: 'tu-ledger-hint',
                    title: 'direct-thread 回报需主脑观察证据（DIRECT_RETURN_OBSERVED）后才能确认',
                  }, '待观察（需观察证据）'))
                }
                return React.createElement('div', { className: 'tu-ledger-task', key: t.taskId, title: t.taskId },
                  React.createElement('div', { className: 'tu-thread-main' },
                    React.createElement('span', { className: 'tu-thread-title tu-mono' }, t.taskId),
                    React.createElement('span', { className: 'tu-ledger-status ' + meta.cls }, meta.label)
                  ),
                  React.createElement('div', { className: 'tu-thread-meta' },
                    React.createElement('span', null, '阶段：', t.kind),
                    t.dependsOn && t.dependsOn.length ? React.createElement('span', null, '依赖 ', t.dependsOn.join(',')) : null,
                    t.dispatch ? React.createElement('span', null, '角色 ', t.dispatch.roleId) : null
                  ),
                  actions.length > 0 || hints.length > 0
                    ? React.createElement('div', { className: 'tu-ledger-actions' }, [...actions, ...hints])
                    : null
                )
              })
        )
      }

      // ---- 锁标签页内容 ----
      let locksContent
      if (locksData.error) {
        locksContent = React.createElement('div', { className: 'tu-panel-error' }, '加载失败：', locksData.error)
      } else if (locksData.loading && locksData.locks.length === 0) {
        locksContent = React.createElement('div', { className: 'tu-panel-hint' }, '加载中…')
      } else if (locksData.locks.length === 0) {
        locksContent = React.createElement('div', { className: 'tu-panel-hint' }, '当前无文件锁（写文件前先 teamup_claim_file）')
      } else {
        locksContent = React.createElement('div', { className: 'tu-thread-list' },
          locksData.locks.map((l) => {
            const holder = l.claimedBy || {}
            const holderName = holder.title || (holder.kind === 'panel' ? '主脑面板' : shortId(holder.sessionId))
            return React.createElement('div', { className: 'tu-lock', key: l.path, title: l.path },
              React.createElement('div', { className: 'tu-thread-main' },
                React.createElement('span', { className: 'tu-lock-path tu-mono' }, l.path),
                React.createElement('button', {
                  className: 'tu-btn tu-btn-mini',
                  disabled: actionBusy !== null,
                  onClick: () => doReleaseLock(l.path),
                  title: '主脑强制释放（面板=主脑操作台）',
                }, actionBusy === l.path ? '释放中…' : '释放')
              ),
              React.createElement('div', { className: 'tu-lock-meta' },
                React.createElement('span', null, '持有者：', holderName),
                l.claimedAt ? React.createElement('span', null, new Date(l.claimedAt).toLocaleString()) : null
              ),
              l.reason ? React.createElement('div', { className: 'tu-lock-meta' },
                React.createElement('span', null, '原因：', l.reason)
              ) : null
            )
          })
        )
      }

      // ---- 审批标签页内容 ----
      let approvalContent
      if (approvalData.error) {
        approvalContent = React.createElement('div', { className: 'tu-panel-error' }, '加载失败：', approvalData.error)
      } else if (approvalData.loading && approvalData.data === null) {
        approvalContent = React.createElement('div', { className: 'tu-panel-hint' }, '加载中…')
      } else {
        const d = approvalData.data || {}
        const pending = d.pending || []
        const decided = d.decided || []
        const sections = []
        sections.push(React.createElement('div', { className: 'tu-group-head', key: 'pending-head' },
          React.createElement('span', { className: 'tu-group-name' }, '待裁决'),
          React.createElement('span', { className: 'tu-group-count' }, pending.length)
        ))
        if (pending.length === 0) {
          sections.push(React.createElement('div', { className: 'tu-panel-hint', key: 'pending-empty' }, '暂无待裁决审批'))
        } else {
          for (const a of pending) {
            const holderName = a.workerTitle || shortId(a.workerSessionId)
            sections.push(React.createElement('div', { className: 'tu-approval', key: a.approvalId, title: a.approvalId },
              React.createElement('div', { className: 'tu-thread-main' },
                React.createElement('span', { className: 'tu-approval-action' }, holderName, ' · ', a.toolName || 'approval'),
                React.createElement('span', { className: 'tu-approval-reason tu-mono' }, shortId(a.approvalId))
              ),
              a.reason ? React.createElement('div', { className: 'tu-approval-reason' }, a.reason) : null,
              React.createElement('div', { className: 'tu-approval-meta' },
                React.createElement('span', null, a.askedAt ? new Date(a.askedAt).toLocaleString() : '')
              ),
              React.createElement('div', { className: 'tu-approval-actions' },
                React.createElement('button', {
                  className: 'tu-btn tu-btn-mini',
                  disabled: actionBusy !== null,
                  onClick: () => doDecideApproval(a.approvalId, true),
                  title: '批准：worker 可继续',
                }, actionBusy === a.approvalId ? '裁决中…' : '批准'),
                React.createElement('button', {
                  className: 'tu-btn tu-btn-mini',
                  disabled: actionBusy !== null,
                  onClick: () => doDecideApproval(a.approvalId, false),
                  title: '拒绝：worker 停止并回报',
                }, actionBusy === a.approvalId ? '裁决中…' : '拒绝')
              )
            ))
          }
        }
        if (decided.length > 0) {
          sections.push(React.createElement('div', { className: 'tu-group-head', key: 'decided-head' },
            React.createElement('span', { className: 'tu-group-name' }, '最近已裁决'),
            React.createElement('span', { className: 'tu-group-count' }, decided.length)
          ))
          for (const a of decided) {
            const outcomeLabel = a.outcome === 'allowed-once' ? '已批准' : (a.outcome === 'rejected' ? '已拒绝' : String(a.outcome))
            sections.push(React.createElement('div', { className: 'tu-approval', key: a.approvalId, title: a.approvalId },
              React.createElement('div', { className: 'tu-thread-main' },
                React.createElement('span', { className: 'tu-approval-action' }, a.workerSessionId ? shortId(a.workerSessionId) : '?', ' · ', a.toolName || 'approval'),
                React.createElement('span', { className: 'tu-approval-reason tu-approval-' + a.outcome }, outcomeLabel)
              ),
              a.reason ? React.createElement('div', { className: 'tu-approval-reason' }, a.reason) : null
            ))
          }
        }
        approvalContent = React.createElement('div', { className: 'tu-thread-list' }, sections)
      }

      return ReactDOM.createPortal(
        React.createElement('div', { className: 'tu-panel', role: 'dialog' },
          React.createElement('div', { className: 'tu-panel-head' },
            React.createElement('div', { className: 'tu-tabs' },
              React.createElement('button', {
                className: 'tu-tab' + (tab === 'threads' ? ' tu-tab-active' : ''),
                onClick: () => setTab('threads'),
              }, '状态'),
              React.createElement('button', {
                className: 'tu-tab' + (tab === 'ledger' ? ' tu-tab-active' : ''),
                onClick: () => setTab('ledger'),
              }, '账本'),
              React.createElement('button', {
                className: 'tu-tab' + (tab === 'locks' ? ' tu-tab-active' : ''),
                onClick: () => setTab('locks'),
              }, '锁'),
              React.createElement('button', {
                className: 'tu-tab' + (tab === 'approvals' ? ' tu-tab-active' : ''),
                onClick: () => setTab('approvals'),
              }, '审批')
            ),
            React.createElement('button', {
              className: 'tu-btn',
              onClick: tab === 'threads' ? loadBoard : (tab === 'ledger' ? loadLedger : (tab === 'locks' ? loadLocks : loadApprovals)),
              disabled: tab === 'threads' ? boardData.loading : (tab === 'ledger' ? ledgerData.loading : (tab === 'locks' ? locksData.loading : approvalData.loading)),
              title: '刷新',
            }, (tab === 'threads' ? boardData.loading : (tab === 'ledger' ? ledgerData.loading : (tab === 'locks' ? locksData.loading : approvalData.loading))) ? '…' : '刷新'),
            React.createElement('button', { className: 'tu-btn tu-btn-close', onClick: onClose, title: '关闭' }, '×')
          ),
          tab === 'threads' ? threadContent : (tab === 'ledger' ? ledgerContent : (tab === 'locks' ? locksContent : approvalContent)),
          React.createElement('div', { className: 'tu-panel-foot' },
            tab === 'threads'
              ? React.createElement('span', null, '共 ', boardData.rows.length, ' 个线程')
              : (tab === 'ledger'
                  ? React.createElement('span', null, '共 ', (ledgerData.data && ledgerData.data.tasks ? ledgerData.data.tasks.length : 0), ' 个任务')
                  : (tab === 'locks'
                      ? React.createElement('span', null, '共 ', locksData.locks.length, ' 把文件锁')
                      : React.createElement('span', null, '待裁决 ', (approvalData.data && approvalData.data.pending ? approvalData.data.pending.length : 0), ' · 已裁决 ', (approvalData.data && approvalData.data.decided ? approvalData.data.decided.length : 0)))),
            (tab === 'threads'
              ? (boardData.fetchedAt ? React.createElement('span', null, '更新于 ', boardData.fetchedAt.toLocaleTimeString()) : null)
              : (tab === 'ledger'
                  ? (ledgerData.fetchedAt ? React.createElement('span', null, '更新于 ', ledgerData.fetchedAt.toLocaleTimeString()) : null)
                  : (tab === 'locks'
                      ? (locksData.fetchedAt ? React.createElement('span', null, '更新于 ', locksData.fetchedAt.toLocaleTimeString()) : null)
                      : (approvalData.fetchedAt ? React.createElement('span', null, '更新于 ', approvalData.fetchedAt.toLocaleTimeString()) : null))))
          )
        ),
        document.body
      )
    }

    function TeamUpAction(props) {
      const [open, setOpen] = useState(false)
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          className: 'tu-action',
          onClick: () => setOpen((v) => !v),
          title: 'TeamUp 线程 / 账本 / 文件锁 / 审批面板',
          'aria-expanded': open,
        }, props && props.wide ? 'TeamUp' : '团队'),
        open ? React.createElement(TeamUpPanel, { onClose: () => setOpen(false) }) : null
      )
    }

    // ---- client 插件入口 ----
    /** 需要 client runtime 提供的服务：slots（挂 sidebar.footer.action 子 slot）。 */
    const inject = ['slots']

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dshteamup',
        order: 100,
        label: () => 'TeamUp',
      }, TeamUpAction)), 'dshteamup: sidebar footer action')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
