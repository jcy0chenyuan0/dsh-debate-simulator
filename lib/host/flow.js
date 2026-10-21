/**
 * 默认赛制与回合规划（纯函数，无副作用）。
 * 契约见 docs/CONTRACT.md §2.2。
 */

export const DEFAULT_ROUNDS = 3
export const MAX_ROUNDS = 100
export const DEFAULT_BUBBLE_SECONDS = 10
export const DEFAULT_DISCUSSION_SECONDS = 180
export const DEFAULT_JUDGES = 1
export const DEFAULT_TIME_SCALE = 2
export const MAX_STAGES = 60

const KINDS = new Set(['speech', 'cross', 'dialogue', 'inquiry', 'free'])
const SIDES = new Set(['pro', 'con', 'both'])

/** 默认 14 环节（严格对应产品需求）。 */
export function defaultFlow() {
  return [
    {
      id: 'pro-opening',
      title: '正方一辩开篇立论',
      kind: 'speech',
      side: 'pro',
      seat: 1,
      seconds: 180,
      description: '正方一辩系统阐述本方立场、定义、标准与论证框架。',
      rule: '开篇立论，输出完整论证链：定义—标准—论点—论据—结论。',
    },
    {
      id: 'con-cross-1',
      title: '反方二辩质询正方一辩',
      kind: 'cross',
      side: 'con',
      seat: 2,
      targetSeat: 1,
      seconds: 90,
      singleSide: true,
      canInterrupt: true,
      exchanges: 4,
      description: '反方二辩质询正方一辩，对质询方单边计时 1 分 30 秒；回答方只能作答，质询方可打断。',
      rule: '只问不答；问题短、指向明确，可打断对方冗长回答。',
    },
    {
      id: 'con-opening',
      title: '反方一辩开篇立论',
      kind: 'speech',
      side: 'con',
      seat: 1,
      seconds: 180,
      description: '反方一辩系统阐述本方立场与论证框架。',
      rule: '开篇立论，必须正面回应正方立论的核心前提。',
    },
    {
      id: 'pro-cross-1',
      title: '正方二辩质询反方一辩',
      kind: 'cross',
      side: 'pro',
      seat: 2,
      targetSeat: 1,
      seconds: 90,
      singleSide: true,
      canInterrupt: true,
      exchanges: 4,
      description: '正方二辩质询反方一辩，对质询方单边计时 1 分 30 秒；回答方只能作答，质询方可打断。',
      rule: '只问不答；用对方立论中的定义与论据设问，逼出矛盾。',
    },
    {
      id: 'con-summary-1',
      title: '反方二辩就质询内容进行小结',
      kind: 'speech',
      side: 'con',
      seat: 2,
      seconds: 120,
      description: '反方二辩总结质询成果，时间 2 分钟。',
      rule: '小结质询中暴露的对方矛盾，并收束到本方论证。',
    },
    {
      id: 'pro-summary-1',
      title: '正方二辩就质询内容进行小结',
      kind: 'speech',
      side: 'pro',
      seat: 2,
      seconds: 120,
      description: '正方二辩总结质询成果，时间 2 分钟。',
      rule: '小结质询中确认的对方让步，并修补本方论证。',
    },
    {
      id: 'fourth-dialogue',
      title: '正反方四辩对辩',
      kind: 'dialogue',
      side: 'both',
      seats: [4, 4],
      seconds: 90,
      perSide: true,
      first: 'pro',
      exchanges: 6,
      description: '双方四辩对辩，各 1 分 30 秒，交替发言，分开计时；正方先行，辩手无权中止对方未完成之言论。',
      rule: '交替发言，不得打断对方；每轮回应对方上一句并推进己方比较优势。',
    },
    {
      id: 'pro-inquiry',
      title: '正方三辩盘问',
      kind: 'inquiry',
      side: 'pro',
      seat: 3,
      targetExclude: [3],
      seconds: 90,
      singleSide: true,
      respondentNoClock: true,
      canInterrupt: true,
      exchanges: 4,
      description: '正方三辩盘问，对盘问方计时 1 分 30 秒；被盘问方可指派除三辩外任一辩手作答，中途不可更换；答辩方只能作答，发言时长不计入总时间。',
      rule: '盘问方连续设问；被盘问方只能作答，不能反问。',
    },
    {
      id: 'con-inquiry',
      title: '反方三辩盘问',
      kind: 'inquiry',
      side: 'con',
      seat: 3,
      targetExclude: [3],
      seconds: 90,
      singleSide: true,
      respondentNoClock: true,
      canInterrupt: true,
      exchanges: 4,
      description: '反方三辩盘问，对盘问方计时 1 分 30 秒；被盘问方可指派除三辩外任一辩手作答，中途不可更换；答辩方只能作答，发言时长不计入总时间。',
      rule: '盘问方连续设问；被盘问方只能作答，不能反问。',
    },
    {
      id: 'pro-inquiry-summary',
      title: '正方三辩质询小结',
      kind: 'speech',
      side: 'pro',
      seat: 3,
      seconds: 120,
      description: '正方三辩就盘问内容作小结，时间 2 分钟。',
      rule: '把盘问中获得的承认整理成本方论证的支点。',
    },
    {
      id: 'con-inquiry-summary',
      title: '反方三辩质询小结',
      kind: 'speech',
      side: 'con',
      seat: 3,
      seconds: 120,
      description: '反方三辩就盘问内容作小结，时间 2 分钟。',
      rule: '把盘问中获得的承认整理成本方论证的支点。',
    },
    {
      id: 'free-debate',
      title: '自由辩论',
      kind: 'free',
      side: 'both',
      seconds: 180,
      perSide: true,
      first: 'pro',
      exchanges: 8,
      description: '双方各 3 分钟，正方开始；同一方发言次序不限；一方时间用完另一方可继续，也可放弃发言。',
      rule: '短兵相接，每轮只回应一个点；不得重复已说过的论据。',
    },
    {
      id: 'con-closing',
      title: '反方四辩总结陈词',
      kind: 'speech',
      side: 'con',
      seat: 4,
      seconds: 210,
      description: '反方四辩总结陈词，时间 3 分 30 秒。',
      rule: '总结全场交锋，给出比较标准与最终判准，回应对方核心攻击。',
    },
    {
      id: 'pro-closing',
      title: '正方四辩总结陈词',
      kind: 'speech',
      side: 'pro',
      seat: 4,
      seconds: 210,
      description: '正方四辩总结陈词，时间 3 分 30 秒。',
      rule: '总结全场交锋，给出比较标准与最终判准，回应对方核心攻击。',
    },
  ]
}

