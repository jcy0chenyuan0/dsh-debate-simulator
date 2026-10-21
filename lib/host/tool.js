/**
 * 智能体工具：让主控 Agent 也能启动/查询/控制辩论模拟。契约见 §3。
 */
import path from 'node:path'
import { normalizeStart } from './routes.js'
import { formatBytes } from './archive.js'

const ACTIONS = ['start', 'status', 'records', 'pause', 'resume', 'skip', 'stop']

function summaryText(state, extra = '') {
  if (!state || state.phase === 'idle') {
    return ['当前没有进行中的辩论模拟。', '调用 action=start 并提供 topic 即可开始。', extra].filter(Boolean).join('\n')
  }
  const lines = [
    `辩题：${state.topic}`,
    `状态：${state.phaseLabel}（round ${state.round}/${state.rounds}，环节 ${state.stageIndex}/${state.stageCount}）`,
    `计分：正方 ${state.scoreboard?.pro ?? state.pro?.score ?? 0} : 反方 ${state.scoreboard?.con ?? state.con?.score ?? 0}`,
  ]
  if (state.stage?.title) lines.push(`当前环节：${state.stage.title}`)
  if (state.archive?.zips?.length) {
    const last = state.archive.zips[state.archive.zips.length - 1]
    lines.push(`最近归档：${last.name}（${formatBytes(last.bytes)}）`)
  }
  if (state.error) lines.push(`错误：${state.error}`)
  if (extra) lines.push(extra)
  return lines.join('\n')
}

export function registerTool(ctx, options) {
  const { config, getDefaultEngine, openEngine, defaultBaseDir, logger } = options

  const definition = {
    name: 'debate_simulation',
    description:
      '辩论模拟插件：启动/查询/控制一场多智能体辩论模拟。start 需要 topic（辩题），可选 config {rounds,bubbleSeconds,discussionSeconds,judges,timeScale,customFlow}。' +
      '启动后用户可在侧边栏「辩论模拟」模块查看实时 GUI；每轮结束自动打包 ZIP 并清理，最后一轮生成 Word 总结。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'start=启动；status=状态；records=全部记录；pause/resume/skip/stop=控制。',
        },
        topic: { type: 'string', description: '辩题，start 必填，1..200 字。' },
        config: {
          type: 'object',
          description: '可选配置：rounds(1-100)、bubbleSeconds(1-120)、discussionSeconds(30-1800)、judges(1-3)、timeScale(1-60)、customFlow(环节数组)。',
          properties: {
            rounds: { type: 'number' },
            bubbleSeconds: { type: 'number' },
            discussionSeconds: { type: 'number' },
            judges: { type: 'number' },
            timeScale: { type: 'number' },

            provider: { type: 'string', description: '模型服务，如 deepseek-account；省略用默认。' },
            model: { type: 'string', description: '模型 id，如 deepseek-flash / deepseek-chat；省略用默认。' },
            reasoningEffort: { type: 'string', description: '思考强度，如 low / medium / high；省略用默认。' },
            trainingSide: { type: 'string', enum: ['none', 'pro', 'con'], description: '训练方：none/pro/con；达到目标提前结束。' },
            customFlow: { type: 'array', items: { type: 'object' } },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const action = String(args?.action || '')
      if (!ACTIONS.includes(action)) return { text: `不支持的操作：${action || '(空)'}` }

      if (action === 'start') {
        let settings
        try {
          settings = normalizeStart({ topic: args.topic, config: args.config }, config)
        } catch (error) {
          return { text: `启动失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const workingDirectory = ctx.get('workingDirectory')
        const agent = exec?.agent
        let workspace = ''
        try {
          workspace = agent && workingDirectory?.ensure ? await workingDirectory.ensure(agent) : workingDirectory?.defaultDirectory || ''
        } catch {
          workspace = workingDirectory?.defaultDirectory || ''
        }
        const base = config.runsDir
          ? path.resolve(String(config.runsDir))
          : path.join(workspace || process.cwd(), 'debate-runs')
        const engine = await openEngine(base)
        const state = await engine.start(settings)
        return {
          text: [
            `辩论模拟已启动：${settings.topic}`,
            `runId：${state.runId}`,
            `产物目录：${path.join(engine.baseDir, state.runId || '')}`,
            `轮次：${state.rounds}；气泡 ${state.bubbleSeconds}s；模式 ${state.mode}`,
            '提示：打开右下角「⚖️ 辩论模拟」查看实时辩论台与计分板。',
          ].join('\n'),
        }
      }

      const engine = await getDefaultEngine()
      if (action === 'status') return { text: summaryText(engine.getState()) }
      if (action === 'records') {
        const records = engine.getRecords()
        return {
          text: `记录：${records?.rounds?.length ?? 0} 轮；辩题：${records?.topic || '（无）'}\n产物目录：${path.join(engine.baseDir, records?.runId || '')}`,
        }
      }
      const state = await engine.control(action)
      logger?.('tool control', action)
      return { text: summaryText(state, `已执行：${action}`) }
    },
  }

  const debug = { registered: false, error: null, hasTools: Boolean(ctx.tools) }
  toolDebugState = debug
  if (ctx.tools?.register) {
    try {
      const dispose = ctx.tools.register(definition)
      debug.registered = true
      ctx.effect(() => dispose, 'debate-sim: tool debate_simulation')
    } catch (error) {
      debug.error = String(error?.stack || error)
    }
    return
  }
  ctx.inject(['tools'], (toolCtx) => {
    try {
      const dispose = toolCtx.tools.register(definition)
      debug.registered = true
      debug.hasTools = true
      toolCtx.effect(() => dispose, 'debate-sim: tool debate_simulation')
    } catch (error) {
      debug.error = String(error?.stack || error)
    }
  })
}

let toolDebugState = { registered: false, error: 'registerTool not called', hasTools: false }

export function toolStatus() {
  return { ...toolDebugState }
}
