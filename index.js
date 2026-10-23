/**
 * DSH 辩论模拟插件 · Host 入口。
 * 契约：docs/CONTRACT.md。
 */
import path from 'node:path'
import { createEngine } from './lib/host/engine.js'
import { createRoster, createSimulator } from './lib/host/simulate.js'
import { registerRoutes } from './lib/host/routes.js'
import { registerTool, toolStatus } from './lib/host/tool.js'

export const name = 'dsh-debate-simulator'

/** 硬依赖：工具注册与 GUI HTTP 路由。 */
export const inject = ['tools', 'webServer']

export const DEFAULT_CONFIG = {
  runsDir: '',
  rounds: 3,
  bubbleSeconds: 10,
  discussionSeconds: 180,
  judges: 1,
  timeScale: 2,
  mode: 'ai',
  llmTimeoutMs: 90000,
  maxRounds: 100,
}

export { createRoster, createSimulator }

/** 插件激活入口。 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const logger = (...args) => {
    try {
      ctx.logger?.info?.('[debate-sim]', ...args)
    } catch {
      /* logging must never break the plugin */
    }
  }

  /** @type {Map<string, {engine: any, ready: Promise<any>}>} */
  const engines = new Map()

  const defaultBaseDir = () => {
    if (config.runsDir && String(config.runsDir).trim()) return path.resolve(String(config.runsDir).trim())
    const wd = ctx.get('workingDirectory')
    // 优先使用真实根会话的工作目录；`defaultDirectory` 在桌面版是 profile 目录，不能直接当工作区。
    try {
      const roots = ctx.get('agents')?.roots?.() ?? []
      for (const agent of roots) {
        const id = agent?.session?.id ?? agent?.id
        const dir = id ? wd?.get?.(agent.session ?? { id }) : undefined
        if (dir && String(dir).trim()) return path.join(String(dir), 'debate-runs')
      }
    } catch {
      /* fall through */
    }
    // 刚重启、还没有 root agent 时，用工作区注册表定位项目目录；
    // 桌面版的 workingDirectory.defaultDirectory 是 profile 目录，不能当工作区。
    try {
      const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
      const ws = workspaces.find((item) => item && typeof item.path === 'string' && item.path.trim())
      if (ws) return path.join(ws.path, 'debate-runs')
    } catch {
      /* fall through */
    }
    const dir = wd?.defaultDirectory
    return path.join(dir && dir.trim() ? dir : process.cwd(), 'debate-runs')
  }

  const currentModel = () => {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (!selection || !selection.provider || !selection.model) return null
      return {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }
    } catch {
      return null
    }
  }

  const openEngine = (baseDir) => {
    const key = path.resolve(baseDir)
    const existing = engines.get(key)
    if (existing) return existing.ready
    const engine = createEngine({
      baseDir: key,
      config,
      createRoster,
      createSimulator: (opts = {}) =>
        createSimulator({
          ...opts,
          llm: opts.llm ?? ctx.get('llm') ?? null,
          model: opts.model ?? currentModel(),
          llmTimeoutMs: opts.llmTimeoutMs ?? config.llmTimeoutMs,
          logger,
        }),
      logger,
    })
    const ready = Promise.resolve()
      .then(() => engine.init())
      .then(() => engine)
      .catch((error) => {
        engines.delete(key)
        logger('engine init failed', error)
        throw error
      })
    engines.set(key, { engine, ready })
    return ready
  }

  // 默认引擎：启动时即创建，供 GUI 打开时立刻可读；无 run 时只返回 idle。
  const defaultReady = Promise.resolve().then(() => openEngine(defaultBaseDir())).catch((error) => {
    logger('default engine unavailable', error)
    return null
  })

  const getDefaultEngine = async () => {
    const engine = await defaultReady
    if (!engine) throw new Error('辩论模拟引擎不可用（请检查插件日志）')
    return engine
  }

  // 清理：插件卸载时停止所有引擎循环并释放定时器。
  ctx.effect(() => () => {
    for (const entry of engines.values()) {
      try {
        entry.engine.dispose?.()
      } catch {
        /* best effort */
      }
    }
    engines.clear()
  }, 'debate-sim: engines')

  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, {
      version: '1.0.0',
      config,
      getDefaultEngine,
      openEngine,
      defaultBaseDir,
      logger,
      getToolStatus: toolStatus,
    })
  })

  ctx.inject(['tools'], (toolCtx) => {
    registerTool(toolCtx, {
      config,
      getDefaultEngine,
      openEngine,
      defaultBaseDir,
      logger,
    })
  })
}
