#!/usr/bin/env node
// dsh-provider-badge 单元测试：不依赖 jsdom —— 用 vm 载入浏览器 bundle，
// 注入一个极简 React 桩，验证注册形态、名称解析、渲染与冷启动重试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** 极简 React 桩：组件在本测试里只被当作普通函数调用。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useCallback(fn) { return fn },
  useSyncExternalStore(subscribe, getSnapshot) {
    const unsubscribe = subscribe(() => {})
    const snapshot = getSnapshot()
    if (typeof unsubscribe === 'function') unsubscribe()
    return snapshot
  },
  useEffect() {},
}

/** 极简 document 桩，只覆盖插件用到的接口。 */
function makeDocument() {
  const elements = []
  const head = {
    children: [],
    appendChild(element) { this.children.push(element) },
  }
  return {
    head,
    elements,
    getElementById(id) { return elements.find((element) => element.id === id) || null },
    createElement(tag) {
      const element = {
        tag,
        id: '',
        dataset: {},
        textContent: '',
        remove() {
          const index = elements.indexOf(element)
          if (index >= 0) elements.splice(index, 1)
          const headIndex = head.children.indexOf(element)
          if (headIndex >= 0) head.children.splice(headIndex, 1)
        },
      }
      elements.push(element)
      return element
    },
  }
}

/** 可控的 setTimeout/clearTimeout 桩，用于测试有界重试。 */
function makeScheduler() {
  let nextId = 1
  const pending = new Map()
  const queue = []
  const api = {
    setTimeout(callback, delay) {
      const id = nextId
      nextId += 1
      pending.set(id, callback)
      queue.push({ id, delay })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    advance() {
      const next = queue.shift()
      if (next === undefined) throw new Error('scheduler: no pending timer')
      const callback = pending.get(next.id)
      if (callback !== undefined) {
        pending.delete(next.id)
        callback()
      }
      return next.delay
    },
    get pendingCount() { return pending.size },
  }
  return api
}

/** 载入 bundle，返回被 __ModuleLoader__ 捕获的注册对象、模块导出与 vm 上下文。 */
function loadBundle() {
  let registration = null
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) { registration = value },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  assert.ok(registration !== null, 'bundle 应当通过 window.__ModuleLoader__ 注册')
  const moduleExports = registration.factory((id) => {
    assert.equal(id, 'react', 'bundle 只应 require("react")')
    return fakeReact
  })
  return { registration, moduleExports, context }
}

function makeStore(state) {
  return {
    subscribe() { return () => {} },
    getSnapshot() { return state },
  }
}

const ZH_T = (key) => ({ account: 'DeepSeek 账户' }[key] ?? key)
const EN_T = (key) => ({ account: 'DeepSeek Account' }[key] ?? key)

