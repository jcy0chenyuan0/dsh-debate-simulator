/**
 * 辩论模拟 Host 引擎：状态机、严格串行调度、磁盘产物与轮次归档。
 * 契约见 docs/CONTRACT.md §2.4 / §2.5 / §2.6 / §5 / §6。
 *
 * 设计要点：
 * - 单条 async 循环 runLoop；每条发言 await wait(bubbleSeconds*1000) 后才推进。
 * - 讨论阶段用墙钟倒计时（discussionSeconds / timeScale），辩论阶段用 planTurns 的
 *   share 推进环节计时（逻辑计时，不与气泡时长耦合）。
 * - state.json 防抖 250ms 落盘，阶段边界强制 flush。
 * - 每轮 createZip + 删除「第NN轮/」+ 写 rounds-index.json + agents.alive=0。
 */
import path from 'node:path'
import { promises as fsp, readFileSync } from 'node:fs'
import {
  defaultFlow,
  minimalFlow,
  validateFlow,
  planTurns,
  DEFAULT_BUBBLE_SECONDS,
  DEFAULT_DISCUSSION_SECONDS,
  DEFAULT_ROUNDS,
  MAX_ROUNDS,
} from './flow.js'
import {
  ensureDir,
  createZip,
  writeJsonFile,
  removeDir,
  listFilesRecursive,
  slugify,
  runIdFor,
  safeJoin,
  formatBytes,
  buildDocx,
  writeDocxFile,
} from './archive.js'
import * as docs from './docwriter.js'
import { createStore } from './store.js'

const VERSION = 1
const ADAPTER_LABEL = {
  idle: '空闲',
  discussion: '讨论阶段',
  debate: '辩论阶段',
  summary: '教练总结',
  archive: '归档打包',
  final: '生成总结文档',
  done: '已完成',
  paused: '已暂停',
  error: '出错',
}

const DEFAULT_CONFIG = {
  runsDir: '',
  rounds: DEFAULT_ROUNDS,
  bubbleSeconds: DEFAULT_BUBBLE_SECONDS,
  discussionSeconds: DEFAULT_DISCUSSION_SECONDS,
  judges: 1,
  timeScale: 2,
  mode: 'ai',
  llmTimeoutMs: 90000,
  maxRounds: MAX_ROUNDS,
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 1000) / 1000))
}