/**
 * 规划一个环节的回合序列。
 * @returns {{side:'pro'|'con', role:'speaker'|'examiner'|'responder'|'free'|'summary', seat:number|null, share:number}[]}
 */
export function planTurns(stage) {
  const side = stage.side
  const kind = stage.kind
  if (kind === 'speech') {
    return [{ side, role: 'speaker', seat: stage.seat ?? null, share: 1 }]
  }
  const exchanges = Math.max(1, Math.min(12, Number(stage.exchanges) || 4))
  if (kind === 'cross' || kind === 'inquiry') {
    const turns = []
    const examinerTurns = Math.ceil(exchanges / 2)
    let examinerCount = 0
    for (let i = 0; i < exchanges; i += 1) {
      const isExaminer = i % 2 === 0
      if (isExaminer) examinerCount += 1
      turns.push({
        side: isExaminer ? side : opposite(side),
        role: isExaminer ? (kind === 'inquiry' ? 'examiner' : 'examiner') : 'responder',
        seat: isExaminer ? (stage.seat ?? null) : null,
        share: isExaminer ? 1 / examinerTurns : 0,
      })
    }
    return turns
  }
  // dialogue / free：双方交替，各自计时
  const perSideTurns = Math.ceil(exchanges / 2)
  const turns = []
  const first = stage.first === 'con' ? 'con' : 'pro'
  for (let i = 0; i < exchanges; i += 1) {
    const turnSide = i % 2 === 0 ? first : opposite(first)
    turns.push({
      side: turnSide,
      role: kind === 'free' ? 'free' : 'speaker',
      seat: seatForDialogue(stage, turnSide),
      share: 1 / perSideTurns,
    })
  }
  return turns
}

function seatForDialogue(stage, side) {
  if (Array.isArray(stage.seats)) {
    return stage.seats[side === 'pro' ? 0 : 1] ?? null
  }
  if (typeof stage.seat === 'number') return stage.seat
  return null
}