const STATE = {
  current: { provider: 'provider-a', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  groups: [
    {
      id: 'provider-a',
      name: 'Provider-A',
      models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }],
    },
    { id: 'provider-b', name: 'Provider-B', models: [{ id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash' }] },
  ],
  status: 'ready',
  failures: [],
  pending: null,
  error: null,
  routable: true,
}

test('bundle 以 dsh-provider-badge 为 id 注册，且声明所需服务', () => {
  const { registration, moduleExports } = loadBundle()
  assert.equal(registration.id, 'dsh-provider-badge')
  assert.deepEqual([...moduleExports.inject], ['slots', 'modelDirectories', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
})

test('apply 注册样式、localed 字典与 slot，并注入 per-session store', () => {
  const { moduleExports } = loadBundle()
  const dictionaryRegistrations = []
  const registered = []
  const scope = {
    modelDirectories: {
      directoryFor(sessionId) {
        assert.equal(sessionId, 'session-1')
        return { store: makeStore(STATE), load: () => Promise.resolve() }
      },
    },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'conversation.input.right')
        factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject(deps, fn) {
      assert.deepEqual([...deps], ['slots', 'modelDirectories'])
      fn(scope)
    },
    locale: {
      register(ns, dicts) {
        dictionaryRegistrations.push({ ns, dicts })
        return () => {}
      },
    },
  }
  moduleExports.apply(ctx)

  assert.equal(dictionaryRegistrations.length, 1)
  assert.equal(dictionaryRegistrations[0].ns, 'dsh-provider-badge')
  assert.deepEqual(Object.keys(dictionaryRegistrations[0].dicts).sort(), ['en', 'zh'])
  assert.equal(typeof dictionaryRegistrations[0].dicts.zh.account, 'string')

  assert.equal(registered.length, 1)
  const [entry] = registered
  assert.equal(entry.options.name, 'conversation.input.right')
  assert.equal(entry.options.id, 'provider-badge')
  assert.equal(entry.options.order, 1000)
  assert.equal(entry.options.locale, 'dsh-provider-badge')
  const injected = entry.options.inject('session-1')
  assert.equal(typeof injected.store.getSnapshot, 'function')
  assert.equal(typeof injected.load, 'function')
  assert.equal(typeof injected.resolve, 'function')
})

test('apply 在 locale 服务缺失时仍注册 slot，但不下发 locale 席位', () => {
  const { moduleExports } = loadBundle()
  const registered = []
  const scope = {
    modelDirectories: { directoryFor: () => ({ store: makeStore(STATE), load: () => Promise.resolve() }) },
    slots: {
      inject(name, factory) { factory() },
      register(options) { registered.push(options); return () => {} },
    },
  }
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject(deps, fn) { fn(scope) },
  }
  moduleExports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].locale, undefined)
})

test('directoryFor 抛错时静默降级为不渲染', () => {
  const { moduleExports } = loadBundle()
  let component = null
  const scope = {
    modelDirectories: { directoryFor() { throw new Error('no scope') } },
    slots: {
      inject(name, factory) { factory() },
      register(options, value) { component = { options, value } },
    },
  }
  moduleExports.apply({
    effect(fn) { return fn() },
    inject(deps, fn) { fn(scope) },
    locale: { register: () => () => {} },
  })
  const injected = component.options.inject('session-x')
  assert.equal(injected.store, null)
  assert.equal(typeof injected.load, 'function')
  assert.equal(typeof injected.resolve, 'function')
  assert.equal(injected.resolve(), null)
  assert.doesNotThrow(() => injected.load())
})

test('resolveBadge：优先供应商显示名，其次回退 id，再其次模型名', () => {
  const { moduleExports } = loadBundle()
  const { resolveBadge } = moduleExports.__internals

  const hit = resolveBadge(STATE, ZH_T)
  assert.deepEqual(JSON.parse(JSON.stringify(hit)), {
    provider: 'Provider-A',
    model: 'DeepSeek-V4.1-Flash',
    providerId: 'provider-a',
    modelId: 'deepseek-v4.1-flash',
    official: false,
  })

  const miss = resolveBadge({ current: { provider: 'unknown-route', model: 'x' }, groups: [] }, ZH_T)
  assert.equal(miss.provider, 'unknown-route')
  assert.equal(miss.model, 'x')

  assert.equal(resolveBadge({ current: null, groups: [] }, ZH_T), null)
  assert.equal(resolveBadge(null, ZH_T), null)
  assert.equal(resolveBadge({ current: {}, groups: [] }, ZH_T), null)
})