function clampScore(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function truncate(value, max = 60) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function emptyRecords(runId = null, topic = '', mode = 'demo') {
  return {
    ok: true,
    runId,
    topic,
    mode,
    rounds: [],
    final: { summaryMd: null, docxRel: null },
    issueLog: [],
  }
}

function emptyState(defaults) {
  return {
    ok: true,
    version: VERSION,
    runId: null,
    topic: '',
    created: 0,
    updated: 0,
    active: false,
    recovered: false,
    paused: false,
    phase: 'idle',
    phaseDetail: 'idle',
    phaseLabel: ADAPTER_LABEL.idle,
    mode: defaults.mode,
    rounds: defaults.rounds,
    round: 0,
    stageIndex: 0,
    stageCount: 0,
    stage: null,
    clock: { total: 0, remaining: 0, pro: 0, con: 0 },
    bubbleSeconds: defaults.bubbleSeconds,
    current: null,
    discussion: { active: false, side: null, turns: [] },
    huddles: { pro: [], con: [] },
    thoughts: [],
    pro: { score: 0, debaters: [] },
    con: { score: 0, debaters: [] },
    judges: [],
    scoreboard: { pro: 0, con: 0, history: [] },
    recent: [],
    archive: { zips: [], finalDocx: null, summaryMd: null },
    agents: { count: 0, alive: 0, note: '未启动' },
    error: null,
    lastEvent: '等待启动',
    materials: '',
    adminComment: '',
    config: {
      rounds: defaults.rounds,
      bubbleSeconds: defaults.bubbleSeconds,
      discussionSeconds: defaults.discussionSeconds,
      judges: defaults.judges,
      timeScale: defaults.timeScale,
      mode: defaults.mode,
      customFlow: false,
    },
  }
}

function stageView(stage) {
  return {
    id: stage.id,
    title: stage.title,
    kind: stage.kind,
    seconds: stage.seconds,
    description: stage.description || '',
    side: stage.side,
    rule: stage.rule || '',
    perSide: stage.perSide === true,
    singleSide: stage.singleSide === true || (stage.side !== 'both' && stage.perSide !== true),
  }
}

function speechSummary(speech) {
  return {
    id: speech.id,
    seq: speech.seq,
    round: speech.round,
    stageIndex: speech.stageIndex,
    stageTitle: speech.stageTitle,
    side: speech.side,
    speakerId: speech.speakerId,
    speakerName: speech.speakerName,
    seat: speech.seat,
    text: truncate(speech.text, 240),
    kind: speech.kind,
    startedAt: speech.startedAt,
    endsAt: speech.endsAt,
    at: speech.startedAt,
  }
}

function fallbackRoster(judgesCount = 1) {
  const seats = [1, 2, 3, 4]
  const make = (side, seat, role) => ({
    id: `${side}-${seat}`,
    name: `${side === 'pro' ? '正方' : '反方'}${['一', '二', '三', '四'][seat - 1]}辩`,
    side,
    seat,
    role,
    avatar: '',
    color: side === 'pro' ? '#2f6fed' : '#d14343',
  })
  const count = clampInt(judgesCount, 1, 3, 1)
  return {
    admin: { id: 'admin', name: '管理员', side: 'neutral', seat: null, role: 'admin', avatar: '', color: '#8a6d3b' },
    pro: seats.map((seat) => make('pro', seat, 'debater')),
    con: seats.map((seat) => make('con', seat, 'debater')),
    judges: Array.from({ length: count }, (_, index) => ({
      id: `judge-${index + 1}`,
      name: `评委${index + 1}`,
      side: 'neutral',
      seat: null,
      role: 'judge',
      avatar: '',
      color: '#6b7280',
    })),
    coaches: {
      pro: { id: 'coach-pro', name: '正方教练', side: 'pro', seat: null, role: 'coach', avatar: '', color: '#2f6fed' },
      con: { id: 'coach-con', name: '反方教练', side: 'con', seat: null, role: 'coach', avatar: '', color: '#d14343' },
    },
  }
}

function demoDiscussionTurns(side, agents, topic) {
  const list = Array.isArray(agents) && agents.length ? agents : []
  return list.slice(0, 3).map((agent, index) => ({
    speakerId: agent.id,
    speakerName: agent.name,
    text: `【${agent.name}】围绕「${topic}」的第 ${index + 1} 轮发言（演示模式）：明确立场、给出两条论据，并预判对方反驳方向。`,
  }))
}

function demoSpeechText(agent, stage) {
  const name = agent?.name || '辩手'
  return `【${name}·${stage.title}】${stage.rule || '按环节要求展开论述。'}（演示模式：未接入模型时由引擎生成的占位发言。）`
}

function demoCoachText(side, topic, round) {
  return `第 ${round} 轮${docs.sideLabel(side)}教练总结（演示模式）：本场围绕「${topic}」展开，我方需在比较标准上给出更清晰的判准，并在下一轮补齐数据支撑。`
}

/* ================================ Engine =============================== */

class Engine {
  constructor(options = {}) {
    this.baseDir = path.resolve(String(options.baseDir || path.join(process.cwd(), 'debate-runs')))
    this.defaults = { ...DEFAULT_CONFIG, ...(options.config && typeof options.config === 'object' ? options.config : {}) }
    this.createSimulatorFn = typeof options.createSimulator === 'function' ? options.createSimulator : null
    this.createRosterFn = typeof options.createRoster === 'function' ? options.createRoster : null
    this.model = options.model ?? null
    this.llm = options.llm ?? null
    this.customApi = null
    this.nowImpl = typeof options.now === 'function' ? options.now : () => Date.now()
    this.now = this.nowImpl
    this.injectedWait = typeof options.wait === 'function' ? options.wait : null
    this.logger = typeof options.logger === 'function' ? options.logger : () => {}

    this.store = createStore({ baseDir: this.baseDir, logger: this.logger })
    this.listeners = new Set()
    this.runs = []

    this.state = emptyState(this.defaults)
    this.records = emptyRecords()
    this.flow = defaultFlow()
    this.roster = null
    this.sim = null
    this.mode = this.defaults.mode
    this.drafts = { pro: '', con: '' }
    this.discussionSummaries = { pro: '', con: '' }

    this.cursor = { round: 1, stageIndex: 0, discussionDone: false, debateDone: false, summaryDone: false }
    this.running = false
    this.stopped = false
    this.paused = false
    this._loopPromise = null
    this._loopGen = null
    this._skipFlag = false
    this._timers = new Set()
    this._waiters = new Set()
    this._pauseResolve = null
    this.abort = null
    this.seq = 0
    this.gen = 0
    this.initialized = false
  }

  /* ------------------------------ 生命周期 ----------------------------- */

  runDir() {
    return path.join(this.baseDir, String(this.state.runId || ''))
  }

  /** 当前时间（可注入，测试用固定时钟）。 */
  now() {
    const value = Number(this.nowImpl())
    return Number.isFinite(value) ? value : Date.now()
  }

  async init() {
    await ensureDir(this.baseDir)
    const runs = await this.store.listRuns(20)
    this.runs = runs
    this.initialized = true
    const target = runs.find((meta) => meta.phase !== 'done' && meta.phase !== 'idle' && meta.runId)
    if (target) {
      try {
        const loaded = await this.store.loadRun(target.runId)
        if (loaded && loaded.state) {
          this._restore(loaded)
          this.logger('[debate] 已恢复未完成运行:', target.runId, '→ paused')
        }
      } catch (err) {
        this.logger('[debate] 恢复运行失败:', err?.message || err)
      }
    }
    return this.getState()
  }

  _restore(loaded) {
    const { run, state } = loaded
    const { records, cursor, flow, seq, savedAt, ...pub } = state || {}
    const base = emptyState(this.defaults)
    this.state = { ...base, ...pub }
    this.state.current = null
    this.state.paused = true
    this.state.recovered = true
    this.state.active = true
    this.state.phase = 'paused'
    this.state.phaseDetail = state?.phaseDetail && state.phaseDetail !== 'paused' && state.phaseDetail !== 'idle'
      ? state.phaseDetail
      : (state?.phase && state.phase !== 'paused' && state.phase !== 'idle' ? state.phase : 'debate')
    this.state.phaseLabel = ADAPTER_LABEL.paused
    this.state.lastEvent = '检测到未完成的运行，已恢复为暂停状态'
    this.records = records && Array.isArray(records.rounds) ? { ...emptyRecords(this.state.runId, this.state.topic, this.state.mode), ...records } : emptyRecords(this.state.runId, this.state.topic, this.state.mode)
    this.records.ok = true
    this.flow = Array.isArray(flow) && flow.length ? flow : (Array.isArray(run?.flow) && run.flow.length ? run.flow : defaultFlow())
    this.cursor = cursor && typeof cursor === 'object'
      ? {
        round: clampInt(cursor.round, 1, MAX_ROUNDS, 1),
        stageIndex: clampInt(cursor.stageIndex, 0, this.flow.length, 0),
        discussionDone: cursor.discussionDone === true,
        debateDone: cursor.debateDone === true,
        summaryDone: cursor.summaryDone === true,
      }
      : { round: this.state.round || 1, stageIndex: this.state.stageIndex || 0, discussionDone: false, debateDone: false, summaryDone: false }
    this.seq = clampInt(seq, 0, Number.MAX_SAFE_INTEGER, 0)
    this.mode = this.state.mode || this.defaults.mode
    this.paused = true
    this.stopped = true
    this.running = false
    this.roster = null
    this.sim = null
  }

  async dispose() {
    await this.stop({ silent: true })
    await this.store.flush()
    this.listeners.clear()
  }

  /* ------------------------------- 读取面 ------------------------------- */

  getState() {
    const pub = clone(this.state)
    const real = this.state.phaseDetail || this.state.phase
    pub.ok = true
    pub.version = VERSION
    pub.paused = this.paused
    pub.active = !!this.state.runId && this.state.active === true
    pub.phase = this.paused ? 'paused' : this.state.phase
    pub.phaseLabel = this.paused ? ADAPTER_LABEL.paused : (ADAPTER_LABEL[this.state.phase] || String(this.state.phase))
    pub.phaseDetail = real
    if (!Array.isArray(pub.recent)) pub.recent = []
    if (!pub.discussion) pub.discussion = { active: false, side: null, turns: [] }
    pub.drafts = { pro: this.drafts.pro || '', con: this.drafts.con || '' }
    return pub
  }

  listRuns() {
    this._refreshRuns()
    return clone(this.runs)
  }

  getRecords(runId) {
    if (!runId || runId === this.state.runId) return clone(this.records)
    const dir = safeJoin(this.baseDir, String(runId))
    if (!dir) return emptyRecords()
    try {
      const raw = readFileSync(path.join(dir, 'state.json'), 'utf8')
      const doc = JSON.parse(raw)
      if (doc && doc.records) return { ...clone(doc.records), ok: true, runId: doc.runId || runId }
    } catch {
      /* 忽略：文件不存在或损坏 */
    }
    return emptyRecords(runId, '', 'demo')
  }

  onChange(fn) {
    if (typeof fn !== 'function') return () => {}
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    const snapshot = this.getState()
    for (const fn of [...this.listeners]) {
      try {
        fn(snapshot)
      } catch (err) {
        this.logger('[debate] onChange 回调异常:', err?.message || err)
      }
    }
  }

  _refreshRuns() {
    this.store.listRuns(20).then((runs) => {
      this.runs = runs
    }).catch((err) => this.logger('[debate] 刷新运行列表失败:', err?.message || err))
  }

  /* ------------------------------- 启动面 ------------------------------- */

  _normalizeConfig(input) {
    const src = { ...this.defaults, ...(input && typeof input === 'object' ? input : {}) }
    const maxRounds = clampInt(src.maxRounds, 1, MAX_ROUNDS, MAX_ROUNDS)
    let flow = defaultFlow()
    let customFlow = false
    if (input && input.customFlow !== undefined && input.customFlow !== null) {
      const result = validateFlow(input.customFlow)
      if (!result.ok) throw new Error(`自定义赛制有误：${result.errors.slice(0, 3).join('；')}`)
      flow = result.flow
      customFlow = true
    }
    if (src.simpleMode === true) {
      flow = src.loadFlow === false ? minimalFlow() : defaultFlow()
      customFlow = false
    }
    const trainingSide = src.trainingSide === 'pro' || src.trainingSide === 'con' ? src.trainingSide : 'none'
    return {
      rounds: clampInt(src.rounds, 1, maxRounds, DEFAULT_ROUNDS),
      bubbleSeconds: clampFloat(src.bubbleSeconds, 0.01, 120, DEFAULT_BUBBLE_SECONDS),
      discussionSeconds: clampInt(src.discussionSeconds, 1, 1800, DEFAULT_DISCUSSION_SECONDS),
      judges: clampInt(src.judges, 1, 3, 1),
      timeScale: clampFloat(src.timeScale, 1, 60, 2),
      mode: src.mode === 'demo' ? 'demo' : 'ai',
      provider: typeof src.provider === 'string' && src.provider.trim() ? src.provider.trim() : null,
      model: typeof src.model === 'string' && src.model.trim() ? src.model.trim() : null,
      reasoningEffort: typeof src.reasoningEffort === 'string' && src.reasoningEffort.trim() ? src.reasoningEffort.trim() : null,
      trainingSide,
      // 训练结束条件：winrate=训练方胜率超过阈值即收官；rounds=固定轮次跑满。
      trainingStop: src.trainingStop === 'rounds' ? 'rounds' : 'winrate',
      trainingWinRate: clampInt(src.trainingWinRate, 1, 100, 50),
      maxIterations: clampInt(src.maxIterations, 1, 100, 6),
      simpleMode: src.simpleMode === true,
      loadFlow: src.loadFlow !== false,
      prompts: src.prompts && typeof src.prompts === 'object' ? { ...src.prompts } : null,
      llmTimeoutMs: clampInt(src.llmTimeoutMs, 1000, 300000, DEFAULT_CONFIG.llmTimeoutMs),
      maxRounds,
      customFlow,
      flow,
    }
  }

  async _uniqueRunId(topic) {
    const base = runIdFor(topic, new Date(this.now()))
    let candidate = base
    let index = 1
    for (;;) {
      try {
        await fsp.access(path.join(this.baseDir, candidate))
        index += 1
        candidate = `${base}-${index}`
      } catch {
        return candidate
      }
    }
  }

  async start(settings = {}) {
    const topic = typeof settings?.topic === 'string' ? settings.topic.trim() : ''
    if (!topic) throw new Error('辩题不能为空')
    if (topic.length > 200) throw new Error('辩题不能超过 200 字')
    // 兼容两种入参：{topic, config:{...}}（HTTP/routes 使用的标准结构）与扁平 {topic, rounds, ...}
    const rawConfig = settings?.config && typeof settings.config === 'object' ? settings.config : settings
    this.customApi = rawConfig?.apiBaseUrl && rawConfig?.apiKey
      ? { baseUrl: String(rawConfig.apiBaseUrl).trim(), apiKey: String(rawConfig.apiKey).trim() }
      : null
    const config = this._normalizeConfig(rawConfig)

    if (this.running || (this.state.active && this.state.phase !== 'done')) {
      await this.stop({ silent: true })
    }

    this.gen += 1
    this._loopGen = this.gen
    const runId = await this._uniqueRunId(topic)
    const createdAt = this.now()
    const materials = normalizeMaterials(settings?.materials)

    this.state = emptyState(this.defaults)
    const s = this.state
    s.runId = runId
    s.topic = topic
    s.created = createdAt
    s.updated = createdAt
    s.rounds = config.rounds
    s.round = 1
    s.bubbleSeconds = config.bubbleSeconds
    s.mode = config.mode
    s.materials = materials
    s.active = true
    s.recovered = false
    s.paused = false
    s.phase = 'idle'
    s.phaseDetail = 'idle'
    s.lastEvent = '运行已创建'
    s.config = {
      rounds: config.rounds,
      bubbleSeconds: config.bubbleSeconds,
      discussionSeconds: config.discussionSeconds,
      judges: config.judges,
      timeScale: config.timeScale,
      mode: config.mode,
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      trainingSide: config.trainingSide,
      trainingStop: config.trainingStop,
      trainingWinRate: config.trainingWinRate,
      maxIterations: config.maxIterations,
      simpleMode: config.simpleMode,
      loadFlow: config.loadFlow,
      llmTimeoutMs: config.llmTimeoutMs,
      customFlow: config.customFlow,
    }
    this.records = emptyRecords(runId, topic, config.mode)
    this.flow = config.flow
    this.cursor = { round: 1, stageIndex: 0, discussionDone: false, debateDone: false, summaryDone: false }
    this.drafts = { pro: '', con: '' }
    this.discussionSummaries = { pro: '', con: '' }
    this.seq = 0
    this.stopped = false
    this.paused = false
    this._skipFlag = false
    this.mode = config.mode

    await this.store.ensureRunDir(runId)
    await this.store.cleanTmpFiles(runId)
    await this.store.writeRun(runId, {
      runId,
      topic,
      created: createdAt,
      version: VERSION,
      config: { ...s.config },
      flow: this.flow,
      materials,
    })
    this._ensureRoster()
    this._ensureSimulator()
    await this.flushState()
    this._refreshRuns()
    this._startLoop(this.gen)
    return this.getState()
  }

  _startLoop(gen) {
    if (this.running) return
    this._loopPromise = this.runLoop(gen)
    this._loopPromise.catch((err) => this.logger('[debate] 主循环异常:', err?.message || err))
  }

  /* -------------------------------- 控制面 ------------------------------ */

  async control(action) {
    const act = String(action || '')
    const s = this.state
    switch (act) {
      case 'pause': {
        if (!s.runId || !s.active) throw new Error('当前没有进行中的辩论')
        if (this.paused) return this.getState()
        this.paused = true
        s.phaseDetail = s.phase === 'paused' ? s.phaseDetail : s.phase
        s.phase = 'paused'
        s.paused = true
        s.lastEvent = '已暂停（当前回合结束后挂起）'
        this.emit()
        await this.flushState()
        return this.getState()
      }
      case 'resume':
      case 'resume-run': {
        if (!s.runId) throw new Error('当前没有可继续的辩论')
        if (s.phase === 'done') return this.getState()
        this.paused = false
        s.paused = false
        s.recovered = false
        const real = s.phaseDetail && s.phaseDetail !== 'paused' ? s.phaseDetail : 'debate'
        s.phase = real === 'idle' || real === 'done' || real === 'error' ? 'debate' : real
        if (!this.running) {
          this._resumeRun()
        } else {
          s.lastEvent = '已继续'
          this._resolvePause()
          this.emit()
        }
        await this.flushState()
        return this.getState()
      }
      case 'skip': {
        if (!s.runId || !s.active) throw new Error('当前没有进行中的辩论')
        this._skipFlag = true
        s.lastEvent = '已跳过当前发言等待'
        this.emit()
        this.touch()
        return this.getState()
      }
      case 'stop': {
        if (!s.runId) throw new Error('当前没有可停止的辩论')
        return this.stop({})
      }
      default:
        throw new Error(`未知控制指令：${act}`)
    }
  }

  _resumeRun() {
    if (!this.state.runId) return
    this.stopped = false
    this.paused = false
    this.state.active = true
    this.state.recovered = false
    this.state.lastEvent = '已恢复并继续运行'
    this.gen += 1
    this._loopGen = this.gen
    this._startLoop(this.gen)
  }

  async stop(options = {}) {
    const s = this.state
    if (!s.runId) return this.getState()
    if (s.phase === 'done' && !options.silent) return this.getState()
    this.stopped = true
    this.paused = false
    this._skipFlag = false
    this._resolvePause()
    this._releaseWaits()
    try {
      this.abort?.abort()
    } catch {
      /* ignore */
    }
    this.abort = null
    if (this._loopPromise) {
      await this._awaitDeadline(this._loopPromise, 2000)
    }
    this._loopPromise = null
    this.running = false
    this._clearTimers()

    const roundDir = path.join(this.runDir(), docs.roundDirName(s.round))
    const zipRel = docs.zipName(s.round)
    const hasZip = (s.archive.zips || []).some((zip) => zip.round === s.round)
    if (!hasZip) {
      try {
        await removeDir(roundDir)
      } catch (err) {
        this._note(err, '清理本轮临时目录失败')
      }
    }
    this.roster = null
    this.sim = null
    s.current = null
    s.discussion = { active: false, side: null, turns: [] }
    s.clock = { total: 0, remaining: 0, pro: 0, con: 0 }
    s.agents = { count: 0, alive: 0, note: options.silent ? '已停止（切换新运行）' : '已停止，临时文件已清理' }
    s.phase = 'idle'
    s.phaseDetail = 'idle'
    s.active = false
    s.paused = false
    s.recovered = false
    s.lastEvent = options.silent ? '运行已结束（切换新运行）' : '本轮已停止，临时目录已清理'
    if (!hasZip) s.discussion.active = false
    this.cursor = { round: s.round || 1, stageIndex: 0, discussionDone: false, debateDone: false, summaryDone: false }
    await this.flushState()
    this._refreshRuns()
    this.emit()
    return this.getState()
  }

  /* -------------------------------- 主循环 ------------------------------ */

  async runLoop(gen) {
    if (this.running) return
    this.running = true
    this._loopGen = gen
    const s = this.state
    let trainingStopReason = ''
    try {
      while (!this.stopped && !this._stale(gen) && s.round <= s.rounds) {
        this._ensureRoster()
        this._ensureSimulator()
        this._roundRecord(s.round)
        if (!this.cursor.discussionDone) await this._discussionPhase(gen)
        if (this.stopped || this._stale(gen)) break
        if (!this.cursor.debateDone) await this._debatePhase(gen)
        if (this.stopped || this._stale(gen)) break
        if (!this.cursor.summaryDone) await this._summaryPhase(gen)
        if (this.stopped || this._stale(gen)) break
        await this._archivePhase(gen)
        if (this.stopped || this._stale(gen)) break
        // 训练结束条件：胜率阈值（默认）或固定轮次。
        trainingStopReason = this._trainingStopReason()
        if (trainingStopReason) {
          s.lastEvent = trainingStopReason
          break
        }
        if (s.round >= s.rounds) break
        s.round += 1
        this.cursor = { round: s.round, stageIndex: 0, discussionDone: false, debateDone: false, summaryDone: false }
        this._resetRoundState()
        await this.flushState()
      }
      if (!this.stopped && !this._stale(gen) && s.rounds >= 1 && (s.round >= s.rounds || trainingStopReason)) {
        await this._finalPhase(gen)
      }
    } catch (err) {
      if (!this._stale(gen)) this._fail(err)
    } finally {
      if (!this._stale(gen)) {
        this.running = false
        s.updated = this.now()
        this.emit()
      }
    }
  }

  _stale(gen) {
    return gen !== this.gen
  }

  /**
   * 训练方是否达到结束条件。
   * - trainingStop=rounds：永不提前收官，跑满轮次。
   * - trainingStop=winrate（默认）：按已完成轮次累计胜率，严格大于阈值即收官。
   * @returns {string} 空字符串表示未达成
   */
  _trainingStopReason() {
    const s = this.state
    const side = s.config?.trainingSide
    if (side !== 'pro' && side !== 'con') return ''
    if (s.config?.trainingStop !== 'winrate') return ''
    const completed = (this.records?.rounds || []).filter((item) => item && item.archiveRel && item.scores)
    if (completed.length === 0) return ''
    const wins = completed.filter((item) => side === 'pro'
      ? Number(item.scores.pro) > Number(item.scores.con)
      : Number(item.scores.con) > Number(item.scores.pro)).length
    const rate = (wins / completed.length) * 100
    const threshold = Number(s.config.trainingWinRate) || 0
    if (rate > threshold) {
      const label = side === 'pro' ? '正方' : '反方'
      return `训练目标达成：${label}胜率 ${rate.toFixed(1)}%（${wins}/${completed.length}）> ${threshold}%，提前结束`
    }
    return ''
  }

  /** 等待 promise 落定，最多 ms 毫秒（超时也返回，避免 stop 卡死）。 */
  _awaitDeadline(promise, ms) {
    if (!promise || typeof promise.then !== 'function') return Promise.resolve('none')
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish('timeout'), Math.max(1, Number(ms) || 1000))
      promise.then(() => finish('done'), () => finish('error'))
    })
  }

  _resetRoundState() {
    const s = this.state
    s.stageIndex = 0
    s.stageCount = 0
    s.stage = null
    s.clock = { total: 0, remaining: 0, pro: 0, con: 0 }
    s.current = null
    s.discussion = { active: false, side: null, turns: [] }
    s.huddles = { pro: [], con: [] }
    s.drafts = { pro: '', con: '' }
    s.pro.score = 0
    s.con.score = 0
    s.judges = (s.judges || []).map((judge) => ({ ...judge, scorePro: 0, scoreCon: 0, lastComment: '' }))
    s.adminComment = ''
    this.paused = false
    s.paused = false
    this.drafts = { pro: '', con: '' }
    this.discussionSummaries = { pro: '', con: '' }
  }

  /* ------------------------------ 讨论阶段 ------------------------------ */

  async _discussionPhase(gen) {
    const s = this.state
    this._setPhase('discussion')
    const total = s.config.discussionSeconds
    const scale = Math.max(1, s.config.timeScale)
    const wallMs = Math.max(20, Math.round((total * 1000) / scale))
    s.clock = { total, remaining: total, pro: total, con: total }
    s.discussion = { active: true, side: null, turns: [] }
    s.lastEvent = `讨论阶段开始：双方各 ${total} 秒（节奏 ×${scale}）`
    await this.flushState()
    const roundRec = this._roundRecord(s.round)
    roundRec.discussion = { pro: [], con: [] }

    let proCount = 0
    let conCount = 0
    const publishTurn = (side, turn) => {
      const agent = this._agentById(turn.speakerId) || this._sideAgent(side, 1)
      const record = {
        speakerId: agent?.id || turn.speakerId || `${side}-1`,
        speakerName: agent?.name || turn.speakerName || '',
        text: String(turn.text || ''),
        at: this.now(),
      }
      roundRec.discussion[side].push(record)
      s.discussion.turns.push({ side, ...record })
      this.drafts[side] = this._composeDraft(side, roundRec)
      if (side === 'pro') proCount += 1
      else conCount += 1
      this.touch()
    }

    const proPromise = this._discussSide('pro', total, (turn) => publishTurn('pro', turn), this.now() + wallMs)
    const conPromise = this._discussSide('con', total, (turn) => publishTurn('con', turn), this.now() + wallMs)
    const tickerPromise = this._discussTicker(wallMs, total, scale)

    const proRes = await proPromise
    if (this.stopped || this._stale(gen)) return
    for (const turn of (proRes?.turns || []).slice(proCount)) publishTurn('pro', turn)
    this.discussionSummaries.pro = typeof proRes?.summary === 'string' ? proRes.summary : ''
    const conRes = await conPromise
    if (this.stopped || this._stale(gen)) return
    for (const turn of (conRes?.turns || []).slice(conCount)) publishTurn('con', turn)
    this.discussionSummaries.con = typeof conRes?.summary === 'string' ? conRes.summary : ''
    this.prepDrafts = { pro: proRes?.drafts || null, con: conRes?.drafts || null }
    this.drafts.pro = this._composeDraft('pro', roundRec, proRes?.drafts)
    this.drafts.con = this._composeDraft('con', roundRec, conRes?.drafts)
    await tickerPromise
    if (this.stopped || this._stale(gen)) return

    s.discussion.active = false
    s.discussion.side = null
    s.clock = { total, remaining: 0, pro: 0, con: 0 }
    await this._writeDiscussionFiles(roundRec)
    this.cursor.discussionDone = true
    s.lastEvent = '讨论阶段结束，讨论记录已写入'
    await this.flushState()
  }

  async _discussTicker(wallMs, total, scale) {
    const s = this.state
    const slice = 100
    const steps = Math.max(1, Math.ceil(wallMs / slice))
    for (let index = 0; index < steps; index += 1) {
      if (this.stopped) break
      const elapsed = Math.min(wallMs, (index + 1) * slice)
      const remaining = Math.max(0, Math.round(total - (elapsed / 1000) * scale))
      s.clock.remaining = remaining
      s.clock.pro = remaining
      s.clock.con = remaining
      this.touch()
      const sliceMs = Math.min(slice, wallMs - index * slice)
      if (sliceMs > 0) await this._wait(sliceMs)
    }
    s.clock.remaining = 0
    s.clock.pro = 0
    s.clock.con = 0
    this.touch()
  }

  async _discussSide(side, seconds, onTurn, deadline) {
    const s = this.state
    const agents = side === 'pro' ? this.roster.pro : this.roster.con
    const fallback = { turns: demoDiscussionTurns(side, agents, s.topic), summary: '' }
    if (!this.sim || typeof this.sim.discuss !== 'function') {
      for (const turn of fallback.turns) {
        if (typeof onTurn === 'function') await onTurn(turn)
      }
      return fallback
    }
    try {
      const res = await this._withTimeout(
        this.sim.discuss({
          topic: s.topic,
          side,
          agents,
          materials: this._materialsFor(side),
          seconds,
          onTurn,
          deadline,
          signal: this.abort?.signal,
        }),
        Math.round((seconds * 1000) / Math.max(1, s.config.timeScale)) + s.config.llmTimeoutMs,
        null,
      )
      if (!res || typeof res !== 'object') return fallback
      return {
        turns: Array.isArray(res.turns) ? res.turns : [],
        summary: typeof res.summary === 'string' ? res.summary : '',
        drafts: res.drafts && typeof res.drafts === 'object' ? res.drafts : null,
      }
    } catch (err) {
      this._note(err, `${docs.sideLabel(side)}讨论生成失败`)
      return fallback
    }
  }

  _composeDraft(side, roundRec, prep) {
    const lines = [`辩题：${this.state.topic}`, `立场：${docs.sideLabel(side)}`]
    if (prep?.opening) lines.push('', '【一辩陈词·预写稿】', String(prep.opening))
    if (prep?.second) lines.push('', '【二辩问题链与小结·预写稿】', String(prep.second))
    if (prep?.third) lines.push('', '【三辩问题链与小结·预写稿】', String(prep.third))
    if (prep?.fourth) lines.push('', '【四辩总结·预写稿】', String(prep.fourth))
    const summary = this.discussionSummaries[side]
    if (summary) lines.push('', '讨论小结：', summary)
    const turns = (roundRec?.discussion?.[side] || []).slice(-6)
    if (turns.length) {
      lines.push('', '讨论要点：')
      for (const turn of turns) lines.push(`- ${turn.speakerName}：${truncate(turn.text, 120)}`)
    }
    return lines.join('\n')
  }

  /* ------------------------------ 辩论阶段 ------------------------------ */

  async _debatePhase(gen) {
    const s = this.state
    this._setPhase('debate')
    const flow = this.flow
    s.stageCount = flow.length
    const roundRec = this._roundRecord(s.round)
    s.lastEvent = `辩论阶段开始：共 ${flow.length} 个环节`
    await this.flushState()

    for (let index = clampInt(this.cursor.stageIndex, 0, flow.length, 0); index < flow.length; index += 1) {
      if (this.stopped || this._stale(gen)) return
      await this._pauseGate()
      if (this.stopped) return
      const stage = flow[index]
      s.stageIndex = index
      s.stage = stageView(stage)
      this._resetStageClock(stage)
      const stageRec = this._stageRecord(roundRec, stage, index)
      const responderSeat = this._responderSeat(stage)
      const turns = planTurns(stage)
      s.lastEvent = `环节 ${index + 1}/${flow.length}：${stage.title}`
      this.touch()

      for (const turn of turns) {
        if (this.stopped || this._stale(gen)) return
        await this._pauseGate()
        if (this.stopped) return
        const agent = this._agentForTurn(turn, stage, responderSeat)
        const speech = await this._speak({ stage, stageIndex: index, turn, agent })
        if (this._stale(gen)) return
        // 时钟已按真实秒在气泡期间逐秒扣减，这里不再一次性扣整个回合份额。
        stageRec.speeches.push({
          id: speech.id,
          seq: speech.seq,
          side: turn.side,
          speakerId: speech.speakerId,
          speakerName: speech.speakerName,
          seat: speech.seat,
          text: speech.text,
          thought: speech.thought || '',
          at: speech.startedAt,
          endsAt: speech.endedAt,
          stageTitle: stage.title,
        })
        this.touch()
      }

      await this._stageHuddles(stage, index)

      for (const judgeAgent of this.roster.judges) {
        if (this.stopped || this._stale(gen)) return
        await this._judgeStage(stage, index, judgeAgent)
      }
      this.cursor.stageIndex = index + 1
      await this._writeSpeechFile(roundRec, 'pro')
      await this._writeSpeechFile(roundRec, 'con')
      await this._writeJudgeFiles(roundRec)
      await this.flushState()
    }
    this.cursor.debateDone = true
    s.lastEvent = '辩论阶段结束'
    await this.flushState()
  }

  async _stageHuddles(stage, stageIndex) {
    const s = this.state
    if (!this.sim || typeof this.sim.huddle !== 'function') return
    const transcript = this._transcript()
    await Promise.all(['pro', 'con'].map(async (side) => {
      try {
        const res = await this._withTimeout(
          this.sim.huddle({
            topic: s.topic,
            round: s.round,
            stage,
            side,
            agents: side === 'pro' ? this.roster.pro : this.roster.con,
            transcript,
            signal: this.abort?.signal,
          }),
          s.config.llmTimeoutMs,
          null,
        )
        if (!res || !res.text) return
        if (!s.huddles[side]) s.huddles[side] = []
        s.huddles[side].push({
          speakerId: res.speakerId || `${side}-1`,
          speakerName: res.speakerName || docs.sideLabel(side),
          text: String(res.text),
          stageTitle: stage.title,
          stageIndex,
          at: this.now(),
        })
        if (s.huddles[side].length > 40) s.huddles[side].splice(0, s.huddles[side].length - 40)
        this.touch()
      } catch (err) {
        this._note(err, `${docs.sideLabel(side)}队内讨论生成失败`)
      }
    }))
    await this.flushState().catch(() => {})
  }

  _stageTimeUp(stage) {
    const clock = this.state.clock
    return stage.perSide
      ? (Number(clock.pro) <= 0 && Number(clock.con) <= 0)
      : Number(clock.remaining) <= 0
  }

  _resetStageClock(stage) {
    const seconds = stage.seconds
    const s = this.state
    if (stage.perSide) {
      s.clock = { total: seconds * 2, remaining: seconds * 2, pro: seconds, con: seconds }
    } else if (stage.side === 'both') {
      s.clock = { total: seconds, remaining: seconds, pro: seconds, con: seconds }
    } else {
      s.clock = {
        total: seconds,
        remaining: seconds,
        pro: stage.side === 'pro' ? seconds : 0,
        con: stage.side === 'con' ? seconds : 0,
      }
    }
  }

  _tickClock(plan) {
    const clock = this.state.clock
    if (plan.perSide) {
      const key = plan.side === 'pro' ? 'pro' : 'con'
      clock[key] = Math.max(0, Math.round(Number(clock[key] || 0) - 1))
      clock.remaining = clock.pro + clock.con
      return
    }
    const remaining = Math.max(0, Math.round(Number(clock.remaining || 0) - 1))
    clock.remaining = remaining
    if (plan.side === 'pro') clock.pro = remaining
    else if (plan.side === 'con') clock.con = remaining
    else {
      clock.pro = remaining
      clock.con = remaining
    }
  }

  _consumeClock(stage, turn) {
    const clock = this.state.clock
    const share = Number.isFinite(Number(turn.share)) ? Math.max(0, Math.min(1, Number(turn.share))) : 0
    const delta = stage.seconds * share
    if (stage.perSide) {
      const key = turn.side === 'pro' ? 'pro' : 'con'
      clock[key] = Math.max(0, Math.round(clock[key] - delta))
      clock.remaining = clock.pro + clock.con
    } else {
      clock.remaining = Math.max(0, Math.round(clock.remaining - delta))
      if (stage.side === 'both') {
        clock.pro = clock.remaining
        clock.con = clock.remaining
      } else if (stage.side === 'pro') {
        clock.pro = clock.remaining
      } else {
        clock.con = clock.remaining
      }
    }
  }

  _responderSeat(stage) {
    if (Number.isFinite(Number(stage.targetSeat))) return clampInt(stage.targetSeat, 1, 4, 1)
    const exclude = new Set(Array.isArray(stage.targetExclude) ? stage.targetExclude.map((v) => Number(v)) : [])
    if (Number.isFinite(Number(stage.seat))) exclude.add(clampInt(stage.seat, 1, 4, 1))
    for (const seat of [1, 2, 3, 4]) {
      if (!exclude.has(seat)) return seat
    }
    return 1
  }

  _agentForTurn(turn, stage, responderSeat) {
    const list = turn.side === 'pro' ? this.roster.pro : this.roster.con
    let seat = turn.seat === null || turn.seat === undefined ? null : clampInt(turn.seat, 1, 4, 1)
    if (seat === null) {
      seat = turn.role === 'responder' ? responderSeat : clampInt(stage.seat, 1, 4, 1)
    }
    const agent = list.find((item) => item.seat === seat) || list[0] || null
    return agent
  }

  async _speak({ stage, stageIndex, turn, agent }) {
    const s = this.state
    const side = turn.side
    const transcript = this._transcript()
    const ownSpeeches = this._ownSpeeches(side)
    const drafts = { pro: this.drafts.pro, con: this.drafts.con }
    // 思考（think）、生成台词与气泡展示都计入环节时间：从本回合一开始就逐秒走。
    const clockPlan = {
      base: { ...s.clock },
      delta: stage.seconds * Math.max(0, Math.min(1, Number(turn.share) || 0)),
      side,
      perSide: stage.perSide === true,
    }
    let clockTimer = null
    if (clockPlan.delta > 0) {
      clockTimer = setInterval(() => {
        this._tickClock(clockPlan)
        this.touch()
      }, 1000)
      this._timers.add(clockTimer)
    }
    let thought = ''
    let text = ''
    let fallback = true
    if (this.sim && typeof this.sim.speak === 'function') {
      if (typeof this.sim.think === 'function') {
        try {
          const res = await this._withTimeout(
            this.sim.think({
              topic: s.topic,
              round: s.round,
              stage,
              speaker: agent,
              side,
              transcript,
              draft: drafts[side],
              signal: this.abort?.signal,
            }),
            s.config.llmTimeoutMs,
            null,
          )
          if (res && typeof res.text === 'string' && res.text.trim()) thought = res.text.trim()
        } catch (err) {
          this._note(err, `${agent?.name || docs.sideLabel(side)}思考层生成失败`)
        }
      }
      try {
        const res = await this._withTimeout(
          this.sim.speak({
            topic: s.topic,
            round: s.round,
            stage,
            speaker: agent,
            side,
            transcript,
            draft: drafts[side],
            ownSpeeches,
            thought,
            signal: this.abort?.signal,
          }),
          s.config.llmTimeoutMs,
          null,
        )
        if (res && typeof res.text === 'string' && res.text.trim()) {
          text = res.text.trim()
          fallback = res.fallback === true
        }
      } catch (err) {
        this._note(err, `${agent?.name || docs.sideLabel(side)}发言生成失败`)
      }
    }
    if (!text) {
      text = demoSpeechText(agent, stage)
      if (this.sim && typeof this.sim.speak === 'function') {
        this.records.issueLog.push({
          round: s.round,
          stageIndex,
          text: `环节「${stage.title}」发言回退为占位内容`,
          at: this.now(),
        })
      }
    }
    const speech = await this._bubble({
      side,
      agent,
      text,
      thought,
      kind: stage.kind,
      stageIndex,
      stageTitle: stage.title,
    })
    if (clockTimer) {
      clearInterval(clockTimer)
      this._timers.delete(clockTimer)
    }
    if (this.mode === 'demo' && fallback) {
      /* 保持 mode 为 demo；mixed 由 index 侧决定 */
    }
    return speech
  }

  async _judgeStage(stage, stageIndex, judgeAgent) {
    const s = this.state
    const roundRec = this._roundRecord(s.round)
    const previous = s.judges.find((judge) => judge.id === judgeAgent.id)
    const fallback = {
      pro: Number(previous?.scorePro) || 60,
      con: Number(previous?.scoreCon) || 60,
      comment: `${judgeAgent.name}：环节「${stage.title}」双方各有攻防，暂无明显失分点。`,
      findings: [],
    }
    let data = null
    if (this.sim && typeof this.sim.judge === 'function') {
      try {
        data = await this._withTimeout(
          this.sim.judge({
            topic: s.topic,
            round: s.round,
            stage,
            judge: judgeAgent,
            transcript: this._transcript(),
            scoreboard: s.scoreboard,
            signal: this.abort?.signal,
          }),
          s.config.llmTimeoutMs,
          null,
        )
      } catch (err) {
        this._note(err, `${judgeAgent.name}评分失败`)
      }
    }
    const pro = clampScore(data?.pro, fallback.pro)
    const con = clampScore(data?.con, fallback.con)
    const comment = typeof data?.comment === 'string' ? data.comment : fallback.comment
    const findings = Array.isArray(data?.findings) ? data.findings.filter((item) => typeof item === 'string' && item.trim()) : []
    const at = this.now()

    roundRec.judgeNotes.push({
      stageIndex,
      stageTitle: stage.title,
      judgeId: judgeAgent.id,
      judgeName: judgeAgent.name,
      pro,
      con,
      comment,
      findings,
      at,
    })
    const view = s.judges.find((judge) => judge.id === judgeAgent.id)
    if (view) {
      view.scorePro = pro
      view.scoreCon = con
      view.lastComment = comment
    }
    s.scoreboard.history.push({
      round: s.round,
      stageIndex,
      stageTitle: stage.title,
      judgeId: judgeAgent.id,
      judgeName: judgeAgent.name,
      pro,
      con,
      comment,
      at,
    })
    if (s.scoreboard.history.length > 400) s.scoreboard.history.splice(0, s.scoreboard.history.length - 400)
    this._recomputeScores()
    this.touch()
  }

  _recomputeScores() {
    const s = this.state
    const judges = Array.isArray(s.judges) ? s.judges : []
    if (judges.length === 0) {
      s.scoreboard.pro = 0
      s.scoreboard.con = 0
    } else {
      const pro = judges.reduce((sum, judge) => sum + (Number(judge.scorePro) || 0), 0) / judges.length
      const con = judges.reduce((sum, judge) => sum + (Number(judge.scoreCon) || 0), 0) / judges.length
      s.scoreboard.pro = Math.round(pro * 10) / 10
      s.scoreboard.con = Math.round(con * 10) / 10
    }
    s.pro.score = s.scoreboard.pro
    s.con.score = s.scoreboard.con
    const roundRec = this._roundRecord(s.round)
    roundRec.scores = { pro: s.scoreboard.pro, con: s.scoreboard.con }
  }

  /* ------------------------------ 总结阶段 ------------------------------ */

  async _summaryPhase(gen) {
    const s = this.state
    this._setPhase('summary')
    const roundRec = this._roundRecord(s.round)
    const priorRounds = this.records.rounds.filter((item) => item.round < s.round)
    s.lastEvent = '教练总结阶段'
    await this.flushState()

    for (const side of ['pro', 'con']) {
      if (this.stopped || this._stale(gen)) return
      await this._pauseGate()
      if (this.stopped) return
      const coach = this.roster?.coaches?.[side] || null
      let text = ''
      let analysis = ''
      if (this.sim && typeof this.sim.coach === 'function') {
        try {
          const res = await this._withTimeout(
            this.sim.coach({
              topic: s.topic,
              side,
              round: s.round,
              transcript: this._transcript(),
              judgeNotes: this._judgeNotes(),
              scoreboard: s.scoreboard,
              priorRounds,
              signal: this.abort?.signal,
            }),
            s.config.llmTimeoutMs,
            null,
          )
          if (res && typeof res === 'object') {
            text = typeof res.text === 'string' ? res.text.trim() : ''
            analysis = typeof res.analysis === 'string' ? res.analysis.trim() : ''
          }
        } catch (err) {
          this._note(err, `${docs.sideLabel(side)}教练总结失败`)
        }
      }
      if (!text) text = demoCoachText(side, s.topic, s.round)
      roundRec.summaries[side] = text
      if (analysis) roundRec.summaryAnalysis[side] = analysis
      this.drafts[side] = `${this.drafts[side] || ''}\n\n【教练总结】\n${text}`.trim()
      await this._bubble({
        side,
        agent: coach,
        text,
        kind: 'summary',
        stageIndex: -1,
        stageTitle: '教练总结',
      })
      if (this._stale(gen)) return
      await this._writeCoachFiles(roundRec, side)
      await this.flushState()
    }

    let adminText = ''
    if (this.sim && typeof this.sim.adminComment === 'function') {
      try {
        const res = await this._withTimeout(
          this.sim.adminComment({
            topic: s.topic,
            round: s.round,
            scoreboard: s.scoreboard,
            transcript: this._transcript(),
            issues: this.records.issueLog.map((item) => item.text),
            signal: this.abort?.signal,
          }),
          s.config.llmTimeoutMs,
          null,
        )
        if (res && typeof res.text === 'string') adminText = res.text.trim()
      } catch (err) {
        this._note(err, '管理员评论生成失败')
      }
    }
    if (!adminText) {
      adminText = `第 ${s.round} 轮结束：正方 ${s.scoreboard.pro} 分，反方 ${s.scoreboard.con} 分。本轮${s.scoreboard.pro >= s.scoreboard.con ? '正方' : '反方'}占优，归档已生成，双方教练总结已写入本方目录。`
    }
    roundRec.summaries.admin = adminText
    s.adminComment = adminText
    await this._writeAdminFile(roundRec)
    this.cursor.summaryDone = true
    s.lastEvent = '教练总结与管理员评论已写入'
    await this.flushState()
  }

  /* ------------------------------ 归档阶段 ------------------------------ */

  async _archivePhase(gen) {
    const s = this.state
    this._setPhase('archive')
    const roundRec = this._roundRecord(s.round)
    const paths = docs.roundPaths(this.runDir(), s.round)
    s.lastEvent = `正在打包第 ${s.round} 轮归档`
    await this.flushState()

    const existingZip = (s.archive.zips || []).find((zip) => zip.round === s.round)
    let dirExists = true
    try {
      await fsp.access(paths.dir)
    } catch {
      dirExists = false
    }
    if (existingZip && !dirExists) {
      this.cursor.summaryDone = true
      s.lastEvent = `第 ${s.round} 轮已归档，跳过重复打包`
      await this.flushState()
      return
    }

    await this._writeSpeechFile(roundRec, 'pro')
    await this._writeSpeechFile(roundRec, 'con')
    await this._writeJudgeFiles(roundRec)
    await this._writeAdminFile(roundRec)

    let preFiles = []
    try {
      preFiles = await listFilesRecursive(paths.dir)
    } catch (err) {
      this._note(err, '读取本轮产物失败')
    }
    const summaryData = this._roundSummaryData(roundRec)
    summaryData.files = preFiles.map((file) => ({ name: file.rel, bytes: file.size }))
    try {
      await docs.writeRoundReadme(paths.readmeFile, summaryData)
    } catch (err) {
      this._note(err, '写入本机 README 失败')
    }

    let entries = []
    try {
      const files = await listFilesRecursive(paths.dir)
      entries = await Promise.all(files.map(async (file) => ({ name: file.rel, data: await fsp.readFile(file.abs) })))
    } catch (err) {
      this._note(err, '读取本轮产物失败')
    }
    if (entries.length === 0) {
      await ensureDir(paths.dir)
      entries = [{ name: 'README.txt', data: docs.renderRoundReadme(summaryData) }]
    }
    let zipBuffer
    try {
      zipBuffer = createZip(entries)
      await ensureDir(this.runDir())
      await fsp.writeFile(paths.zipFile, zipBuffer)
    } catch (err) {
      this._note(err, '打包本轮归档失败')
      return
    }

    roundRec.archiveRel = docs.zipName(s.round)
    roundRec.endedAt = roundRec.endedAt || this.now()
    const indexEntry = this._roundIndexEntry(roundRec, zipBuffer.length, entries)
    try {
      const index = await this.store.readRoundsIndex(s.runId)
      const next = index.filter((item) => Number(item.round) !== s.round).concat(indexEntry)
      next.sort((a, b) => Number(a.round) - Number(b.round))
      await this.store.writeRoundsIndex(s.runId, next)
    } catch (err) {
      this._note(err, '写入 rounds-index.json 失败')
    }

    s.archive.zips = (s.archive.zips || []).filter((zip) => zip.round !== s.round)
    s.archive.zips.push({
      round: s.round,
      name: docs.zipName(s.round),
      rel: docs.zipName(s.round),
      bytes: zipBuffer.length,
      created: this.now(),
    })
    s.archive.zips.sort((a, b) => a.round - b.round)

    try {
      await removeDir(paths.dir)
    } catch (err) {
      this._note(err, '删除本轮临时目录失败')
    }

    this.roster = null
    this.sim = null
    s.agents = { count: 0, alive: 0, note: `第 ${s.round} 轮智能体已全部删除` }
    s.discussion = { active: false, side: null, turns: [] }
    s.current = null
    s.lastEvent = `第 ${s.round} 轮归档完成：${docs.zipName(s.round)}（${formatBytes(zipBuffer.length)}）`
    this.cursor = { round: s.round, stageIndex: 0, discussionDone: true, debateDone: true, summaryDone: true }
    await this.flushState()
    this._refreshRuns()
  }

  _roundSummaryData(roundRec) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    const speechCount = (roundRec.stages || []).reduce((sum, stage) => sum + (stage.speeches || []).length, 0)
    const discussionCount = (roundRec.discussion?.pro || []).length + (roundRec.discussion?.con || []).length
    return {
      topic: s.topic,
      runId: s.runId,
      round: s.round,
      rounds: s.rounds,
      mode: s.mode,
      createdAt: s.created,
      scores: { pro: s.scoreboard.pro, con: s.scoreboard.con },
      stageCount: (roundRec.stages || []).length,
      speechCount: speechCount + discussionCount,
      judgeCount: (s.judges || []).length,
      files: [],
      zipName: docs.zipName(s.round),
      coachLines: [
        { side: '正方', text: roundRec.summaries?.pro || '' },
        { side: '反方', text: roundRec.summaries?.con || '' },
      ],
      adminComment: roundRec.summaries?.admin || '',
    }
  }

  _roundIndexEntry(roundRec, bytes, entries) {
    const s = this.state
    const speechCount = (roundRec.stages || []).reduce((sum, stage) => sum + (stage.speeches || []).length, 0)
    return {
      round: s.round,
      topic: s.topic,
      mode: s.mode,
      startedAt: roundRec.startedAt || 0,
      endedAt: roundRec.endedAt || this.now(),
      scores: { pro: s.scoreboard.pro, con: s.scoreboard.con },
      stageCount: (roundRec.stages || []).length,
      speechCount,
      discussionCount: (roundRec.discussion?.pro || []).length + (roundRec.discussion?.con || []).length,
      judgeNotesCount: (roundRec.judgeNotes || []).length,
      judgeScores: (roundRec.judgeNotes || []).map((note) => ({
        stageIndex: note.stageIndex,
        stageTitle: note.stageTitle,
        judgeName: note.judgeName,
        pro: note.pro,
        con: note.con,
      })),
      coaches: {
        pro: truncate(roundRec.summaries?.pro || '', 400),
        con: truncate(roundRec.summaries?.con || '', 400),
      },
      adminComment: truncate(roundRec.summaries?.admin || '', 400),
      archiveRel: docs.zipName(s.round),
      archiveName: docs.zipName(s.round),
      bytes,
      files: (entries || []).map((entry) => entry.name),
      createdAt: this.now(),
    }
  }

  async _writeTrainingReport() {
    const s = this.state
    const side = s.config.trainingSide
    if (side !== 'pro' && side !== 'con') return
    const sideLabel = side === 'pro' ? '正方' : '反方'
    const oppLabel = side === 'pro' ? '反方' : '正方'
    const rounds = Array.isArray(this.records.rounds) ? this.records.rounds : []
    const sections = []
    const original = []
    for (const round of rounds) {
      original.push(`第 ${round.round} 轮（正方 ${round.scores?.pro ?? 0} : 反方 ${round.scores?.con ?? 0}）`)
      for (const stage of round.stages || []) {
        for (const speech of stage.speeches || []) {
          original.push(`【${stage.title}】${speech.speakerName}（${speech.seat || '?'}辩）：${speech.text}`)
        }
      }
    }
    sections.push({ heading: '一、原文（全部轮次 / 全部环节 / 每条发言）', paragraphs: original.length ? original : ['（无发言记录）'] })

    const method = []
    const flaws = []
    const advice = []
    for (const round of rounds) {
      const summary = round.summaries?.[side]
      if (summary) method.push(`第 ${round.round} 轮复盘：${summary}`)
      const analysis = round.summaryAnalysis?.[side]
      if (analysis) advice.push(`第 ${round.round} 轮分析：${analysis}`)
      for (const note of round.judgeNotes || []) {
        flaws.push(`第 ${round.round} 轮【${note.stageTitle || ''}】评委 ${note.judgeName || ''}：${note.comment || ''}`)
      }
    }
    sections.push({ heading: '二、方法', paragraphs: method.length ? method : ['（无教练复盘，按赛制与预写稿执行）'] })
    sections.push({ heading: '三、缺点', paragraphs: flaws.length ? flaws : ['（评委未记录明确缺点）'] })
    sections.push({ heading: '四、提升建议', paragraphs: advice.length ? advice : ['结合评委记录继续打磨定义、判准与回应质量。'] })

    const drafts = this.prepDrafts?.[side]
    const draftLines = []
    if (drafts?.opening) draftLines.push(`【一辩陈词】\n${drafts.opening}`)
    if (drafts?.second) draftLines.push(`【二辩问题链与小结】\n${drafts.second}`)
    if (drafts?.third) draftLines.push(`【三辩问题链与小结】\n${drafts.third}`)
    if (drafts?.fourth) draftLines.push(`【四辩总结】\n${drafts.fourth}`)
    sections.push({ heading: '五、最终稿', paragraphs: draftLines.length ? draftLines : ['（无预写稿）'] })

    const responses = []
    const lastRound = rounds[rounds.length - 1]
    for (const stage of lastRound?.stages || []) {
      for (const speech of stage.speeches || []) {
        if (speech.side === side) continue
        responses.push(`对方可能：${truncate(speech.text, 160)}\n我方应对：回到判准，指出其前提/口径问题，并用最终稿中对应论证回应。`)
      }
    }
    sections.push({ heading: '六、可能应对', paragraphs: responses.length ? responses : ['（无对手发言记录）'] })

    const md = [`# 训练方备赛包 · ${sideLabel}`, `辩题：${s.topic}`, `训练目标：${sideLabel}得分超过${oppLabel}`, '']
    for (const section of sections) {
      md.push(`## ${section.heading}`, '')
      for (const paragraph of section.paragraphs) md.push(paragraph, '')
    }
    const mdText = md.join('\n')
    const base = `训练方备赛包_${sideLabel}`
    const mdPath = path.join(this.runDir(), `${base}.md`)
    await fsp.writeFile(mdPath, mdText, 'utf8')
    const docxPath = path.join(this.runDir(), `${base}.docx`)
    const docx = await writeDocxFile(docxPath, {
      title: `训练方备赛包 · ${sideLabel}`,
      subtitle: `${s.topic} · ${s.runId}`,
      sections,
      footer: 'DSH 辩论模拟 · 训练方备赛包',
    })
    s.archive.trainingMd = { name: `${base}.md`, rel: `${base}.md`, bytes: Buffer.byteLength(mdText) }
    s.archive.trainingDocx = { name: `${base}.docx`, rel: `${base}.docx`, bytes: docx.bytes }
  }

  /* ------------------------------ 最终阶段 ------------------------------ */

  async _finalPhase(gen) {
    const s = this.state
    this._setPhase('final')
    s.lastEvent = '正在生成全部轮次汇总与 Word 总结'
    await this.flushState()
    const roundsIndex = await this.store.readRoundsIndex(s.runId)
    try {
      const out = await docs.writeFinalArtifacts({
        runDir: this.runDir(),
        topic: s.topic,
        runId: s.runId,
        records: this.records,
        roundsIndex,
        config: s.config,
        createdAt: s.created,
        finishedAt: this.now(),
        slug: slugify(s.topic, 'debate'),
      })
      s.archive.summaryMd = out.summaryMd
      s.archive.finalDocx = out.finalDocx
      this.records.final = { summaryMd: out.summaryMd.rel, docxRel: out.finalDocx.rel }
      s.lastEvent = `已生成全部轮次汇总与 ${out.finalDocx.name}`
    } catch (err) {
      this._note(err, '生成最终总结失败')
      return
    }
    try {
      await this._writeTrainingReport()
    } catch (err) {
      this._note(err, '生成训练方备赛包失败')
    }
    if (this._stale(gen)) return
    // 先把 final 阶段状态落盘，再切到 done：避免外部看到 done 时写入仍未结束。
    await this.flushState()
    s.phase = 'done'
    s.phaseDetail = 'done'
    s.active = false
    s.paused = false
    s.current = null
    s.agents = { count: 0, alive: 0, note: '全部轮次已完成，智能体已删除' }
    s.lastEvent = '全部轮次已完成'
    this.cursor = { round: s.round, stageIndex: this.flow.length, discussionDone: true, debateDone: true, summaryDone: true }
    await this.flushState()
    this._refreshRuns()
  }

  /* ------------------------------- 气泡内核 ----------------------------- */

  async _bubble({ side, agent, text, thought, kind, stageIndex, stageTitle, clockPlan }) {
    const s = this.state
    const durationMs = Math.max(0, Math.round(s.bubbleSeconds * 1000))
    const startedAt = this.now()
    this.seq += 1
    const speech = {
      id: `sp-${s.round}-${this.seq}`,
      seq: this.seq,
      round: s.round,
      stageIndex,
      stageTitle,
      side,
      speakerId: agent?.id || `${side}-1`,
      speakerName: agent?.name || docs.sideLabel(side),
      seat: agent?.seat ?? null,
      avatar: agent?.avatar || '',
      color: agent?.color || (side === 'pro' ? '#2f6fed' : '#d14343'),
      text: String(text ?? ''),
      thought: String(thought ?? ''),
      kind: kind || 'speech',
      startedAt,
      endsAt: startedAt + durationMs,
      durationMs,
    }
    s.current = speech
    if (speech.thought) {
      if (!Array.isArray(s.thoughts)) s.thoughts = []
      s.thoughts.push({
        id: speech.id,
        side,
        speakerName: speech.speakerName,
        text: speech.thought,
        stageTitle,
        at: startedAt,
      })
      if (s.thoughts.length > 20) s.thoughts.splice(0, s.thoughts.length - 20)
    }
    this._markSpeaking(agent, speech, true)
    s.recent.push(speechSummary(speech))
    if (s.recent.length > 30) s.recent.splice(0, s.recent.length - 30)
    s.lastEvent = `${speech.speakerName}：${truncate(speech.text, 24)}`
    s.updated = startedAt
    this.emit()
    let clockTimer = null
    if (clockPlan && durationMs > 0 && Number(clockPlan.delta) > 0) {
      // 真实计时：每 1 秒只扣 1 秒；单边计时时回答方 share=0，时钟保持暂停。
      clockTimer = setInterval(() => {
        this._tickClock(clockPlan)
        this.touch()
      }, 1000)
      this._timers.add(clockTimer)
    }
    try {
      await this._waitBubble(durationMs)
    } finally {
      if (clockTimer) {
        clearInterval(clockTimer)
        this._timers.delete(clockTimer)
      }
    }
    const endedAt = this.now()
    s.current = null
    this._markSpeaking(agent, speech, false)
    this.touch()
    return { ...speech, endedAt, wallDurationMs: Math.max(0, endedAt - startedAt) }
  }

  async _waitBubble(ms) {
    let left = Math.max(0, Number(ms) || 0)
    if (left <= 0) {
      this._skipFlag = false
      return
    }
    const slice = 100
    while (left > 0) {
      if (this._skipFlag) {
        this._skipFlag = false
        return
      }
      if (this.stopped) return
      const step = Math.min(slice, left)
      await this._wait(step)
      left -= step
    }
    this._skipFlag = false
  }

  _wait(ms) {
    if (this.injectedWait) {
      return Promise.resolve(this.injectedWait(ms, this.abort?.signal))
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this._timers.delete(timer)
        this._waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, Number(ms) || 0))
      this._timers.add(timer)
      this._waiters.add(done)
    })
  }

  _releaseWaits() {
    for (const done of [...this._waiters]) {
      try {
        done()
      } catch {
        /* ignore */
      }
    }
    this._waiters.clear()
  }

  _clearTimers() {
    for (const timer of this._timers) clearTimeout(timer)
    this._timers.clear()
  }

  async _pauseGate() {
    while (this.paused && !this.stopped) {
      await new Promise((resolve) => {
        this._pauseResolve = resolve
      })
      this._pauseResolve = null
    }
  }

  _resolvePause() {
    const resolve = this._pauseResolve
    this._pauseResolve = null
    if (resolve) resolve()
  }

  async _withTimeout(promise, ms, fallback) {
    if (!promise || typeof promise.then !== 'function') return fallback
    let timer = null
    try {
      const result = await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ __timeout: true }), Math.max(1, Number(ms) || this.defaults.llmTimeoutMs || 90000))
          this._timers.add(timer)
        }),
      ])
      if (result && result.__timeout) {
        try {
          this.abort?.abort()
        } catch {
          /* ignore */
        }
        return fallback
      }
      return result
    } finally {
      if (timer) {
        clearTimeout(timer)
        this._timers.delete(timer)
      }
    }
  }

  /* ------------------------------- 视图辅助 ----------------------------- */

  _setPhase(phase) {
    const s = this.state
    this.abort = new AbortController()
    s.phaseDetail = phase
    s.phase = this.paused ? 'paused' : phase
    s.updated = this.now()
    this.emit()
    this.touch()
  }

  _markSpeaking(agent, speech, speaking) {
    if (!agent) return
    const list = speech.side === 'pro' ? this.state.pro.debaters : this.state.con.debaters
    const view = (list || []).find((item) => item.id === agent.id)
    if (!view) return
    view.speaking = speaking
    if (speaking) {
      view.lastText = speech.text
      view.lastAt = speech.startedAt
    }
  }

  _ensureRoster() {
    if (this.roster) return this.roster
    const judges = clampInt(this.state.config?.judges, 1, 3, 1)
    try {
      this.roster = this.createRosterFn ? this.createRosterFn({ judges }) : fallbackRoster(judges)
    } catch (err) {
      this._note(err, '创建智能体名单失败，使用内置默认名单')
      this.roster = fallbackRoster(judges)
    }
    if (!this.roster || !Array.isArray(this.roster.pro) || !Array.isArray(this.roster.con)) {
      this.roster = fallbackRoster(this.state.config.judges)
    }
    if (!Array.isArray(this.roster.judges) || this.roster.judges.length === 0) {
      this.roster.judges = fallbackRoster(this.state.config.judges).judges
    }
    if (!this.roster.coaches) {
      const fb = fallbackRoster(this.state.config.judges)
      this.roster.coaches = fb.coaches
    }
    if (!this.roster.admin) this.roster.admin = fallbackRoster(this.state.config.judges).admin
    this._applyRosterToState()
    return this.roster
  }

  _applyRosterToState() {
    const s = this.state
    const roster = this.roster
    const toView = (agent) => ({
      id: agent.id,
      name: agent.name,
      seat: agent.seat ?? null,
      avatar: agent.avatar || '',
      color: agent.color || '',
      lastText: '',
      lastAt: 0,
      speaking: false,
    })
    const existing = new Map()
    for (const item of [...(s.pro.debaters || []), ...(s.con.debaters || [])]) existing.set(item.id, item)
    s.pro.debaters = roster.pro.map((agent) => ({ ...toView(agent), ...(existing.get(agent.id) || {}) }))
    s.con.debaters = roster.con.map((agent) => ({ ...toView(agent), ...(existing.get(agent.id) || {}) }))
    s.judges = roster.judges.map((agent) => {
      const prev = (s.judges || []).find((item) => item.id === agent.id)
      return {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar || '',
        scorePro: prev?.scorePro || 0,
        scoreCon: prev?.scoreCon || 0,
        lastComment: prev?.lastComment || '',
      }
    })
    const count = roster.pro.length + roster.con.length + roster.judges.length + 3
    s.agents = {
      count,
      alive: count,
      note: `辩手 ${roster.pro.length + roster.con.length} · 评委 ${roster.judges.length} · 教练 2 · 管理员 1`,
    }
  }

  _ensureSimulator() {
    if (this.sim) return this.sim
    const s = this.state
    if (!this.createSimulatorFn) {
      this.sim = null
      return this.sim
    }
    try {
      const customModel = s.config.provider && s.config.model
        ? { provider: s.config.provider, model: s.config.model, ...(s.config.reasoningEffort ? { reasoningEffort: s.config.reasoningEffort } : {}) }
        : this.model
      this.sim = this.createSimulatorFn({
        mode: s.config.mode,
        bubbleSeconds: s.bubbleSeconds,
        logger: this.logger,
        model: customModel,
        customApi: this.customApi,
        prompts: s.config.prompts,
        llmTimeoutMs: s.config.llmTimeoutMs,
        llm: this.llm,
      })
    } catch (err) {
      this._note(err, '创建模拟器失败，使用演示回退')
      this.sim = null
    }
    try {
      const mode = this.sim?.mode?.()
      if (mode === 'ai' || mode === 'demo') this.mode = mode
    } catch {
      this.mode = s.config.mode
    }
    if (this.mode && this.mode !== s.config.mode) s.mode = this.mode
    return this.sim
  }

  _agentById(id) {
    if (!id || !this.roster) return null
    const all = [...this.roster.pro, ...this.roster.con]
    return all.find((agent) => agent.id === id) || null
  }

  _sideAgent(side, seat) {
    if (!this.roster) return null
    const list = side === 'pro' ? this.roster.pro : this.roster.con
    return list.find((agent) => agent.seat === seat) || list[0] || null
  }

  _materialsFor(side) {
    const s = this.state
    const lines = [`辩题：${s.topic}`, `立场：${docs.sideLabel(side)}`, '赛程：']
    this.flow.forEach((stage, index) => {
      lines.push(`${index + 1}. ${stage.title}（${stage.seconds} 秒${stage.perSide ? '，双方各自计时' : ''}）`)
    })
    if (s.materials) lines.push('', '补充材料：', s.materials)
    return lines.join('\n')
  }

  _transcript() {
    const s = this.state
    const roundRec = this.records.rounds.find((item) => item.round === s.round)
    if (!roundRec) return []
    const out = []
    for (const side of ['pro', 'con']) {
      for (const turn of roundRec.discussion?.[side] || []) {
        out.push({ stageTitle: '讨论阶段', side, speakerName: turn.speakerName, text: turn.text })
      }
    }
    for (const stage of roundRec.stages || []) {
      for (const speech of stage.speeches || []) {
        out.push({ stageTitle: stage.title, side: speech.side, speakerName: speech.speakerName, text: speech.text })
      }
    }
    return out.slice(-80)
  }

  _ownSpeeches(side) {
    return this._transcript().filter((item) => item.side === side).slice(-30)
  }

  _judgeNotes() {
    const roundRec = this.records.rounds.find((item) => item.round === this.state.round)
    return (roundRec?.judgeNotes || []).map((note) => ({
      stageIndex: note.stageIndex,
      stageTitle: note.stageTitle,
      judgeName: note.judgeName,
      pro: note.pro,
      con: note.con,
      comment: note.comment,
    }))
  }

  /* ------------------------------- 记录维护 ----------------------------- */

  _roundRecord(round) {
    let record = this.records.rounds.find((item) => Number(item.round) === Number(round))
    if (!record) {
      const s = this.state
      record = {
        round: Number(round),
        topic: s.topic,
        scores: { pro: 0, con: 0 },
        discussion: { pro: [], con: [] },
        stages: [],
        judgeNotes: [],
        summaries: { pro: '', con: '', admin: '' },
        summaryAnalysis: { pro: '', con: '' },
        archiveRel: null,
        startedAt: this.now(),
        endedAt: null,
      }
      this.records.rounds.push(record)
      this.records.rounds.sort((a, b) => Number(a.round) - Number(b.round))
    }
    if (!record.discussion) record.discussion = { pro: [], con: [] }
    if (!Array.isArray(record.stages)) record.stages = []
    if (!Array.isArray(record.judgeNotes)) record.judgeNotes = []
    if (!record.summaries) record.summaries = { pro: '', con: '', admin: '' }
    if (!record.summaryAnalysis) record.summaryAnalysis = { pro: '', con: '' }
    return record
  }

  _stageRecord(roundRec, stage, stageIndex) {
    let record = roundRec.stages.find((item) => Number(item.stageIndex) === stageIndex)
    if (!record) {
      record = {
        stageIndex,
        id: stage.id,
        title: stage.title,
        side: stage.side,
        seconds: stage.seconds,
        speeches: [],
      }
      roundRec.stages.push(record)
      roundRec.stages.sort((a, b) => Number(a.stageIndex) - Number(b.stageIndex))
    } else {
      record.speeches = []
      record.title = stage.title
      record.side = stage.side
      record.seconds = stage.seconds
    }
    return record
  }

  /* ------------------------------- 产物写入 ----------------------------- */

  async _writeDiscussionFiles(roundRec) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    const total = s.config.discussionSeconds
    const wallSeconds = Math.round(total / Math.max(1, s.config.timeScale))
    for (const side of ['pro', 'con']) {
      const sideDir = paths.sideDir(side)
      try {
        await ensureDir(sideDir)
        await docs.writeDiscussionRecord(path.join(sideDir, '讨论记录.md'), {
          topic: s.topic,
          side,
          round: s.round,
          seconds: total,
          wallSeconds,
          turns: roundRec.discussion[side] || [],
          summary: this.discussionSummaries[side],
        })
        await docs.writeDraftPaper(path.join(sideDir, '草稿纸.md'), {
          topic: s.topic,
          side,
          round: s.round,
          now: this.now(),
          material: s.materials,
          points: [
            `我方立场：${docs.sideLabel(side)}`,
            `核心主张：${truncate(this.discussionSummaries[side] || '围绕辩题展开论证', 120)}`,
            `讨论阶段我方发言 ${(roundRec.discussion[side] || []).length} 条（详见讨论记录.md）`,
          ],
          discussionSummary: this.discussionSummaries[side],
        })
        await docs.writeAnalysisMaterial(path.join(sideDir, '分析材料.md'), {
          topic: s.topic,
          side,
          round: s.round,
          flow: this.flow,
          material: s.materials,
          discussionSummary: this.discussionSummaries[side],
        })
      } catch (err) {
        this._note(err, `写入${docs.sideLabel(side)}讨论产物失败`)
      }
    }
  }

  async _writeSpeechFile(roundRec, side) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    try {
      await ensureDir(paths.sideDir(side))
      await docs.writeSpeechRecord(paths.sideFile(side, '发言记录.md'), {
        topic: s.topic,
        side,
        round: s.round,
        stages: roundRec.stages,
        now: this.now(),
        coachText: roundRec.summaries?.[side] || '',
      })
    } catch (err) {
      this._note(err, `写入${docs.sideLabel(side)}发言记录失败`)
    }
  }

  async _writeJudgeFiles(roundRec) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    try {
      await ensureDir(paths.judgeDir)
      await docs.writeJudgeRecord(paths.judgeFile('评委记录.md'), {
        topic: s.topic,
        round: s.round,
        notes: roundRec.judgeNotes,
        now: this.now(),
      })
      await docs.writeScoreboard(paths.judgeFile('计分板.md'), {
        topic: s.topic,
        round: s.round,
        history: s.scoreboard.history.filter((item) => item.round === s.round),
        judges: s.judges,
        pro: s.scoreboard.pro,
        con: s.scoreboard.con,
        now: this.now(),
      })
    } catch (err) {
      this._note(err, '写入评委记录/计分板失败')
    }
  }

  async _writeCoachFiles(roundRec, side) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    try {
      await ensureDir(paths.sideDir(side))
      await docs.writeCoachSummary(paths.sideFile(side, '总结.md'), {
        topic: s.topic,
        side,
        round: s.round,
        text: roundRec.summaries?.[side] || '',
        analysis: roundRec.summaryAnalysis?.[side] || '',
        scoreboard: s.scoreboard,
      })
      await docs.writeAnalysisMaterial(paths.sideFile(side, '分析材料.md'), {
        topic: s.topic,
        side,
        round: s.round,
        flow: this.flow,
        material: s.materials,
        discussionSummary: [this.discussionSummaries[side], roundRec.summaryAnalysis?.[side] || ''].filter(Boolean).join('\n\n'),
      })
    } catch (err) {
      this._note(err, `写入${docs.sideLabel(side)}总结失败`)
    }
  }

  async _writeAdminFile(roundRec) {
    const s = this.state
    const paths = docs.roundPaths(this.runDir(), s.round)
    try {
      await ensureDir(paths.dir)
      await docs.writeAdminComment(paths.adminFile, {
        topic: s.topic,
        round: s.round,
        rounds: s.rounds,
        adminText: roundRec.summaries?.admin || s.adminComment || '',
        scoreboard: s.scoreboard,
        issues: this.records.issueLog.slice(-5).map((item) => item.text),
        now: this.now(),
      })
    } catch (err) {
      this._note(err, '写入管理员评论失败')
    }
  }

  /* ------------------------------- 持久化 ------------------------------- */

  _doc() {
    return {
      ...this.state,
      records: this.records,
      cursor: this.cursor,
      flow: this.flow,
      seq: this.seq,
      savedAt: this.now(),
    }
  }

  touch() {
    if (!this.state.runId) return
    this.state.updated = this.now()
    this.store.schedule(this.state.runId, () => this._doc())
    this.emit()
  }

  async flushState() {
    if (this._loopGen !== null && this._loopGen !== this.gen) return
    if (!this.state.runId) return
    this.store.schedule(this.state.runId, () => this._doc())
    await this.store.flush()
  }

  _note(err, label = '操作失败') {
    // 旧一代循环在 stop()/restart 之后才醒过来时，不得把错误写进新一代的状态。
    if (this._loopGen !== null && this._loopGen !== this.gen) return
    const message = err && err.message ? err.message : String(err ?? '')
    const text = `${label}：${message}`.slice(0, 400)
    this.state.error = text
    this.records.issueLog.push({ round: this.state.round, stageIndex: this.state.stageIndex, text, at: this.now() })
    if (this.records.issueLog.length > 200) this.records.issueLog.splice(0, this.records.issueLog.length - 200)
    this.logger('[debate]', text)
    this.touch()
  }

  _fail(err) {
    if (this._loopGen !== null && this._loopGen !== this.gen) return
    const s = this.state
    const message = err && err.message ? err.message : String(err ?? '')
    s.error = `运行失败：${message}`.slice(0, 400)
    s.lastEvent = s.error
    s.phase = 'error'
    s.phaseDetail = this.state.phaseDetail || 'error'
    s.paused = false
    s.current = null
    this.paused = false
    this.records.issueLog.push({ round: s.round, stageIndex: s.stageIndex, text: s.error, at: this.now() })
    this.logger('[debate] 运行失败:', err)
    this.flushState().catch(() => {})
    this.emit()
  }
}

