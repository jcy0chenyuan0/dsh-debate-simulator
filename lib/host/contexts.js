/**
 * 权限上下文（契约：docs/CONTRACT.md §2.3）。
 *
 * 铁律：
 * - 辩手上下文里**绝不出现** scoreboard / judgeNotes / 对方 draft；
 * - 评委、教练、管理员可见全部记录、计分板与双方草稿；
 * - assertIsolation(agent, bundle) 一旦发现越权字段就 throw（引擎/测试都会调用）。
 *
 * 纯函数：输入 runView，输出新的 ContextBundle，不修改入参。
 */

/** 拥有完整视野的角色。 */
export const FULL_ACCESS_ROLES = ['judge', 'coach', 'admin']

const FULL_ACCESS = new Set(FULL_ACCESS_ROLES)

/** 角色是否拥有完整视野。 */
export function isFullAccessRole(role) {
  return FULL_ACCESS.has(normalizeString(role))
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toInt(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function cloneValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return Array.isArray(value) ? [...value] : { ...value }
  }
}

function agentSideOf(id) {
  const text = normalizeString(id)
  if (text.startsWith('pro-')) return 'pro'
  if (text.startsWith('con-')) return 'con'
  return null
}

/** 规范化发言记录：只留公开可展示字段，顺手过滤私密条目。 */
export function normalizeTranscript(transcript, options = {}) {
  const { role = null } = options
  if (!Array.isArray(transcript)) return []
  const out = []
  for (const item of transcript) {
    if (!item || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) continue
    // 明确标记为私密 / 指定角色的条目一律不进通用转录。
    if (item.private === true || item.internal === true) continue
    if (Array.isArray(item.forRoles) && role && !item.forRoles.includes(role)) continue
    const speakerId = normalizeString(item.speakerId) || null
    out.push({
      round: toInt(item.round, 0) || undefined,
      stageIndex: toInt(item.stageIndex, 0) || undefined,
      stageTitle: normalizeString(item.stageTitle) || undefined,
      side: normalizeString(item.side) || agentSideOf(speakerId) || undefined,
      speakerId,
      speakerName: normalizeString(item.speakerName) || undefined,
      seat: Number.isFinite(Number(item.seat)) ? toInt(item.seat) : undefined,
      text,
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : undefined,
      kind: normalizeString(item.kind) || undefined,
    })
  }
  return out
}

function normalizeOwnSpeeches(ownSpeeches, transcript, agent) {
  const source = Array.isArray(ownSpeeches) && ownSpeeches.length > 0 ? ownSpeeches : transcript
  const id = normalizeString(agent?.id)
  const name = normalizeString(agent?.name)
  const list = normalizeTranscript(source).filter((item) => {
    if (id && item.speakerId) return item.speakerId === id
    if (name && item.speakerName) return item.speakerName === name
    return false
  })
  return list
}

function normalizeMaterials(materials) {
  if (!Array.isArray(materials)) return []
  const out = []
  materials.forEach((item, index) => {
    if (item == null) return
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) out.push({ name: `分析材料 ${index + 1}`, text })
      return
    }
    if (typeof item !== 'object') return
    const text = normalizeString(item.text ?? item.content ?? item.body)
    if (!text) return
    out.push({ name: normalizeString(item.name ?? item.title) || `分析材料 ${index + 1}`, text })
  })
  return out
}

function normalizeStage(stage) {
  if (!stage || typeof stage !== 'object') return null
  return {
    id: normalizeString(stage.id) || undefined,
    title: normalizeString(stage.title) || undefined,
    kind: normalizeString(stage.kind) || undefined,
    rule: normalizeString(stage.rule) || undefined,
    description: normalizeString(stage.description) || undefined,
    side: normalizeString(stage.side) || undefined,
    seconds: Number.isFinite(Number(stage.seconds)) ? toInt(stage.seconds) : undefined,
  }
}

