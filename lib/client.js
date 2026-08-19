/**
 * dshteamup — Web 协作面板（client half，最小可用版）。
 *
 * 形态：client bundle 纯度门约束下的手写 bundle（`window.__ModuleLoader__.load`），
 * factory 只 require 平台种子词（react / react-dom，见 dsh-client-web 的
 * PLATFORM_MODULES），不跨插件 value import，不引第三方依赖。
 *
 * 挂载点：官方 list slot `sidebar.footer.action`（不抢注 single slot「sidebar」，
 * 不与任何单占位冲突）。按钮点击后经 createPortal 挂到 document.body 的
 * 浮层面板，数据只读来自 host 侧 /teamup/api（同源 fetch，host 有 trustedHosts 围栏）。
 *
 * 面板内容：live 线程列表（标题/状态/团队名/事件数/短 sessionId），按 teamName
 * 分组，刷新按钮 + 打开期间每 15s 自动刷新（in-flight 去重，无重叠请求）。
 * 数据与 teamup_list_threads 工具同源（host 共用 collectThreads()），保证一致。
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
      '.tu-panel-title{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tu-btn{cursor:pointer;background:var(--dsw-alias-button-elevated-fill,#2b3242);color:inherit;border:1px solid var(--dsw-alias-border-l2,#3a4256);border-radius:6px;padding:2px 8px;font-size:12px;line-height:18px}',
      '.tu-btn:disabled{opacity:.5;cursor:default}',
      '.tu-btn-close{padding:2px 6px}',
      '.tu-thread-list{overflow-y:auto;flex:1;min-height:0;padding:4px 0}',
      '.tu-group-head{display:flex;align-items:center;gap:6px;padding:6px 12px 2px;color:var(--dsw-alias-label-secondary,#9aa3b5);font-size:12px}',
      '.tu-group-name{font-weight:600}',
      '.tu-group-count{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.tu-thread{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}',
      '.tu-thread-main{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tu-thread-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.tu-thread-meta{display:flex;gap:10px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow:hidden}',
      '.tu-thread-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.tu-status-idle{color:var(--dsw-alias-label-tertiary,#8b93a5)}',
      '.tu-status-running{color:#34d399}',
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

    function statusLabel(status) {
      return STATUS_LABELS[status] || String(status || 'unknown')
    }

    function shortId(id) {
      return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id || '?')
    }

    function fetchThreads() {
      return fetch('/teamup/api/threads', {
        headers: { accept: 'application/json' },
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

    // 按 teamName 分组；未分组垫底；组内按 createdAt 倒序（新线程在前）。
    function groupThreads(threads) {
      const map = new Map()
      for (const t of threads || []) {
        const name = t.teamName && String(t.teamName).trim() ? String(t.teamName).trim() : ''
        if (!map.has(name)) map.set(name, [])
        map.get(name).push(t)
      }
      const groups = [...map.entries()].map(([name, list]) => ({
        name,
        threads: list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      }))
      groups.sort((a, b) => {
        if (!a.name && b.name) return 1
        if (a.name && !b.name) return -1
        return String(a.name).localeCompare(String(b.name))
      })
      return groups
    }

    // ---- 面板 ----
    function TeamUpPanel({ onClose }) {
      const [data, setData] = useState({ loading: true, error: null, threads: [], fetchedAt: null })
      // in-flight 去重：上一请求未返回时，15s 自动刷新/手动刷新直接跳过本次，
      // 杜绝重叠请求（慢响应 + 周期 tick 不会并发堆积）。
      const inFlightRef = useRef(false)
      const load = useCallback(() => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        let alive = true
        // loading 只在无数据时置位：已有数据的刷新不再重置 loading 态（防闪烁），
        // 也不清空 error——只在请求真正开始时才清。
        setData((prev) => (prev.threads.length === 0 ? { ...prev, loading: true, error: null } : prev))
        fetchThreads().then(
          (body) => {
            if (!alive) return
            inFlightRef.current = false
            setData({ loading: false, error: null, threads: body.threads || [], fetchedAt: new Date() })
          },
          (error) => {
            if (!alive) return
            inFlightRef.current = false
            setData((prev) => ({
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
      useEffect(() => load(), [load])
      // 面板打开期间每 15s 自动刷新（与手动刷新按钮同一条数据路径）
      useEffect(() => {
        const timer = window.setInterval(load, 15000)
        return () => window.clearInterval(timer)
      }, [load])

      let content
      if (data.error) {
        content = React.createElement('div', { className: 'tu-panel-error' }, '加载失败：', data.error)
      } else if (data.loading && data.threads.length === 0) {
        content = React.createElement('div', { className: 'tu-panel-hint' }, '加载中…')
      } else if (data.threads.length === 0) {
        content = React.createElement('div', { className: 'tu-panel-hint' }, '暂无 live 线程')
      } else {
        const groups = groupThreads(data.threads)
        content = React.createElement('div', { className: 'tu-thread-list' },
          groups.map((g) => React.createElement('div', { className: 'tu-group', key: g.name || '__unnamed__' },
            React.createElement('div', { className: 'tu-group-head' },
              React.createElement('span', { className: 'tu-group-name' }, g.name || '未分组'),
              React.createElement('span', { className: 'tu-group-count' }, g.threads.length)
            ),
            g.threads.map((t) => React.createElement('div', {
              className: 'tu-thread',
              key: t.sessionId,
              title: t.sessionId,
            },
              React.createElement('div', { className: 'tu-thread-main' },
                React.createElement('span', { className: 'tu-thread-title' }, t.title || shortId(t.sessionId)),
                React.createElement('span', {
                  className: 'tu-thread-status tu-status-' + String(t.status || 'unknown').toLowerCase(),
                }, statusLabel(t.status))
              ),
              React.createElement('div', { className: 'tu-thread-meta' },
                React.createElement('span', null, '事件 ', t.eventCount ?? 0),
                t.teamName ? React.createElement('span', null, '团队：', t.teamName) : null,
                React.createElement('span', { className: 'tu-thread-id' }, shortId(t.sessionId))
              )
            ))
          ))
        )
      }

      return ReactDOM.createPortal(
        React.createElement('div', { className: 'tu-panel', role: 'dialog' },
          React.createElement('div', { className: 'tu-panel-head' },
            React.createElement('span', { className: 'tu-panel-title' }, 'TeamUp 线程'),
            React.createElement('button', { className: 'tu-btn', onClick: load, disabled: data.loading, title: '刷新' },
              data.loading ? '…' : '刷新'
            ),
            React.createElement('button', { className: 'tu-btn tu-btn-close', onClick: onClose, title: '关闭' }, '×')
          ),
          content,
          React.createElement('div', { className: 'tu-panel-foot' },
            React.createElement('span', null, '共 ', data.threads.length, ' 个 live 线程'),
            data.fetchedAt ? React.createElement('span', null, '更新于 ', data.fetchedAt.toLocaleTimeString()) : null
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
          title: 'TeamUp 线程面板',
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