test('DeepSeek 账户走 locale 字典，名称缺失时回退 id', () => {
  const { moduleExports } = loadBundle()
  const { providerLabel, resolveBadge } = moduleExports.__internals

  assert.equal(providerLabel({ id: 'deepseek-account', name: 'DeepSeek Account' }, ZH_T), 'DeepSeek 账户')
  assert.equal(providerLabel({ id: 'deepseek-account', name: '  ' }, ZH_T), 'DeepSeek 账户')
  assert.equal(providerLabel({ id: 'deepseek-account', name: '  ' }, EN_T), 'DeepSeek Account')
  assert.equal(providerLabel({ id: 'x', name: '  ' }, ZH_T), 'x')

  const account = resolveBadge({ current: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' }, groups: [] }, ZH_T)
  assert.equal(account.provider, 'DeepSeek 账户')
  assert.equal(account.official, true)

  const official = resolveBadge(
    {
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] }],
    },
    ZH_T,
  )
  assert.equal(official.provider, 'DeepSeek')
  assert.equal(official.official, true)

  const thirdParty = resolveBadge(STATE, ZH_T)
  assert.equal(thirdParty.official, false)

  // 提交中的 pending 选择优先于已生效的 current（菜单关闭提交后立即对齐胶囊）。
  const pendingState = {
    ...STATE,
    pending: { provider: 'provider-b', model: 'mimo-v2.6-flash' },
  }
  const pendingHit = resolveBadge(pendingState, ZH_T)
  assert.equal(pendingHit.provider, 'Provider-B')
  assert.equal(pendingHit.model, 'MiMo-V2.6-Flash')
  assert.equal(pendingHit.providerId, 'provider-b')

  // pending 形态异常（空 provider）时回退到 current。
  const badPending = resolveBadge({ ...STATE, pending: { provider: '', model: 'x' } }, ZH_T)
  assert.equal(badPending.provider, 'Provider-A')
  assert.equal(resolveBadge({ ...STATE, pending: null }, ZH_T).provider, 'Provider-A')
})

test('渲染：输出灰色胶囊文本与 tooltip；无选择时不渲染', () => {
  const { moduleExports } = loadBundle()
  const { ProviderBadge } = moduleExports.__internals

  const element = ProviderBadge({ store: makeStore(STATE), load: null, t: ZH_T })
  assert.equal(element.type, 'span')
  assert.equal(element.props.className, 'dpb-badge')
  assert.equal(element.props['data-dsh-provider-badge'], 'provider-a')
  assert.equal(element.props['data-provider-kind'], 'third-party')
  assert.equal(element.props.title, 'Provider-A · DeepSeek-V4.1-Flash')
  assert.equal(element.props.title.includes('undefined'), false)
  const text = element.children[0]
  assert.equal(text.props.className, 'dpb-badge__text')
  assert.equal(text.children[0], 'Provider-A')

  const officialElement = ProviderBadge({
    store: makeStore({
      current: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' },
      groups: [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] }],
    }),
    load: null,
    t: ZH_T,
  })
  assert.equal(officialElement.props['data-provider-kind'], 'official')
  assert.equal(officialElement.children[0].children[0], 'DeepSeek 账户')

  assert.equal(ProviderBadge({ store: makeStore({ current: null, groups: [] }), load: null }), null)
  assert.equal(ProviderBadge({ store: null, load: null }), null)
})

test('样式：语义 token 为主，官方文字为指定亮蓝，胶囊可覆盖高度', () => {
  const { moduleExports } = loadBundle()
  const css = moduleExports.__internals.CSS
  assert.match(css, /height:var\(--dsh-provider-badge-height,32px\)/)
  assert.match(css, /border-radius:999px/)
  assert.match(css, /corner-shape:round/)
  assert.match(css, /--dsw-alias-interactive-bg-hover/)
  assert.match(css, /--dsw-alias-label-secondary/)
  assert.match(css, /\.dpb-badge\[data-provider-kind="official"\]/)
  assert.match(css, /color:rgb\(79, 140, 255\)/)
  assert.doesNotMatch(css, /--dsw-alias-state-business-primary/)
  assert.doesNotMatch(css, /--dsw-alias-state-business-tertiary/)
  assert.doesNotMatch(css, /data-provider-kind="official"\][^}]*background/)
  // 唯一允许的字面色就是用户指定的官方文字色；其余必须走语义 token。
  assert.deepEqual(css.match(/rgba?\([^)]*\)/g) ?? [], ['rgb(79, 140, 255)'])
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
})