function normalizeScoreboard(scoreboard) {
  if (!scoreboard || typeof scoreboard !== 'object') {
    return { pro: 0, con: 0, history: [] }
  }
  const history = Array.isArray(scoreboard.history)
    ? scoreboard.history
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          round: toInt(item.round, 0) || undefined,
          stageIndex: toInt(item.stageIndex, 0) || undefined,
          stageTitle: normalizeString(item.stageTitle) || undefined,
          pro: Number(item.pro) || 0,
          con: Number(item.con) || 0,
          comment: normalizeString(item.comment) || undefined,
          at: Number.isFinite(Number(item.at)) ? Number(item.at) : undefined,
        }))
    : []
  return {
    pro: Number(scoreboard.pro) || 0,
    con: Number(scoreboard.con) || 0,
    history,
  }
}

function normalizeJudgeNotes(notes) {
  if (!Array.isArray(notes)) return []
  return notes
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      round: toInt(item.round, 0) || undefined,
      stageIndex: toInt(item.stageIndex, 0) || undefined,
      stageTitle: normalizeString(item.stageTitle) || undefined,
      judgeId: normalizeString(item.judgeId) || undefined,
      judgeName: normalizeString(item.judgeName) || undefined,
      pro: Number(item.pro) || 0,
      con: Number(item.con) || 0,
      comment: normalizeString(item.comment ?? item.text) || undefined,
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : undefined,
    }))
}

/**
 * 把各种草稿形状统一成 [{agentId, side, seat, text}]。
 * 支持：{ pro:'...', con:'...' } / { 'pro-1':'...' } / [{agentId,side,text}] / 字符串数组。
 */
export function normalizeDrafts(drafts) {
  if (!drafts) return []
  const out = []
  const push = (entry) => {
    if (!entry) return
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text) out.push({ agentId: null, side: null, seat: null, text })
      return
    }
    if (typeof entry !== 'object') return
    const text = normalizeString(entry.text ?? entry.content ?? entry.body ?? entry.draft)
    if (!text) return
    const agentId = normalizeString(entry.agentId ?? entry.id) || null
    const side = normalizeString(entry.side) || agentSideOf(agentId)
    out.push({
      agentId,
      side: side || null,
      seat: Number.isFinite(Number(entry.seat)) ? toInt(entry.seat) : null,
      text,
    })
  }

  if (Array.isArray(drafts)) {
    drafts.forEach(push)
    return out
  }
  if (typeof drafts === 'string') {
    push(drafts)
    return out
  }
  if (typeof drafts === 'object') {
    for (const [key, value] of Object.entries(drafts)) {
      if (value == null) continue
      if (typeof value === 'string') {
        const side = key === 'pro' || key === 'con' ? key : agentSideOf(key)
        const agentId = side && key !== 'pro' && key !== 'con' ? key : null
        out.push({ agentId, side: side || null, seat: null, text: value.trim() })
        continue
      }
      if (typeof value === 'object') {
        push({ ...value, agentId: value.agentId ?? value.id ?? (agentSideOf(key) ? key : undefined), side: value.side ?? (key === 'pro' || key === 'con' ? key : undefined) })
      }
    }
  }
  return out
}

function isOpponentDraft(draft, agent) {
  if (!draft || typeof draft !== 'object') return false
  const agentId = normalizeString(agent?.id)
  const agentSide = normalizeString(agent?.side)
  const side = normalizeString(draft.side) || agentSideOf(draft.agentId)
  if (side && agentSide && side !== agentSide && side !== 'neutral') return true
  if (agentId && draft.agentId && draft.agentId !== agentId) {
    const otherSide = agentSideOf(draft.agentId)
    if (otherSide && agentSide && otherSide !== agentSide) return true
  }
  return false
}

/** 只保留本方（或本人）草稿。 */
export function ownDrafts(drafts, agent) {
  return normalizeDrafts(drafts).filter((draft) => !isOpponentDraft(draft, agent))
}

function draftMapFor(agent, draft) {
  if (draft == null) return undefined
  if (typeof draft === 'string') {
    const text = draft.trim()
    return text ? { [agent?.id ?? 'draft']: text } : undefined
  }
  return draft
}