function normalizeMaterials(input) {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input.trim()
  if (Array.isArray(input)) return input.map((item) => String(item ?? '').trim()).filter(Boolean).join('\n')
  return ''
}

function normalizeDiscussionTurns(result, side, roster) {
  const turns = Array.isArray(result?.turns) ? result.turns : []
  return turns
    .map((turn, index) => {
      if (!turn || typeof turn !== 'object') return null
      const text = typeof turn.text === 'string' ? turn.text : String(turn.text ?? '')
      if (!text.trim()) return null
      const list = side === 'pro' ? roster?.pro || [] : roster?.con || []
      const byId = list.find((agent) => agent.id === turn.speakerId)
      const agent = byId || list[index % Math.max(1, list.length)] || null
      return {
        speakerId: agent?.id || turn.speakerId || `${side}-1`,
        speakerName: agent?.name || turn.speakerName || docs.sideLabel(side),
        text: text.trim(),
      }
    })
    .filter(Boolean)
}

/**
 * 创建辩论模拟引擎。
 * @param {{baseDir:string, config?:object, createSimulator?:Function, createRoster?:Function,
 *          now?:Function, wait?:Function, logger?:Function, model?:object|null, llm?:object|null}} options
 */
export function createEngine(options = {}) {
  return new Engine(options)
}

export { DEFAULT_CONFIG }