test('生产 bundle 不再包含调试上报通道、DOM 监听或额外依赖', () => {
  assert.doesNotMatch(source, /59999|fetch\(|keepalive|MutationObserver/)
  assert.doesNotMatch(source, /documentElement\.lang/)
  assert.doesNotMatch(source, /require\(['"](?!react['"])/)
})

test('installStyles 可重复调用且清理时移除样式表', () => {
  const { moduleExports, context } = loadBundle()
  const document = makeDocument()
  context.document = document
  const cleanup = moduleExports.__internals.installStyles()
  assert.equal(document.elements.length, 1)
  assert.equal(document.elements[0].id, 'dsh-provider-badge/styles')
  assert.equal(document.elements[0].dataset.plugin, 'dsh-provider-badge')
  assert.equal(document.head.children.length, 1)
  // 第二次调用复用同一张样式表，不重复插入。
  const cleanupAgain = moduleExports.__internals.installStyles()
  assert.equal(document.elements.length, 1)
  cleanup()
  assert.equal(document.elements.length, 0)
  cleanupAgain()
})

test('watchDirectory：冷启动重试后拿到 store', () => {
  const { moduleExports } = loadBundle()
  const { watchDirectory } = moduleExports.__internals
  const scheduler = makeScheduler()
  const responses = [null, null, null, { getSnapshot: () => null }]
  let calls = 0
  let resolved = null
  const stop = watchDirectory(
    () => { const value = responses[calls]; calls += 1; return value },
    (store) => { resolved = store },
    {
      setTimeoutFn: (fn, ms) => scheduler.setTimeout(fn, ms),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id),
      intervalMs: 250,
      maxTries: 10,
    },
  )
  assert.equal(calls, 1, '首次同步解析一次')
  assert.equal(resolved, null)
  scheduler.advance()
  scheduler.advance()
  assert.equal(resolved, null)
  scheduler.advance()
  assert.equal(calls, 4)
  assert.equal(resolved, responses[3])
  assert.equal(scheduler.pendingCount, 0)
  stop()
})

test('watchDirectory：达到 maxTries 后放弃且无残留定时器', () => {
  const { moduleExports } = loadBundle()
  const { watchDirectory } = moduleExports.__internals
  const scheduler = makeScheduler()
  let calls = 0
  let resolved = 0
  const stop = watchDirectory(
    () => { calls += 1; return null },
    () => { resolved += 1 },
    {
      setTimeoutFn: (fn, ms) => scheduler.setTimeout(fn, ms),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id),
      intervalMs: 250,
      maxTries: 3,
    },
  )
  scheduler.advance()
  scheduler.advance()
  assert.equal(resolved, 0)
  assert.equal(scheduler.pendingCount, 0)
  assert.equal(calls, 3)
  stop()
})

test('watchDirectory：stop 取消后续重试，resolve 抛错按未就绪处理', () => {
  const { moduleExports } = loadBundle()
  const { watchDirectory } = moduleExports.__internals
  const scheduler = makeScheduler()
  const responses = [() => { throw new Error('cold start') }, 'store']
  let calls = 0
  let resolved = null
  const stop = watchDirectory(
    () => {
      const next = responses[calls]
      calls += 1
      if (typeof next === 'function') next()
      return next === 'store' ? { value: true } : null
    },
    (store) => { resolved = store },
    {
      setTimeoutFn: (fn, ms) => scheduler.setTimeout(fn, ms),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id),
      intervalMs: 250,
      maxTries: 5,
    },
  )
  assert.equal(calls, 1)
  scheduler.advance()
  assert.deepEqual(resolved, { value: true })
  assert.equal(scheduler.pendingCount, 0)
  stop()
  assert.equal(calls, 2)

  // stop 之后不再调用 resolve。
  const scheduler2 = makeScheduler()
  let afterStopCalls = 0
  const stop2 = watchDirectory(
    () => { afterStopCalls += 1; return null },
    () => {},
    {
      setTimeoutFn: (fn, ms) => scheduler2.setTimeout(fn, ms),
      clearTimeoutFn: (id) => scheduler2.clearTimeout(id),
      intervalMs: 250,
      maxTries: 5,
    },
  )
  assert.equal(afterStopCalls, 1)
  stop2()
  assert.equal(scheduler2.pendingCount, 0)
  assert.equal(afterStopCalls, 1)
})