function baseAgent(agent) {
  const source = agent && typeof agent === 'object' ? agent : {}
  return {
    id: normalizeString(source.id) || 'unknown',
    name: normalizeString(source.name) || '辩手',
    side: normalizeString(source.side) || 'neutral',
    seat: Number.isFinite(Number(source.seat)) ? toInt(source.seat) : null,
    role: normalizeString(source.role) || 'debater',
    avatar: normalizeString(source.avatar) || '🙂',
    color: normalizeString(source.color) || '#64748b',
    title: normalizeString(source.title) || undefined,
    style: normalizeString(source.style) || undefined,
    styleLabel: normalizeString(source.styleLabel) || undefined,
  }
}

/**
 * 按角色构建上下文。
 * @param {object} agent 智能体（{id,name,side,seat,role,...}）
 * @param {object} runView {topic, round, stage, transcript, drafts, scoreboard, judgeNotes, ownSpeeches, materials, priorRounds}
 * @returns {object} ContextBundle
 */
export function buildContext(agent, runView = {}) {
  const view = runView && typeof runView === 'object' ? runView : {}
  const me = baseAgent(agent)
  const role = me.role
  const full = isFullAccessRole(role)
  const transcript = normalizeTranscript(view.transcript, { role })
  const own = normalizeOwnSpeeches(view.ownSpeeches, transcript, me)

  const bundle = {
    agent: me,
    role,
    side: me.side,
    seat: me.seat,
    topic: normalizeString(view.topic),
    round: toInt(view.round, 1) || 1,
    stage: normalizeStage(view.stage),
    transcript,
    ownSpeeches: own,
    materials: normalizeMaterials(view.materials),
    visibility: full ? 'full' : 'limited',
  }

  if (full) {
    bundle.scoreboard = normalizeScoreboard(view.scoreboard)
    bundle.judgeNotes = normalizeJudgeNotes(view.judgeNotes)
    bundle.drafts = normalizeDrafts(view.drafts)
    bundle.priorRounds = Array.isArray(view.priorRounds) ? cloneValue(view.priorRounds) : []
    bundle.notes = Array.isArray(view.notes) ? cloneValue(view.notes) : []
  } else {
    // 辩手：只有本方草稿，绝无计分板 / 评委记录 / 对方草稿。
    bundle.drafts = ownDrafts(view.drafts, me)
    bundle.draft = ((view.draft ?? view.draftText) && typeof (view.draft ?? view.draftText) === 'string')
      ? String(view.draft ?? view.draftText).trim()
      : bundle.drafts.map((draft) => draft.text).join('\n')
  }

  return bundle
}

/**
 * 权限隔离断言：辩手 bundle 出现计分板、评委记录或对方草稿即 throw。
 * 评委/教练/管理员直接放行。
 */
export function assertIsolation(agent, bundle) {
  const role = normalizeString(agent?.role) || normalizeString(bundle?.role) || 'debater'
  if (isFullAccessRole(role)) return
  const who = normalizeString(agent?.name) || normalizeString(agent?.id) || '辩手'
  const violations = []

  if (!bundle || typeof bundle !== 'object') {
    throw new Error(`权限隔离违规（${who}）：上下文不是对象`)
  }
  if (Object.prototype.hasOwnProperty.call(bundle, 'scoreboard') && bundle.scoreboard != null) {
    violations.push('包含计分板 scoreboard')
  }
  if (Object.prototype.hasOwnProperty.call(bundle, 'judgeNotes') && bundle.judgeNotes != null) {
    violations.push('包含评委记录 judgeNotes')
  }
  if (Object.prototype.hasOwnProperty.call(bundle, 'priorRounds') && bundle.priorRounds != null) {
    const prior = bundle.priorRounds
    if (Array.isArray(prior) ? prior.length > 0 : Boolean(prior)) violations.push('包含他轮隐私记录 priorRounds')
  }
  const drafts = normalizeDrafts(bundle.drafts)
  if (drafts.some((draft) => isOpponentDraft(draft, agent))) {
    violations.push('包含对方草稿')
  }

  if (violations.length > 0) {
    throw new Error(`权限隔离违规（${who}）：${violations.join('、')}`)
  }
}