function opposite(side) {
  return side === 'pro' ? 'con' : 'pro'
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function cleanText(value, max = 500) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function slugId(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return fallback
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback
}

/**
 * 校验并归一化自定义赛制。
 * @returns {{ok:true, flow:object[]} | {ok:false, errors:string[]}}
 */
export function validateFlow(input) {
  let raw = input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.stages
  if (!Array.isArray(raw)) return { ok: false, errors: ['赛制必须是环节数组'] }
  if (raw.length === 0) return { ok: false, errors: ['赛制至少需要 1 个环节'] }
  if (raw.length > MAX_STAGES) return { ok: false, errors: [`赛制最多 ${MAX_STAGES} 个环节`] }

  const errors = []
  const seen = new Set()
  const flow = []
  raw.forEach((item, index) => {
    const at = `第 ${index + 1} 环节`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} 必须是对象`)
      return
    }
    const title = cleanText(item.title, 60)
    if (!title) errors.push(`${at} 缺少标题 title`)
    const kind = KINDS.has(item.kind) ? item.kind : 'speech'
    if (item.kind !== undefined && !KINDS.has(item.kind)) errors.push(`${at} kind 非法（可用 speech/cross/dialogue/inquiry/free）`)
    let side = SIDES.has(item.side) ? item.side : kind === 'speech' || kind === 'cross' || kind === 'inquiry' ? 'pro' : 'both'
    if ((kind === 'dialogue' || kind === 'free') && side !== 'both') {
      side = 'both'
    }
    if (item.side !== undefined && !SIDES.has(item.side)) errors.push(`${at} side 非法（可用 pro/con/both）`)
    if ((kind === 'speech' || kind === 'cross' || kind === 'inquiry') && side === 'both') {
      errors.push(`${at} 的 side 不能为 both`)
    }
    const seconds = clampInt(item.seconds, 1, 1800, NaN)
    if (!Number.isFinite(seconds)) errors.push(`${at} seconds 必须是 1..1800 的数字`)
    const id = slugId(item.id, `stage-${index + 1}`)
    if (seen.has(id)) errors.push(`${at} id 重复：${id}`)
    seen.add(id)
    const normalized = {
      id,
      title: title || `环节 ${index + 1}`,
      kind,
      side,
      seconds: Number.isFinite(seconds) ? seconds : 180,
      description: cleanText(item.description, 500),
      rule: cleanText(item.rule, 500),
      perSide: item.perSide === true,
      singleSide: item.singleSide === true,
      canInterrupt: item.canInterrupt === true,
      respondentNoClock: item.respondentNoClock === true,
      exchanges: clampInt(item.exchanges, 1, 12, kind === 'free' ? 8 : 4),
    }
    if (normalized.perSide && normalized.singleSide) {
      errors.push(`${at} 不能同时 perSide 与 singleSide`)
    }
    if (Number.isFinite(Number(item.seat))) {
      normalized.seat = clampInt(item.seat, 1, 4, 1)
    }
    if (Number.isFinite(Number(item.targetSeat))) {
      normalized.targetSeat = clampInt(item.targetSeat, 1, 4, 1)
    }
    if (Array.isArray(item.targetExclude)) {
      normalized.targetExclude = [...new Set(item.targetExclude.map((v) => clampInt(v, 1, 4, 0)).filter((v) => v > 0))]
    }
    if (Array.isArray(item.seats)) {
      normalized.seats = [clampInt(item.seats[0], 1, 4, 4), clampInt(item.seats[1], 1, 4, 4)]
    }
    if (item.first === 'pro' || item.first === 'con') normalized.first = item.first
    else if (kind === 'dialogue' || kind === 'free') normalized.first = 'pro'
    flow.push(normalized)
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, flow }
}

/** 简化版流程：只保留正反立论 + 自由辩论，不加载完整 14 环节。 */
export function minimalFlow() {
  return [
    {
      id: 'simple-pro-opening', title: '正方一辩开篇立论', kind: 'speech', side: 'pro', seat: 1,
      seconds: 180, description: '简化流程：正方立论', rule: '先立判准，再展开核心论证。',
    },
    {
      id: 'simple-con-opening', title: '反方一辩开篇立论', kind: 'speech', side: 'con', seat: 1,
      seconds: 180, description: '简化流程：反方立论', rule: '回应正方判准，建立本方论证。',
    },
    {
      id: 'simple-free', title: '自由辩论', kind: 'free', side: 'both', seconds: 120,
      perSide: true, first: 'pro', exchanges: 6, description: '简化流程：双方各 2 分钟自由辩论',
      rule: '短问短答，回应对方上一句。',
    },
  ]
}
