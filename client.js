// dsh-provider-badge：DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。
//
// 作用：在输入框右下角的「模型胶囊」左侧，显示当前供应商的灰色胶囊徽章。
//
// 为什么挂在 conversation.input.right：
//   - 官方 InputBar 的控件行是
//       <div class="standardControls">{input.right}{input.model}</div>
//     两者之间只有 12px 的 flex gap；本插件作为 input.right 的条目
//     （order 1000，当前 slot 里常见条目都更小），天然落在模型胶囊左侧。
//   - 模型胶囊当前可能被第三方插件（如 dsh-reasoning-effort）以 priority:-1 覆盖，
//     官方 conversation.input.model.label 插槽在它里面不会渲染，所以徽章必须在
//     座位之外；这样无论模型胶囊是官方 ModelSelect 还是任何第三方实现，位置都成立。
//
// 数据来源：ctx.modelDirectories.directoryFor(sessionId).store —— 与模型胶囊同一个
// per-session 目录快照。目录尚未就绪时，inject 可能抛
// "cannot get property \"remote.session\" without inject"，因此 inject 返回 resolve()，
// 组件挂载后按 250ms 重试最多 40 次；页面从隐藏恢复可见时会自动重新武装一轮重试。
//
// 本地化：可见文案走客户端 locale 服务（ctx.locale.register + slot 的 locale 席位），
// 供应商/模型名本身来自 Host 的 per-session 目录（已是本地化显示名）。
//
// 样式：胶囊高度默认 32px（与常见模型 trigger 同高），可用
// --dsh-provider-badge-height 覆盖；颜色全部走 --dsw-alias-* 语义 token，
// 深浅主题自动适配；不写死任何颜色。
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: 'dsh-provider-badge',
    factory: (require) => {
      'use strict'
      const module = { exports: {} }
      const exports = module.exports

      const react = require('react')

      const PLUGIN_ID = 'dsh-provider-badge'
      /** 客户端 locale 命名空间（字典见 MESSAGES）。 */
      const LOCALE_NS = 'dsh-provider-badge'
      /** 仅包含插件自己的文案；供应商/模型名由 Host 目录提供。 */
      const MESSAGES = {
        zh: { account: 'DeepSeek 账户' },
        en: { account: 'DeepSeek Account' },
      }
      const SLOT_NAME = 'conversation.input.right'
      const SLOT_ID = 'provider-badge'
      /** 经验值：大于常见条目，当前实现里排在模型胶囊左侧、紧贴胶囊。 */
      const SLOT_ORDER = 1000
      /** 官方供应商：DeepSeek Account（账户登录）与 DeepSeek（API Key 官方路由）。 */
      const OFFICIAL_PROVIDER_IDS = ['deepseek-account', 'deepseek-official']
      const STYLE_ID = 'dsh-provider-badge/styles'
      const RESOLVE_INTERVAL_MS = 250
      const RESOLVE_MAX_TRIES = 40

      // 逐字对齐当前模型 trigger 的形状：32px、999 圆角、11px/17px、500。
      // 高度可用 --dsh-provider-badge-height 覆盖（例如换回官方 28px 胶囊时设 28px）。
      // margin-right:-6px 把行内 12px gap 收成 6px，让徽章和胶囊读作一组。
      const CSS = [
        '.dpb-badge{',
        'display:inline-flex;align-items:center;justify-content:center;align-self:center;',
        'box-sizing:border-box;height:var(--dsh-provider-badge-height,32px);max-width:168px;padding:0 11px;',
        'border:0;border-radius:999px;corner-shape:round;',
        'background:var(--dsw-alias-interactive-bg-hover);',
        'color:var(--dsw-alias-label-secondary);',
        'font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;',
        'flex:0 1 auto;min-width:0;margin-right:-6px;overflow:hidden;',
        'user-select:none;-webkit-user-select:none;',
        '}',
        // 官方供应商仅文字使用用户指定的亮蓝 rgb(79, 140, 255)（固定色，不随主题变化）；
        // 胶囊形状与底色保持和第三方供应商完全一致，不改变背景。
        '.dpb-badge[data-provider-kind="official"]{',
        'color:rgb(79, 140, 255);',
        '}',
        '.dpb-badge__text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      ].join('')

      /** 挂载插件样式表；返回清理函数。 */
      function installStyles() {
        if (typeof document === 'undefined') return () => {}
        if (document.getElementById(STYLE_ID) !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.plugin = PLUGIN_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }

      /** 无 locale 座位时的兜底翻译（默认英文）。 */
      function translateFallback(key) {
        const message = MESSAGES.en[key]
        return typeof message === 'string' ? message : key
      }

      /**
       * 供应商显示名：优先 Host 目录里的本地化显示名，其次 DeepSeek 账户文案，最后回退 id。
       * @param {{id: string, name?: string}} group
       * @param {(key: string) => string} t
       * @returns {string}
       */
      function providerLabel(group, t) {
        // 官方模型选择器对 Account 组统一用 provider.account 文案（随语言切换），这里保持一致。
        if (group.id === 'deepseek-account') return t('account')
        const name = typeof group.name === 'string' ? group.name.trim() : ''
        if (name !== '') return name
        return group.id
      }

      /**
       * 从目录快照解析徽章内容。
       * 选择提交中（pending）优先于已生效选择（current）：模型胶囊在提交期间展示的
       * 就是用户刚选的供应商/模型，徽章跟随它才不会出现"胶囊已换、徽章还是旧的"。
       * 注意：菜单里尚未提交的暂存选择属于模型菜单自己的本地状态，共享目录里没有。
       * @param {object|null} state ModelDirectoryState
       * @param {(key: string) => string} t
       * @returns {{provider: string, model: string, providerId: string, modelId: string}|null}
       */
      function resolveBadge(state, t) {
        if (state === null || typeof state !== 'object') return null
        const current = state.current
        const pending = state.pending
        const selection = pending !== null && typeof pending === 'object' && typeof pending.provider === 'string' && pending.provider !== ''
          ? pending
          : current
        if (selection === null || typeof selection !== 'object') return null
        if (typeof selection.provider !== 'string' || selection.provider === '') return null

        const groups = Array.isArray(state.groups) ? state.groups : []
        let group = null
        for (let index = 0; index < groups.length; index += 1) {
          if (groups[index] !== null && typeof groups[index] === 'object' && groups[index].id === selection.provider) {
            group = groups[index]
            break
          }
        }

        let provider
        if (group !== null) {
          provider = providerLabel(group, t)
        } else if (selection.provider === 'deepseek-account') {
          provider = t('account')
        } else {
          provider = selection.provider
        }

        let model = typeof selection.model === 'string' ? selection.model : ''
        if (group !== null && Array.isArray(group.models)) {
          for (let index = 0; index < group.models.length; index += 1) {
            const candidate = group.models[index]
            if (candidate !== null && typeof candidate === 'object' && candidate.id === selection.model) {
              model = typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : model
              break
            }
          }
        }

        return {
          provider,
          model,
          providerId: selection.provider,
          modelId: selection.model,
          official: OFFICIAL_PROVIDER_IDS.indexOf(selection.provider) !== -1,
        }
      }

      /**
       * 有界轮询 resolve()，直到拿到非空目录 store。
       * 纯函数式实现（定时器可注入），便于单元测试与在 effect 里正确清理。
       * @param {() => object|null|undefined} resolve
       * @param {(store: object) => void} onResolved
       * @param {{intervalMs?: number, maxTries?: number, setTimeoutFn?: Function, clearTimeoutFn?: Function}} [options]
       * @returns {() => void} stop
       */
      function watchDirectory(resolve, onResolved, options) {
        const config = options !== null && typeof options === 'object' ? options : {}
        const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0
          ? config.intervalMs
          : RESOLVE_INTERVAL_MS
        const maxTries = Number.isFinite(config.maxTries) && config.maxTries > 0
          ? Math.floor(config.maxTries)
          : RESOLVE_MAX_TRIES
        const schedule = typeof config.setTimeoutFn === 'function' ? config.setTimeoutFn : setTimeout
        const unschedule = typeof config.clearTimeoutFn === 'function' ? config.clearTimeoutFn : clearTimeout
        let tries = 0
        let timer = null
        let stopped = false

        const tick = () => {
          timer = null
          if (stopped) return
          let next = null
          try {
            next = typeof resolve === 'function' ? resolve() : null
          } catch {
            next = null
          }
          if (next !== null && next !== undefined) {
            stopped = true
            onResolved(next)
            return
          }
          tries += 1
          if (tries < maxTries) timer = schedule(tick, intervalMs)
        }

        tick()
        return () => {
          stopped = true
          if (timer !== null) {
            unschedule(timer)
            timer = null
          }
        }
      }

      /**
       * 徽章组件。store 来自注入的 per-session ModelDirectory；未就绪时按 resolve 重试。
       * @param {{store?: object|null, resolve?: (() => object|null)|null, load?: (() => void)|null, t?: (key: string) => string}} props
       */
      function ProviderBadge(props) {
        const safeProps = props !== null && typeof props === 'object' ? props : {}
        const t = typeof safeProps.t === 'function' ? safeProps.t : translateFallback
        const injectedStore = safeProps.store !== null && typeof safeProps.store === 'object' ? safeProps.store : null
        const [resolvedStore, setResolvedStore] = react.useState(injectedStore)
        // 注入 props 始终优先：这样重试窗口结束后才到达的 store（重渲染时 props 已就绪）也不会被忽略。
        const store = injectedStore !== null ? injectedStore : resolvedStore

        // 解析目录：已注入的 store 直接用；否则挂载后重试，避免冷启动竞态。
        // 页面从隐藏恢复可见时重新武装一轮，避免一次性放弃后永久缺徽章。
        react.useEffect(() => {
          if (store !== null) {
            if (typeof safeProps.load === 'function') safeProps.load()
            return undefined
          }
          let stop = watchDirectory(safeProps.resolve, setResolvedStore)
          let recoveryTarget = null
          const recover = () => {
            if (typeof document !== 'undefined' && document.hidden) return
            stop()
            stop = watchDirectory(safeProps.resolve, setResolvedStore)
          }
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', recover)
            recoveryTarget = document
          }
          return () => {
            stop()
            if (recoveryTarget !== null && typeof recoveryTarget.removeEventListener === 'function') {
              recoveryTarget.removeEventListener('visibilitychange', recover)
            }
          }
        }, [store])

        // 固定 subscribe/getSnapshot 身份，避免每次渲染都退订/重订。
        const subscribe = react.useCallback(
          (onChange) => (store !== null && typeof store.subscribe === 'function' ? store.subscribe(onChange) : () => {}),
          [store],
        )
        const getSnapshot = react.useCallback(
          () => (store !== null && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null),
          [store],
        )
        const state = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

        const info = resolveBadge(state, t)
        if (info === null) return null

        return react.createElement(
          'span',
          {
            className: 'dpb-badge',
            'data-dsh-provider-badge': info.providerId,
            'data-provider-kind': info.official ? 'official' : 'third-party',
            title: info.model === '' ? info.provider : `${info.provider} · ${info.model}`,
          },
          react.createElement('span', { className: 'dpb-badge__text' }, info.provider),
        )
      }

      /**
       * 客户端插件主体。
       * @param {object} ctx cordis 客户端上下文
       */
      function apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-provider-badge: styles')

        const locale = ctx !== null && typeof ctx === 'object' && ctx.locale !== null && typeof ctx.locale === 'object'
          ? ctx.locale
          : null
        if (locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(LOCALE_NS, MESSAGES), 'dsh-provider-badge: dictionaries')
        }

        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          const models = scope.modelDirectories
          const options = {
            name: SLOT_NAME,
            id: SLOT_ID,
            order: SLOT_ORDER,
            inject: (sessionId) => {
              const resolve = () => {
                try {
                  return models.directoryFor(sessionId).store
                } catch {
                  return null
                }
              }
              const load = () => {
                try {
                  const result = models.directoryFor(sessionId).load()
                  if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
                    result.catch(() => { /* 目录错误由模型菜单自己呈现 */ })
                  }
                } catch { /* 目录不可用时静默 */ }
              }
              return { store: resolve(), resolve, load }
            },
          }
          // 字典存在时把 locale 席位放到注册项上，slot 渲染的文案随语言切换实时更新。
          if (locale !== null) options.locale = LOCALE_NS
          scope.slots.inject(SLOT_NAME, () => scope.slots.register(options, ProviderBadge))
        })
      }

      exports.apply = apply
      exports.inject = ['slots', 'modelDirectories', 'locale']
      // 仅供单元测试读取；不属于公开 API。
      exports.__internals = {
        ProviderBadge,
        apply,
        resolveBadge,
        providerLabel,
        watchDirectory,
        installStyles,
        CSS,
        MESSAGES,
        LOCALE_NS,
        SLOT_NAME,
        SLOT_ID,
        SLOT_ORDER,
        RESOLVE_INTERVAL_MS,
        RESOLVE_MAX_TRIES,
      }

      return module.exports
    },
  })
}
