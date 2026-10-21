/**
 * 智能体模拟器（契约：docs/CONTRACT.md §2.3）。
 *
 * 能力：
 * - createRoster()        花名册（人设/头像/颜色）
 * - createSimulator(opts) discuss / speak / judge / coach / adminComment
 * - buildContext()        demo 与 AI 共用同一份权限上下文
 * - assertIsolation()     越权即 throw
 *
 * 设计原则：
 * 1. 所有方法 async 且**尊重 signal**：外部取消立刻抛 AbortError；
 *    超时属于内部失败，回退 demo，不抛。
 * 2. AI 模式调用 ctx.llm.stream（provider/model 来自 agentDefaultModel），
 *    任何失败（无 llm、无模型、超时、解析失败）都自动回退 demo，绝不把异常抛给引擎。
 * 3. demo 模式产出可信中文辩论文本：立论/质询/小结/自由辩论/总结各有模板，
 *    引用辩题与对方上一句关键词，长度 120-300 字。
 */

import { assertNotAborted, abortError, createLlmRunner, DEFAULT_LLM_TIMEOUT_MS } from './llm.js'
import { buildContext, assertIsolation } from './contexts.js'
import { createRoster, personaPrompt } from './personas.js'

export { createRoster, buildContext, assertIsolation }

/** 默认气泡展示秒数（与 flow.js 保持一致，可被 options 覆盖）。 */
export const DEFAULT_BUBBLE_SECONDS = 10
/** demo 发言目标长度区间（字符数，按 Unicode 码点计）。 */
export const DEMO_SPEECH_MIN = 120
export const DEMO_SPEECH_MAX = 300

/** 立场中文标签。 */
export const SIDE_LABELS = { pro: '正方', con: '反方', neutral: '中立' }

const STAGE_KIND_LABELS = {
  speech: '陈词',
  cross: '质询',
  dialogue: '对辩',
  inquiry: '盘问',
  free: '自由辩论',
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function charLen(text) {
  return Array.from(String(text ?? '')).length
}

function truncateChars(text, max) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

function hashSeed(...parts) {
  const text = parts.map((part) => (part == null ? '' : String(part))).join('|')
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(list, rng) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (vars[key] == null ? match : String(vars[key])))
}

function shortTopic(topic, max = 26) {
  const text = normalizeString(topic) || '本场辩题'
  return charLen(text) <= max ? text : truncateChars(text, max)
}

/** 截断到句末（尽量不切半句）。 */
function cutTo(text, max) {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const slice = chars.slice(0, max).join('')
  const lastStop = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
  )
  if (lastStop >= Math.floor(max * 0.55)) return slice.slice(0, lastStop + 1)
  return `${chars.slice(0, max - 1).join('')}。`
}

const PAD_SENTENCES = [
  '这一点我方在后面还会具体展开。',
  '请评委注意，这个判断有可核查的依据，而不是修辞。',
  '对方若坚持相反结论，需要先回答成本由谁承担。',
  '我方愿意接受任何可检验的追问。',
  '把这一层说清楚，后面的比较才有意义。',
  '这也是我方判准与对方判准的真正分歧。',
]

function padTo(text, min, max) {
  let out = text
  let index = 0
  while (charLen(out) < min && index < PAD_SENTENCES.length) {
    out = `${out.replace(/[。！？；]?$/, '。')}${PAD_SENTENCES[index]}`
    index += 1
  }
  return charLen(out) > max ? cutTo(out, max) : out
}

/** 收敛到 [min,max] 字，保证 demo 文本长度稳定。 */
function fitDemoText(text, min = DEMO_SPEECH_MIN, max = DEMO_SPEECH_MAX) {
  let out = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/。{2,}/g, '。')
    .replace(/，{2,}/g, '，')
    .trim()
  if (!out) out = ''
  if (charLen(out) > max) out = cutTo(out, max)
  if (charLen(out) < min) out = padTo(out, min, max)
  return out
}

/* ------------------------------------------------------------------ *
 * demo 文本：关键词、模板
 * ------------------------------------------------------------------ */

function keywordOf(line, max = 16) {
  const text = String(line ?? '')
    .replace(/[「」『』“”"]/g, '')
    .trim()
  if (!text) return ''
  const clauses = text
    .split(/[，。；！？、,.;!?：:]/)
    .map((clause) => clause.trim())
    .filter((clause) => charLen(clause) >= 6)
  if (clauses.length === 0) return truncateChars(text, max)
  let best = clauses[0]
  let bestScore = -1
  for (const clause of clauses) {
    let score = charLen(clause)
    if (/[0-9]/.test(clause)) score += 4
    if (/(但是|因此|所以|其实|问题|关键|必须|不能|意味着)/.test(clause)) score += 3
    if (score > bestScore) {
      bestScore = score
      best = clause
    }
  }
  return truncateChars(best, max)
}

/** 取对方最后一句（找不到就返回空串）。 */
function lastOpponentLine(transcript, side, speakerId) {
  if (!Array.isArray(transcript)) return ''
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const item = transcript[i]
    if (!item || typeof item !== 'object') continue
    const text = normalizeString(item.text)
    if (!text) continue
    if (speakerId && item.speakerId === speakerId) continue
    const itemSide = normalizeString(item.side)
    if (itemSide && side && itemSide === side) continue
    return text
  }
  return ''
}

function opponentPhrase(transcript, side, speakerId) {
  const line = lastOpponentLine(transcript, side, speakerId)
  const keyword = keywordOf(line)
  return keyword ? `“${keyword}”` : '对方此前的概括'
}

const STYLE_FLAVOR = {
  logic: '按逻辑一致性检验，对方的推论在第二步就滑开了：它把「可能性」当成了「必然性」。',
  data: '按同一口径核对，对方引用的只是单一场景，而我方的判断覆盖了更长的时间窗口。',
  attack: '我不接受绕答：请对方用一句话回答「是」或「不是」。',
  value: '别把讨论停在数字上——数字背后是具体的人会不会被落下。',
}

const STYLE_OPENING = {
  logic: '从逻辑上看，对方的质疑预设了一个未经证明的前提：必须先证明“{t}”有害，才轮到举证责任转移。',
  data: '把口径说清楚：“{t}”的相关指标要看三年以上的趋势，而不是单点个案。',
  attack: '我方先把争点收窄成三问：成本谁承担、收益谁享有、失败谁退出。',
  value: '把镜头拉远一点：“{t}”最终塑造的是我们彼此托付的方式，而不只是一次得失。',
}

const OPENING_HEAD = [
  '谢谢主席，各位评委好。我方立场是{side}，即{stance}“{t}”所指向的方向。',
  '谢谢主席。开宗明义，我方认为判断“{t}”的关键不在于表态，而在于可检验的后果。',
  '谢谢主席。围绕“{t}”，我方先给出定义与判准，再给出三条论证。',
]

const OPENING_BODY = [
  '第一，事实层面，“{t}”带来的收益是可观察的：它降低了信息不对称，也让责任更可追溯。',
  '第二，制度层面，“{t}”要求明确边界与退出机制，否则成本会被转嫁给最弱的一方。',
  '第三，比较层面，替代方案的成本更高、可预期性更差，无法回应同一组问题。',
  '我方判准是：能否在长期内稳定改善多数人的处境；按此判准，“{t}”成立。',
]

const CROSS_QUESTIONS = [
  '第一，你方是否承认“{t}”在当前条件下已经具备可行性？',
  '第二，如果成本超出预期，你方的退出机制是什么？',
  '第三，你方如何解释与我方判断相反的那部分事实？',
]

const INQUIRY_QUESTIONS = [
  '第一，你方是否承认“{t}”存在执行成本？',
  '第二，这部分成本由谁承担，你方有没有写进方案？',
  '第三，如果三年内看不到效果，你方是否愿意中止？',
]

const SUMMARY_LINES = [
  '小结本环节。刚才的交锋留下三点：其一，对方承认了执行成本的存在；其二，对方在“{t}”的判准上前后不一；其三，我方已说明制度边界可以控制风险。',
  '对方反复回到{opp}，但这一点恰恰说明问题在执行，而不是方向。',
  '因此，本环节的收获应当计入我方论证：{side}的立场经得起追问。',
]

const FREE_LINES = [
  '回应对方刚才说的{opp}。第一，这一说法把「执行风险」偷换成了「方向错误」；第二，即便按对方口径，我方关于成本可控的判断仍然成立。',
  '第三，我方反问：如果因为可能失败就完全不推进，那么任何改进都无法开始。',
  '请对方下一轮正面回答，而不是继续举例。',
]

const DIALOGUE_LINES = [
  '我回应对方：{opp}这一点我方接受一半——风险确实存在，但它恰恰是制度设计的理由，而不是放弃的理由。',
  '对方举的例子只覆盖单一场景，无法支撑普遍结论；我方给出的是可复用的规则。',
  '请对方回答：在同样的成本约束下，你方的替代方案如何避免把风险转嫁给最弱的一方？',
]

const CLOSING_LINES = [
  '谢谢主席。整场比赛的争点已经清晰：对方始终围绕{opp}展开，却始终没有回答“{t}”的成本由谁承担、失败如何退出。',
  '我方从事实与制度两个层面完成论证，并在质询中取得对方关于成本分摊的承认。',
  '比较双方判准：我方标准可检验、可执行、成本可控；对方标准则依赖假设性的极端情形。',
  '请评委按判准投票。我方坚持{side}。',
]

/** 环节画像：把 stage 归到 立论/质询/盘问/小结/自由辩论/对辩/总结。 */
export function stageProfile(stage) {
  const kind = normalizeString(stage?.kind) || 'speech'
  const text = `${normalizeString(stage?.id)} ${normalizeString(stage?.title)}`
  if (/(closing|结辩|总结陈词|总结发言)/.test(text)) return 'closing'
  if (/小结/.test(text)) return 'summary'
  if (kind === 'cross') return 'cross'
  if (kind === 'inquiry') return 'inquiry'
  if (kind === 'free') return 'free'
  if (kind === 'dialogue') return 'dialogue'
  return 'opening'
}

/** 本回合该辩手是质询/盘问方还是答辩方。 */
function isExaminerTurn(stage, side) {
  const kind = normalizeString(stage?.kind)
  if (kind !== 'cross' && kind !== 'inquiry') return false
  const examinerSide = normalizeString(stage?.side)
  if (examinerSide === 'pro' || examinerSide === 'con') return examinerSide === side
  return true
}

function demoSpeech({ topic, round, stage, speaker, side, transcript }) {
  const profile = stageProfile(stage)
  const t = shortTopic(topic)
  const sideValue = side === 'con' ? 'con' : 'pro'
  const sideLabel = SIDE_LABELS[sideValue]
  const stance = sideValue === 'pro' ? '支持' : '反对'
  const opp = opponentPhrase(transcript, sideValue, speaker?.id)
  const style = normalizeString(speaker?.style) || 'logic'
  const styleFlavor = STYLE_FLAVOR[style] ?? STYLE_FLAVOR.logic
  const rng = makeRng(
    hashSeed(topic, round, stage?.id ?? stage?.title, speaker?.id, sideValue, Array.isArray(transcript) ? transcript.length : 0),
  )
  const vars = { t, side: sideLabel, stance, opp }

  let text = ''
  if (profile === 'opening') {
    text = [
      fill(pick(OPENING_HEAD, rng), vars),
      fill(STYLE_OPENING[style] ?? STYLE_OPENING.logic, vars),
      fill(OPENING_BODY[0], vars),
      fill(OPENING_BODY[1], vars),
      sideValue === 'pro' ? fill('对方可能会用个别反例否定整体，但个别反例推翻不了可复现的趋势。', vars) : fill('对方可能会强调“{t}”的短期收益，但短期收益无法覆盖长期成本。', vars),
      fill('综上，我方坚持{side}立场。', vars),
    ].join('')
  } else if (profile === 'closing') {
    text = [
      fill(CLOSING_LINES[0], vars),
      fill(CLOSING_LINES[1], vars),
      fill(CLOSING_LINES[2], vars),
      styleFlavor,
      fill(CLOSING_LINES[3], vars),
    ].join('')
  } else if (profile === 'summary') {
    text = [
      fill(SUMMARY_LINES[0], vars),
      fill(SUMMARY_LINES[1], vars),
      styleFlavor,
      fill(SUMMARY_LINES[2], vars),
    ].join('')
  } else if (profile === 'cross') {
    const examiner = isExaminerTurn(stage, sideValue)
    if (examiner) {
      text = [
        '我方连续设问，请对方正面回答，不要绕开。',
        fill(CROSS_QUESTIONS[0], vars),
        fill(CROSS_QUESTIONS[1], vars),
        fill(CROSS_QUESTIONS[2], vars),
        fill('对方的回答其实已经承认了{opp}，那么由此应当推出：问题在执行，而不在方向。', vars),
        '请对方明确：是承认这一推论，还是收回前面的表述？',
      ].join('')
    } else {
      text = [
        fill('我直接回答。第一问，“{t}”的可行性有条件，但条件可以通过制度设计满足；第二问，退出机制我方已经给出，只是对方没有听见。', vars),
        fill('对方把我方观点概括为{opp}，这是误读：我方从未主张走极端，而是主张有边界、可回退的推进。', vars),
        fill('请对方回到论证本身，而不是用假设性的极端情形替代论证。', vars),
        styleFlavor,
      ].join('')
    }
  } else if (profile === 'inquiry') {
    const examiner = isExaminerTurn(stage, sideValue)
    if (examiner) {
      text = [
        '盘问开始，请对方只作答，不要反问。',
        fill(INQUIRY_QUESTIONS[0], vars),
        fill(INQUIRY_QUESTIONS[1], vars),
        fill('谢谢，对方的回答确认了{opp}这一事实，我方记录在案。', vars),
        fill(INQUIRY_QUESTIONS[2], vars),
      ].join('')
    } else {
      text = [
        fill('我按问题顺序回答。第一，成本确实存在，但我方给出了分摊机制；第二，承担主体是受益方与公共财政共同分担。', vars),
        fill('对方把“有成本”直接等同于“不可行”，这是跳跃；任何公共安排都有成本，关键是成本是否可控、是否透明。', vars),
        fill('第三问，我方愿意设置阶段性评估与中止条款，这正是我方方案的一部分。', vars),
        styleFlavor,
      ].join('')
    }
  } else if (profile === 'free') {
    text = [
      fill(FREE_LINES[0], vars),
      fill(FREE_LINES[1], vars),
      styleFlavor,
      fill(FREE_LINES[2], vars),
    ].join('')
  } else if (profile === 'dialogue') {
    text = [
      fill(DIALOGUE_LINES[0], vars),
      fill(DIALOGUE_LINES[1], vars),
      styleFlavor,
      fill(DIALOGUE_LINES[2], vars),
    ].join('')
  } else {
    text = [
      fill(pick(OPENING_HEAD, rng), vars),
      fill(STYLE_OPENING[style] ?? STYLE_OPENING.logic, vars),
      fill(OPENING_BODY[2], vars),
      fill(OPENING_BODY[3], vars),
      fill('综上，我方坚持{side}立场。', vars),
    ].join('')
  }
  return fitDemoText(text)
}

const DISCUSS_LAYER_LINES = [
  '事实层，分析材料里的{mat}可以直接用，重点是统一口径，不要给对方留下“样本可疑”的突破口。',
  '制度层，要写清责任主体与退出机制，否则对方一定会抓住“出了事没人负责”。',
  '价值层，要回答我们想要怎样的公共生活，而不是只算一笔账。',
]

function demoDiscussTurn({ topic, side, agent, materials, index }) {
  const t = shortTopic(topic)
  const sideLabel = SIDE_LABELS[side === 'con' ? 'con' : 'pro']
  const material = Array.isArray(materials) && materials[index % Math.max(1, materials.length)]
  const matName = typeof material === 'string' ? `材料${index + 1}` : material?.name || '分析材料'
  const layer = fill(DISCUSS_LAYER_LINES[index % DISCUSS_LAYER_LINES.length], { mat: matName })
  const head = index === 0
    ? `我方先把讨论落到框架上：“${t}”的争点可以拆成事实、制度、价值三层。`
    : `接着刚才的思路，我方补一层：${sideLabel}的论证要能经得住对方的连续追问。`
  const tail = index === 0
    ? '分工上，一辩搭框架，二辩准备数据与反例，三辩设计质询链，四辩准备收束句。'
    : '建议把这一层写进草稿纸，下一环节直接调用。'
  return fitDemoText(`${head}${layer}${tail}`, 120, 240)
}

function demoDiscussSummary({ topic, side, turns, materials }) {
  const t = shortTopic(topic)
  const sideLabel = SIDE_LABELS[side === 'con' ? 'con' : 'pro']
  const material = Array.isArray(materials) && materials[0]
  const matName = typeof material === 'string' ? '分析材料' : material?.name || '分析材料'
  return fitDemoText(
    `讨论小结（${sideLabel}）：${turns} 位辩手围绕“${t}”交换了意见，形成的共识是——先立判准、再展开论据，避免在定义上被对方牵走。` +
      `仍存分歧的是制度成本的承担方式，需要在下一次准备中定稿。下一步按分工进入立论与质询准备，重点打磨《${matName}》的引用口径。`,
    120,
    260,
  )
}

function clampScore(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value))))
}

function toScore(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return clampScore(value)
  const match = String(value).match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  return clampScore(Number(match[0]))
}

function demoJudge({ topic, round, stage, transcript }) {
  const t = shortTopic(topic)
  const stageTitle = normalizeString(stage?.title) || '本环节'
  const rng = makeRng(hashSeed(topic, round, stage?.id ?? stageTitle, 'judge', Array.isArray(transcript) ? transcript.length : 0))
  const base = 74 + Math.floor(rng() * 9)
  let pro = clampScore(base + Math.floor(rng() * 11))
  let con = clampScore(base + Math.floor(rng() * 11))
  if (pro === con) con = clampScore(con + 2)
  const proPoint = pick(['定义与判准', '数据与案例', '质询链设计', '结辩收束'], rng)
  const conPoint = pick(['反问与归谬', '成本追问', '定义拆解', '价值升维'], rng)
  const issue = pick(
    [
      '双方在成本分摊的最后一问上都没有收束',
      '自由辩论阶段重复论据偏多，交锋效率还有空间',
      '两边都缺少对对方最强论点的正面回应',
    ],
    rng,
  )
  const comment = `本轮${stageTitle}：正方在${proPoint}上更完整，反方在${conPoint}上更锐利，但${issue}。综合论证完整性、回应质量与节奏，给出 ${pro}:${con}。`
  const findings = [
    `正方一辩对“${t}”的定义清晰，但第二层论证缺少可核查的依据。`,
    `反方质询抓住了${opponentPhrase(transcript, 'pro', null)}，却没有把对方的承认转化为结论。`,
    issue,
  ]
  return { pro, con, comment, findings }
}

function demoCoach({ topic, round, side, transcript, judgeNotes, scoreboard }) {
  const t = shortTopic(topic)
  const sideValue = side === 'con' ? 'con' : 'pro'
  const sideLabel = SIDE_LABELS[sideValue]
  const opp = opponentPhrase(transcript, sideValue, null)
  const rng = makeRng(hashSeed(topic, round, sideValue, 'coach', Array.isArray(transcript) ? transcript.length : 0))
  const pace = pick(['偏稳', '略急', '张弛有度'], rng)
  const weak = pick(
    [
      '三辩的质询链只走了两步就收束，四辩的总结没有回到开场判准',
      '二辩的数据引用缺少同口径对照，被对方抓住样本范围',
      '自由辩论阶段节奏被对方带走，两个核心论据没来得及展开',
    ],
    rng,
  )
  const lastJudge = Array.isArray(judgeNotes) && judgeNotes.length > 0 ? judgeNotes[judgeNotes.length - 1] : null
  const judgeHint = lastJudge?.comment ? `评委在最近一次点评中提到「${truncateChars(lastJudge.comment, 48)}」，值得全队回看。` : ''
  const scoreHint = scoreboard && Number.isFinite(Number(scoreboard.pro)) && Number.isFinite(Number(scoreboard.con))
    ? `当前计分板为 正方 ${Number(scoreboard.pro)} : 反方 ${Number(scoreboard.con)}。`
    : ''
  const analysis =
    `表现分析：${sideLabel}本轮整体节奏${pace}。一辩把“${t}”的判准立住了，二辩的材料引用具体、口径清楚；` +
    `不足在于${weak}。对方在${opp}上的反问一度打乱我方节奏，但我方及时止损，没有让战场完全被带走。` +
    `${scoreHint}${judgeHint}`
  const suggestions = [
    '下一轮质询固定「确认—归谬—收束」三步，每个问题都指向一个对方必须承认的事实。',
    `把《${normalizeString(transcript?.[0]?.stageTitle) || '分析材料'}》里的关键数据压缩成一句可复述的话，避免在细节上失血。`,
    '结辩前留 20 秒回到开场判准，明确告诉评委「按这个标准我方赢在哪里」。',
  ]
  const text = `${analysis}\n\n改进建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
  return { text, analysis }
}

function demoAdminComment({ topic, round, stage, issues }) {
  const t = shortTopic(topic)
  const stageTitle = normalizeString(stage?.title) || '本环节'
  const rng = makeRng(hashSeed(topic, round, stageTitle, 'admin', Array.isArray(issues) ? issues.length : 0))
  const order = pick(['发言顺序与计时正常', '双方交替顺畅，未出现抢话', '节奏偏快，个别环节压哨'], rng)
  const issueText = Array.isArray(issues) && issues.length > 0
    ? `已记录问题：${issues.map((item) => (typeof item === 'string' ? item : normalizeString(item?.text))).filter(Boolean).slice(0, 3).join('；')}。`
    : '本轮无规则争议。'
  return fitDemoText(
    `第 ${round} 轮${stageTitle}结束。流程按赛制推进，${order}；${issueText}` +
      `围绕“${t}”的交锋密度不错，但单次发言偏长。建议下一轮控制单次发言长度，把时间留给正面交锋，并在环节结束前 10 秒给出收束提示。`,
    80,
    220,
  )
}

/* ------------------------------------------------------------------ *
 * AI 提示词
 * ------------------------------------------------------------------ */

function sideLabelOf(side) {
  return side === 'con' ? '反方' : side === 'pro' ? '正方' : '中立'
}

function stageLabel(stage) {
  const title = normalizeString(stage?.title) || '本环节'
  const kind = normalizeString(stage?.kind) || 'speech'
  return `${title}（${STAGE_KIND_LABELS[kind] ?? kind}）`
}

function formatTranscript(transcript, { limit = 12, perLine = 180 } = {}) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '（暂无发言）'
  const list = transcript.slice(-limit)
  const lines = []
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const text = truncateChars(normalizeString(item.text), perLine)
    if (!text) return
    const who = normalizeString(item.speakerName) || normalizeString(item.speakerId) || '发言者'
    const side = item.side === 'pro' ? '正方' : item.side === 'con' ? '反方' : '中立'
    const stageName = normalizeString(item.stageTitle) ? `[${normalizeString(item.stageTitle)}] ` : ''
    lines.push(`${index + 1}. ${stageName}${who}（${side}）：${text}`)
  })
  return lines.join('\n') || '（暂无发言）'
}

function formatMaterials(materials) {
  if (!Array.isArray(materials) || materials.length === 0) return '（无）'
  return materials
    .slice(0, 3)
    .map((item, index) => {
      if (typeof item === 'string') return `材料${index + 1}：${truncateChars(item, 400)}`
      const name = normalizeString(item?.name) || `材料${index + 1}`
      return `《${name}》：${truncateChars(normalizeString(item?.text), 400)}`
    })
    .join('\n')
}

function formatScoreboard(scoreboard) {
  if (!scoreboard || typeof scoreboard !== 'object') return '（暂无）'
  const pro = Number(scoreboard.pro) || 0
  const con = Number(scoreboard.con) || 0
  const history = Array.isArray(scoreboard.history) ? scoreboard.history.slice(-3) : []
  const lines = history.map(
    (item) => `- 第${item.round ?? '?'}轮 ${item.stageTitle ?? item.stageIndex ?? ''}：${item.pro ?? 0}:${item.con ?? 0}${item.comment ? `（${truncateChars(item.comment, 60)}）` : ''}`,
  )
  return `当前 正方 ${pro} : 反方 ${con}${lines.length ? `\n最近记录：\n${lines.join('\n')}` : ''}`
}

function formatJudgeNotes(judgeNotes) {
  if (!Array.isArray(judgeNotes) || judgeNotes.length === 0) return '（本轮暂无评委记录）'
  return judgeNotes
    .slice(-3)
    .map(
      (item, index) =>
        `${index + 1}. ${normalizeString(item?.judgeName) || '评委'}：${Number(item?.pro) || 0}:${Number(item?.con) || 0} ${truncateChars(normalizeString(item?.comment), 80)}`,
    )
    .join('\n')
}

const SPEAK_TASKS = {
  opening: '用你自己的方式开场（学理型先钉判准，数据型先抛一个数，攻防型先抛一个对方必须回答的问题，价值型先讲一个具体场景），把框架讲清楚；不要报“第一第二第三”的提纲。',
  cross: '你现在质询。只问不答，每问不超过 35 字，抓住对方刚才回答里的一个漏洞连续追问；不要发表评论、不要自问自答。',
  crossAnswer: '你被质询。只答不问，每次 1-2 句：先直接回答，再补一句理由；不要反问，不要展开成陈词。',
  inquiry: '你现在盘问。连续短问，逼对方给出具体承认；对方答完立刻追下一问，不要停下来讲道理。',
  inquiryAnswer: '你被盘问。只答不问：能承认的就承认，不能让的用一句话守住，不要反问。',
  summary: '小结刚才这一轮：对方承认了什么、哪里前后不一致，然后一句话收回本方论证；不要开新论点。',
  free: '自由辩论：只回应对方刚才那一句，1-2 句，短、快，可以带一个反问；不要重复立论。',
  dialogue: '对辩：先用一句话接住对方刚才的观点，再推进我方比较；不要复述定义。',
  closing: '总结陈词：别再开新战场；用 2-3 个全场交锋点说明按这个判准为什么我方赢，可以引用对方原话。',
}

const DRAFT_ETIQUETTE = [
  '【辩论礼仪与格式】',
  '1. 开头先称呼：“谢谢主席，各位评委、对方辩友，大家好。”',
  '2. 全程用“我方/对方辩友”，不嘲讽、不人身攻击、不打断评委。',
  '3. 结构完整：亮明立场 → 逐个澄清关键词定义 → 给出判准 → 2-3 点论证（每点先给结论句，再展开机制/数据/案例）→ 预判对方最强质疑并正面回应 → 重申立场。',
  '4. 论据要具体：有机制、有比较、有数据口径；没有把握的具体数字不要编造，改用“公开资料显示的总体趋势”。',
  '5. 结尾用“因此我方坚信……”收束，并做一句价值升华。',
  '6. 口语化但正式，层次清楚，不用 markdown、不用小标题符号。',
  '【立论方法论（超级辩手）】',
  '7. 立论是“形成说服力的最小单元”；定义不是查词典，而是争夺题目的解释权，必须公正客观、符合日常用语、与论点契合。',
  '8. 一辩稿至少用约 1/3 的篇幅铺前提：把关键词、比较对象、讨论边界先钉死，再展开论点；不要一上来堆论点。',
  '9. 事实不可辩、价值可辨：把看似的事实争议还原为定义选择与价值判断；判准要能回答“按什么标准比较”。',
].join('\n')

const STYLE_OPENING_CUE = {
  logic: '先用一句话把判准钉死，再展开。',
  data: '先抛一个数字、样本或对照，让全场先记住这个数。',
  attack: '先抛一个对方必须回答、又很难回答的问题。',
  value: '先讲一个具体的人或场景，再抬到价值判断。',
}

function speakTask(profile, stage, side) {
  if (profile === 'cross') return isExaminerTurn(stage, side) ? SPEAK_TASKS.cross : SPEAK_TASKS.crossAnswer
  if (profile === 'inquiry') return isExaminerTurn(stage, side) ? SPEAK_TASKS.inquiry : SPEAK_TASKS.inquiryAnswer
  return SPEAK_TASKS[profile] ?? SPEAK_TASKS.opening
}

function lastOtherSideLine(transcript, side) {
  if (!Array.isArray(transcript)) return null
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index]
    if (!item || typeof item !== 'object') continue
    if (normalizeString(item.stageTitle) === '讨论阶段') continue
    if (item.side === side) continue
    const text = normalizeString(item.text)
    if (text) return { who: normalizeString(item.speakerName) || '对方辩手', text }
  }
  return null
}

function lastOwnLines(transcript, side, limit = 2) {
  if (!Array.isArray(transcript)) return []
  const out = []
  for (let index = transcript.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const item = transcript[index]
    if (!item || item.side !== side) continue
    if (normalizeString(item.stageTitle) === '讨论阶段') continue
    const text = normalizeString(item.text)
    if (text) out.push(`${normalizeString(item.speakerName) || '我方辩手'}：${truncateChars(text, 90)}`)
  }
  return out.reverse()
}

function speakSystem(agent, extra) {
  return [
    personaPrompt(agent),
    '这是中文辩论赛现场。你只能依据下面给你的信息，不要编造没给你的资料。',
    '铁律：只输出你开口说出来的话。不要写思考过程、分析、提纲、战术安排、旁白或舞台提示；不要出现“我方应该”“接下来”“建议”“我的策略是”这类没出口的内容。',
    '像真人一样说话：可以有短句、停顿、反问、打断；不要套“首先/其次/最后”，不要 markdown、标题或引号。',
    '长度：陈词 120-300 字；质询、自由辩论、对辩更短，1-3 句就够。',
    extra ? `补充要求：${extra}` : '',
  ].filter(Boolean).join('\n')
}

function speakPrompt({ context, profile, stage, side, thought }) {
  const agent = context.agent
  const stageTitle = normalizeString(stage?.title) || '本环节'
  const opponent = lastOtherSideLine(context.transcript, side)
  const own = lastOwnLines(context.transcript, side)
  const isOpening = profile === 'opening'
  const task = speakTask(profile, stage, side)
  const showDraft = Boolean(context.draft)
  return [
    `【辩题】${context.topic || '（未提供）'}`,
    `【轮次】第 ${context.round} 轮`,
    `【环节】${stageLabel(stage)}`,
    `【环节规则】${normalizeString(stage?.rule) || normalizeString(stage?.description) || '按赛制常规要求发言。'}`,
    `【你是谁】${agent.name}（${sideLabelOf(side)}${agent.seat ? `${agent.seat}辩` : ''}）`,
    `【本回合任务】${task}`,
    isOpening
      ? '【现场情况】这是你的开场，没有对方发言可回应，直接对本方立场开口。'
      : opponent
        ? `【对方刚才的原话】${opponent.who}：“${truncateChars(opponent.text, 220)}”`
        : '【现场情况】对方还没有形成有效发言，按本方节奏开口。',
    thought ? `【你刚才在心里想】${truncateChars(thought, 120)}（不要把它念出来，按这个判断直接说话）` : '',
    own.length ? `【你方最近说过】\n${own.join('\n')}` : '',
    showDraft ? `【本方预写稿（讨论时已写好，可按现场调整，不要逐字念）】\n${truncateChars(context.draft, 2400)}` : '',
    '现在直接给出台词。不要解释你为什么这么说：',
  ].filter(Boolean).join('\n')
}

function thinkSystem(agent) {
  return [
    personaPrompt(agent),
    '现在你还没开口。先用 1-2 句在心里过一遍：对方最强的一点是什么、你这一轮先打哪里、什么可以让、什么绝不能让。',
    '只输出内心的判断，不要写成发言，不要称呼评委，不要展开论证。最多 60 字。',
  ].join('\n')
}

function thinkPrompt({ topic, stage, side, transcript, draft }) {
  const opponent = lastOtherSideLine(transcript, side)
  return [
    `【辩题】${normalizeString(topic) || '（未提供）'}`,
    `【环节】${stageLabel(stage)}`,
    `【对方刚才】${opponent ? `${opponent.who}：“${truncateChars(opponent.text, 160)}”` : '（还没有有效发言）'}`,
    draft ? `【本方草稿】${truncateChars(draft, 400)}` : '',
    '你心里怎么判断？只写 1-2 句：',
  ].filter(Boolean).join('\n')
}

function demoThought({ stage, side, topic }) {
  const t = shortTopic(topic)
  const profile = stageProfile(stage)
  if (profile === 'cross') return `先别急着讲道理：逼${side === 'pro' ? '反方' : '正方'}把刚才那个成本问题说清楚，他一旦承认可控，后面就好打了。`
  if (profile === 'inquiry') return '抓住他回答里的“看情况”，追问到底谁负责；承认可以，但不能让他把责任推给制度。'
  if (profile === 'free') return '只打他刚才那句“相关不等于因果”，用一句反问逼他给替代解释，不换战场。'
  if (profile === 'closing') return `回到“${t}”的判准：把对方让过的两步串起来，别开新点。`
  return `先把“${t}”的判准立住，再抛一个对方不好接的问题；不跟他纠缠定义细节。`
}

function judgeSystem(extra) {
  return [
    '你是这场中文辩论赛的评委。你不是打分机器。',
    '先抓住这一轮最关键的 1-2 次交锋，引用一句原话；再解释为什么这个环节分给这边。不要用“论证完整、语言流畅”这种放之四海而皆准的空话。',
    '分数是全场尺度（0..100 的绝对分），不是每轮从零开始；双方可以同高同低，但要对得起场上的表现。',
    '只输出一个 JSON 对象，不要 markdown 代码块、不要额外解释：',
    '{"pro": 整数, "con": 整数, "comment": "40-120 字，必须引用原话并点明一次具体交锋", "findings": ["要点1", "要点2"]}',
    extra ? `补充要求：${extra}` : '',
  ].filter(Boolean).join('\n')
}

function judgePrompt({ topic, round, stage, transcript, scoreboard }) {
  return [
    `【辩题】${normalizeString(topic) || '（未提供）'}`,
    `【轮次】第 ${clampInt(round, 1, 99, 1)} 轮`,
    `【环节】${stageLabel(stage)}`,
    `【当前计分板】${formatScoreboard(scoreboard)}`,
    `【交锋记录】\n${formatTranscript(transcript, { limit: 14, perLine: 200 })}`,
    '请像现场评委一样点评并给分（只输出 JSON）：',
  ].join('\n')
}

function coachSystem(side, extra) {
  return [
    `你是${sideLabelOf(side)}教练。赛后你把队员叫到身边，不是念报告。`,
    '先点出这一轮最疼的一个瞬间（引用一句原话），再给 3 条下一场马上能用的建议。用“你们”“你”说话，护短但不护错。',
    '不要代替辩手发言，也不要替评委打分；可以引用评委的分数作为参照。',
    '输出：先一段「表现分析」，再一段「改进建议」（3 条，编号列出）。',
    extra ? `补充要求：${extra}` : '',
  ].filter(Boolean).join('\n')
}

function coachPrompt({ topic, side, round, transcript, judgeNotes, scoreboard, priorRounds }) {
  const prior = Array.isArray(priorRounds) && priorRounds.length > 0
    ? priorRounds.slice(-2).map((item) => `- 第${item?.round ?? '?'}轮：正方 ${item?.scores?.pro ?? '-'} : 反方 ${item?.scores?.con ?? '-'}`).join('\n')
    : '（无历史轮次）'
  return [
    `【辩题】${normalizeString(topic) || '（未提供）'}`,
    `【本方】${sideLabelOf(side)}`,
    `【轮次】第 ${clampInt(round, 1, 99, 1)} 轮`,
    `【计分板】${formatScoreboard(scoreboard)}`,
    `【历史轮次】\n${prior}`,
    `【评委记录】\n${formatJudgeNotes(judgeNotes)}`,
    `【交锋记录】\n${formatTranscript(transcript, { limit: 16, perLine: 200 })}`,
    '请以教练身份完成本轮复盘：',
  ].join('\n')
}

function adminSystem() {
  return [
    '你是本场辩论的主席/管理员。',
    '你只负责流程、计时与纪律：点评节奏、规则执行与场上秩序；不评价论证优劣、不给分。',
    '语气沉稳、简洁，像真的主席在场上说话，80-160 字。',
  ].join('\n')
}

function adminPrompt({ topic, round, stage, scoreboard, transcript, issues }) {
  const issueText = Array.isArray(issues) && issues.length > 0
    ? issues.map((item) => (typeof item === 'string' ? item : normalizeString(item?.text))).filter(Boolean).slice(0, 5).join('；')
    : '（无）'
  return [
    `【辩题】${normalizeString(topic) || '（未提供）'}`,
    `【轮次】第 ${clampInt(round, 1, 99, 1)} 轮`,
    `【当前环节】${stageLabel(stage)}`,
    `【计分板】${formatScoreboard(scoreboard)}`,
    `【问题记录】${issueText}`,
    `【最近交锋】\n${formatTranscript(transcript, { limit: 8, perLine: 140 })}`,
    '请写一段本轮流程点评：',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * AI 输出清理与解析
 * ------------------------------------------------------------------ */

function cleanAiText(text, max = 600) {  let out = String(text ?? '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim()
  out = out.replace(/^[“"']+|[”"']+$/g, '').trim()
  out = out.replace(/^(发言|回答|我的发言|辩手发言)[:：]\s*/u, '').trim()
  return charLen(out) > max ? cutTo(out, max) : out
}

function extractDraftSection(draft, label) {
  if (typeof draft !== 'string' || !draft) return ''
  const marker = `【${label}】`
  const index = draft.indexOf(marker)
  if (index < 0) return ''
  const rest = draft.slice(index + marker.length)
  const next = rest.indexOf('\n【')
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

function extractJsonObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function parseJudgeOutput(text) {
  const value = extractJsonObject(text)
  if (!value || typeof value !== 'object') return null
  const pro = toScore(value.pro ?? value.proScore ?? value['正方'] ?? value.正方)
  const con = toScore(value.con ?? value.conScore ?? value['反方'] ?? value.反方)
  if (pro == null && con == null) return null
  const comment = normalizeString(value.comment ?? value['点评'] ?? value['评语'] ?? value['短评'])
  const findingsRaw = value.findings ?? value['发现'] ?? value['要点'] ?? value['问题']
  const findings = Array.isArray(findingsRaw)
    ? findingsRaw.map((item) => normalizeString(typeof item === 'string' ? item : item?.text)).filter(Boolean).slice(0, 5)
    : []
  return {
    pro: pro ?? con ?? 75,
    con: con ?? pro ?? 75,
    comment: comment || `本轮评分：正方 ${pro ?? 75} 分，反方 ${con ?? 75} 分。`,
    findings,
  }
}

function coachSuggestions({ topic, transcript }) {
  const t = shortTopic(topic)
  return [
    `下一轮质询固定「确认—归谬—收束」三步，把“${t}”的争点收窄到一个必须回答的问题。`,
    '把本方数据压缩成一句可复述的话，并准备同口径的对照，避免被对方抓住样本范围。',
    '结辩前留 20 秒回到开场判准，明确告诉评委「按这个标准我方赢在哪里」。',
  ]
}

function splitCoachText(text) {
  const idx = text.search(/改进建议|教练建议|建议[:：]/)
  if (idx > 0) {
    const analysis = text.slice(0, idx).replace(/[：:]\s*$/, '').trim()
    return { analysis: analysis || text.trim(), rest: text.slice(idx).trim() }
  }
  return { analysis: text.trim(), rest: '' }
}

/* ------------------------------------------------------------------ *
 * createSimulator
 * ------------------------------------------------------------------ */

async function customComplete({ baseUrl, apiKey, model, system, prompt, temperature, signal }) {
  let url = String(baseUrl || '').trim()
  if (!url) throw new Error('自定义 API 地址为空')
  if (!/\/chat\/completions\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : 0.8,
    messages: [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      { role: 'user', content: String(prompt || '') },
    ],
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`自定义 API HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }
  if (!response.body) throw new Error('自定义 API 没有返回流')
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string') text += delta
      } catch {
        /* 忽略非 JSON 心跳 */
      }
    }
  }
  return text.trim()
}

/**
 * @param {{
 *   mode?: 'ai'|'demo',
 *   llm?: object|null,
 *   model?: {provider:string, model:string, reasoningEffort?:string}|null,
 *   customApi?: {baseUrl:string, apiKey:string}|null,
 *   bubbleSeconds?: number,
 *   llmTimeoutMs?: number,
 *   logger?: (...args:any[])=>void,
 * }} options
 */
export function createSimulator(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {}
  const configuredMode = opts.mode === 'demo' ? 'demo' : 'ai'
  const bubbleSeconds = clampInt(opts.bubbleSeconds, 1, 120, DEFAULT_BUBBLE_SECONDS)
  const customApi = opts.customApi && opts.customApi.baseUrl && opts.customApi.apiKey
    ? { baseUrl: String(opts.customApi.baseUrl), apiKey: String(opts.customApi.apiKey) }
    : null
  const promptExtras = opts.prompts && typeof opts.prompts === 'object' ? opts.prompts : {}
  const promptFor = (kind, id) => {
    const agents = promptExtras.agents && typeof promptExtras.agents === 'object' ? promptExtras.agents : null
    if (agents && id && typeof agents[id] === 'string' && agents[id].trim()) return agents[id].trim()
    return typeof promptExtras[kind] === 'string' ? promptExtras[kind] : ''
  }
  const runner = createLlmRunner({
    llm: opts.llm ?? null,
    model: opts.model ?? null,
    llmTimeoutMs: opts.llmTimeoutMs ?? opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    logger,
  })
  const stats = { aiCalls: 0, aiFailures: 0, demoFallbacks: 0, lastError: null }
  const huddleCursor = { pro: 0, con: 0 }
  const log = (...args) => {
    try {
      logger(...args)
    } catch {
      /* 日志失败不得中断辩论 */
    }
  }

  const aiReady = () => configuredMode === 'ai' && (Boolean(customApi) || runner.available())

  /** 调一次 AI；可用返回文本，任何内部失败返回 null（外部取消照样抛）。 */
  async function ask({ system, prompt, signal, timeoutMs, temperature }) {
    if (!aiReady()) return null
    assertNotAborted(signal)
    try {
      const text = customApi
        ? await customComplete({
          ...customApi,
          model: opts.model?.model || 'gpt-3.5-turbo',
          system,
          prompt,
          temperature,
          signal,
        })
        : await runner.complete({ system, prompt, signal, timeoutMs, temperature })
      const clean = typeof text === 'string' ? text.trim() : ''
      if (!clean) throw new Error('LLM 返回空文本')
      stats.aiCalls += 1
      return clean
    } catch (error) {
      if (signal?.aborted) throw abortError('辩论模拟已停止')
      stats.aiFailures += 1
      stats.lastError = error?.message ?? String(error)
      log('[debate-sim] AI 调用失败，回退演示模式：', stats.lastError)
      return null
    }
  }

  const simulator = {
    /** 当前模式：ai 需要 llm + 默认模型都就绪，否则 demo。 */
    mode() {
      return aiReady() ? 'ai' : 'demo'
    },

    /** 诊断信息（不进入 PublicState，仅供日志与测试）。 */
    info() {
      return {
        mode: aiReady() ? 'ai' : 'demo',
        configuredMode,
        model: runner.model,
        llmTimeoutMs: runner.timeoutMs,
        bubbleSeconds,
        stats: { ...stats },
      }
    },

    bubbleSeconds,
    llmTimeoutMs: runner.timeoutMs,

    /**
     * 讨论（开场前准备）：每方若干回合，引用分析材料。
     * 返回 { turns:[{speakerId, speakerName, side, text}], summary }
     */
    async discuss({ topic, side, agents, materials, seconds, onTurn, deadline, signal } = {}) {
      assertNotAborted(signal)
      const sideValue = side === 'con' ? 'con' : 'pro'
      const list = Array.isArray(agents) ? agents.filter(Boolean) : []
      // engine 可能传字符串（多行材料说明），统一收敛成数组。
      const materialList = Array.isArray(materials) ? materials.filter(Boolean) : materials ? [materials] : []
      if (list.length === 0) {
        return { turns: [], summary: demoDiscussSummary({ topic, side: sideValue, turns: 0, materials: materialList }) }
      }
      const limit = Math.min(list.length, clampInt(list.length, 1, 8, list.length))
      const turns = []
      // 不限制轮数：一直讨论到本方讨论时间用完（或达到安全上限）。
      const maxTurns = 500
      const until = Number.isFinite(Number(deadline)) ? Number(deadline) : Date.now() + Math.max(30, Number(seconds) || 180) * 1000
      let pass = 0
      while (turns.length < maxTurns && Date.now() < until) {
        for (let index = 0; index < limit && turns.length < maxTurns; index += 1) {
          if (Date.now() >= until) break
          assertNotAborted(signal)
          const agent = list[(index + pass) % list.length]
          const teammates = list.map((item) => `${item.name}（${item.seat || '?'}辩）`).join('、')
          const recent = turns.slice(-3)
          const aiText = await ask({
            system: [
              personaPrompt(agent),
              promptFor('debater', agent.id) ? `补充要求：${promptFor('debater', agent.id)}` : '',
              '现在是赛前队内讨论，不是上台发言。你们四个人围着一张桌子，时间紧，说话直接。',
              '这是自由讨论：可以打断、反驳队友、追问、抢话、分配任务；你仍然是在“说”，不要写思考过程、分析提纲或旁白。',
              '每次 1-3 句，像真人商量战术；不要“首先其次最后”，不要念稿，不要重复辩题定义。',
            ].join('\n'),
            prompt: [
              `【辩题】${normalizeString(topic) || '（未提供）'}`,
              `【本方】${sideLabelOf(sideValue)}`,
              `【队友】${teammates}`,
              `【分析材料】\n${formatMaterials(materialList)}`,
              recent.length
                ? `【刚才大家说】\n${recent.map((turn) => `${turn.speakerName}：${truncateChars(turn.text, 150)}`).join('\n')}`
                : '【现场】大家刚坐下，还没人开口。',
              `【你负责】你是${agent.name}，${agent.seat || '?'}辩；接着往下说，别重复自己说过的。`,
              '请直接开口，用你自己的话说：',
            ].join('\n'),
            signal,
            temperature: 0.85,
          })
          let text
          if (aiText) text = cleanAiText(aiText, 320)
          else {
            stats.demoFallbacks += 1
            text = demoDiscussTurn({ topic, side: sideValue, agent, materials: materialList, index: turns.length })
          }
          const turn = { speakerId: agent.id, speakerName: agent.name, side: sideValue, text }
          turns.push(turn)
          if (typeof onTurn === 'function') await onTurn(turn)
        }
        pass += 1
      }
      assertNotAborted(signal)
      const aiSummary = await ask({
        system: '你是辩论队的记录员，把刚才的队内讨论整理成 120-200 字的小结，写清共识、分歧和分工，不要评价优劣。',
        prompt: [
          `【辩题】${normalizeString(topic) || '（未提供）'}`,
          `【本方】${sideLabelOf(sideValue)}`,
          `【讨论记录】\n${turns.map((turn) => `${turn.speakerName}：${truncateChars(turn.text, 160)}`).join('\n')}`,
          '请输出讨论小结：',
        ].join('\n'),
        signal,
        temperature: 0.5,
      })
      let summary
      if (aiSummary) summary = cleanAiText(aiSummary, 400)
      else {
        stats.demoFallbacks += 1
        summary = demoDiscussSummary({ topic, side: sideValue, turns: turns.length, materials: materialList })
      }
      // 讨论阶段把一、二、三、四辩的稿子都先写出来，辩论时直接给对应辩手使用。
      const first = list.find((agent) => Number(agent.seat) === 1) || list[0]
      const second = list.find((agent) => Number(agent.seat) === 2) || list[1] || list[0]
      const third = list.find((agent) => Number(agent.seat) === 3) || list[2] || list[0]
      const fourth = list.find((agent) => Number(agent.seat) === 4) || list[3] || list[0]
      const notes = turns.map((turn) => `${turn.speakerName}：${truncateChars(turn.text, 120)}`).join('\n')
      const materialText = formatMaterials(materialList)
      const basePrompt = `【辩题】${normalizeString(topic) || ''}\n【本方】${sideLabelOf(sideValue)}\n【队内讨论要点】\n${notes}\n【分析材料】\n${materialText}`
      const [openingAi, secondAi, thirdAi, fourthAi] = await Promise.all([
        ask({
          system: [personaPrompt(first), DRAFT_ETIQUETTE, '为本方写一篇完整的一辩开篇立论陈词，1500-2000 字。要求：先称呼；再亮立场、逐个定义关键词、给判准；然后展开 2-3 点论证，每点先给结论句；接着预判对方最强质疑并回应；最后重申立场。只输出陈词正文。'].join('\n'),
          prompt: `${basePrompt}\n请直接写一辩陈词：`, signal, temperature: 0.8,
        }),
        ask({
          system: [personaPrompt(second), DRAFT_ETIQUETTE, '为本方二辩写「质询问题链 + 质询小结」。问题链 5-8 个短问，每个问题都要指向对方必须承认的事实；小结 700-900 字，先称呼，再整理质询中的让步与矛盾，收回到本方判准，结尾重申。只输出稿子。'].join('\n'),
          prompt: `${basePrompt}\n请写二辩质询问题链与小结：`, signal, temperature: 0.8,
        }),
        ask({
          system: [personaPrompt(third), DRAFT_ETIQUETTE, '为本方三辩写「盘问问题链 + 质询小结」。问题链 5-8 个短问，逼对方承认具体事实、不能含糊；小结 700-900 字，先称呼，再指出对方承认了什么、哪里前后矛盾，收回到本方判准。只输出稿子。'].join('\n'),
          prompt: `${basePrompt}\n请写三辩盘问问题链与小结：`, signal, temperature: 0.8,
        }),
        ask({
          system: [personaPrompt(fourth), DRAFT_ETIQUETTE, '为本方四辩写总结陈词，1500-2000 字。先称呼；总结 2-3 个全场交锋点，每个都说明对方让了什么、我方守住了什么；回到判准；回应对方最强攻击；最后价值收束并重申立场。只输出稿子。'].join('\n'),
          prompt: `${basePrompt}\n请写四辩总结陈词：`, signal, temperature: 0.8,
        }),
      ])
      const drafts = {
        opening: openingAi ? cleanAiText(openingAi, 2600) : '【一辩陈词·演示稿】我方判准是……（演示模式未接入模型）',
        second: secondAi ? cleanAiText(secondAi, 1800) : '【二辩问题链与小结·演示稿】（演示模式未接入模型）',
        third: thirdAi ? cleanAiText(thirdAi, 1800) : '【三辩问题链与小结·演示稿】（演示模式未接入模型）',
        fourth: fourthAi ? cleanAiText(fourthAi, 2600) : '【四辩总结·演示稿】（演示模式未接入模型）',
      }
      return { turns, summary, drafts }
    },

    /**
     * 辩论中的队内讨论（非发言人小声商量，不是正式发言）。
     * @returns {Promise<{speakerId:string, speakerName:string, text:string, fallback:boolean}>}
     */
    async huddle({ topic, round = 1, stage, side, agents, transcript, signal } = {}) {
      assertNotAborted(signal)
      const sideValue = side === 'con' ? 'con' : 'pro'
      const list = Array.isArray(agents) ? agents.filter(Boolean) : []
      const recentSpeakers = new Set(
        (Array.isArray(transcript) ? transcript : []).slice(-8).map((item) => item?.speakerId).filter(Boolean),
      )
      const pool = list
      const cursor = huddleCursor[sideValue] || 0
      huddleCursor[sideValue] = cursor + 1
      const agent = pool[cursor % Math.max(1, pool.length)] || list[0] || { id: `${sideValue}-1`, name: `${sideLabelOf(sideValue)}一辩`, seat: 1, side: sideValue, style: 'logic' }
      const last = lastOtherSideLine(transcript, sideValue) || (Array.isArray(transcript) && transcript.length ? transcript[transcript.length - 1] : null)
      const aiText = await ask({
        system: [
          personaPrompt({ ...agent, side: sideValue }),
          '现在不是你的发言时间。你坐在场边，凑近旁边队友小声说一句战术提醒：接下来打哪、别让什么、抓住对方哪句话。',
          '只输出这一句小声说的话，20-50 字；不要写成正式发言，不要称呼评委，不要展开论证。',
        ].join('\n'),
        prompt: [
          `【辩题】${normalizeString(topic) || '（未提供）'}`,
          `【环节】${stageLabel(stage)}`,
          `【刚才场上】${last ? `${normalizeString(last.who || last.speakerName) || '场上'}：“${truncateChars(normalizeString(last.text), 160)}”` : '（暂无）'}`,
          '你小声跟队友说：',
        ].join('\n'),
        signal,
        temperature: 0.8,
      })
      const text = aiText ? cleanAiText(aiText, 80) : `别跟着他绕定义，下一问直接逼他承认“${truncateChars(shortTopic(topic), 12)}”这件事到底谁负责。`
      return {
        speakerId: agent.id,
        speakerName: agent.name,
        text,
        fallback: !aiText,
      }
    },

    /**
     * 内心判断（不对外发言）：给思考层用，1-2 句，随后再生成正式台词。
     * @returns {Promise<{text:string, fallback:boolean}>}
     */
    async think({ topic, round = 1, stage, speaker, side, transcript, draft, signal } = {}) {
      assertNotAborted(signal)
      const sideValue = side === 'con' ? 'con' : side === 'pro' ? 'pro' : speaker?.side === 'con' ? 'con' : 'pro'
      const agent = speaker && typeof speaker === 'object'
        ? { ...speaker, side: sideValue }
        : { id: 'unknown', name: '辩手', role: 'debater', side: sideValue, seat: null, style: 'logic' }
      const context = buildContext(agent, { topic, round, stage, transcript, drafts: draft == null ? undefined : { [agent.id]: draft } })
      const aiText = await ask({
        system: thinkSystem(context.agent),
        prompt: thinkPrompt({ topic, stage, side: sideValue, transcript, draft }),
        signal,
        temperature: 0.8,
      })
      if (aiText) return { text: cleanAiText(aiText, 120), fallback: false }
      stats.demoFallbacks += 1
      return { text: demoThought({ stage, side: sideValue, topic }), fallback: true }
    },

    /**
     * 单条发言。
     * @returns {Promise<{text:string, fallback:boolean}>}
     */
    async speak({ topic, round = 1, stage, speaker, side, transcript, draft, ownSpeeches, thought, materials, signal } = {}) {
      assertNotAborted(signal)
      const sideValue = side === 'con' ? 'con' : side === 'pro' ? 'pro' : speaker?.side === 'con' ? 'con' : 'pro'
      const profile = stageProfile(stage)
      const agent = speaker && typeof speaker === 'object'
        ? { ...speaker, side: sideValue }
        : { id: 'unknown', name: '辩手', role: 'debater', side: sideValue, seat: null, style: 'logic' }
      const context = buildContext(agent, {
        topic,
        round,
        stage,
        transcript,
        drafts: draft == null ? undefined : { [agent.id]: draft },
        ownSpeeches,
        materials,
      })
      // 自检：辩手上下文绝不能带越权字段（buildContext 理论上已保证，这里兜底）。
      assertIsolation(context.agent, context)

      // 一辩立论、四辩总结基本照讨论阶段写好的稿子念，不再临场重写。
      if (profile === 'opening' || profile === 'closing') {
        const label = profile === 'opening' ? '一辩陈词·预写稿' : '四辩总结·预写稿'
        const section = extractDraftSection(context.draft, label)
        if (section.length > 80) {
          return { text: cleanAiText(section, 2600), fallback: false }
        }
      }

      const aiText = await ask({
        system: speakSystem(context.agent, promptFor('debater', context.agent.id)),
        prompt: speakPrompt({ context, profile, stage, side: sideValue, thought }),
        signal,
        temperature: 0.85,
      })
      if (aiText) {
        return { text: cleanAiText(aiText, 600), fallback: false }
      }
      stats.demoFallbacks += 1
      return { text: demoSpeech({ topic, round, stage, speaker: context.agent, side: sideValue, transcript }), fallback: true }
    },

    /**
     * 评委打分：返回 0..100 绝对分 + 短评 + findings。
     * @returns {Promise<{pro:number, con:number, comment:string, findings:string[], fallback:boolean}>}
     */
    async judge({ topic, round = 1, stage, judge, transcript, scoreboard, signal } = {}) {
      assertNotAborted(signal)
      const aiText = await ask({
        system: judgeSystem(promptFor('judge', judge?.id)),
        prompt: judgePrompt({ topic, round, stage, transcript, scoreboard }),
        signal,
        temperature: 0.4,
      })
      if (aiText) {
        const parsed = parseJudgeOutput(aiText)
        if (parsed) return { ...parsed, fallback: false }
        stats.aiFailures += 1
        log('[debate-sim] 评委输出无法解析，回退演示评分')
      }
      stats.demoFallbacks += 1
      return { ...demoJudge({ topic, round, stage, transcript }), fallback: true }
    },

    /**
     * 教练复盘：text 含「表现分析」+「改进建议」，analysis 为分析段。
     * @returns {Promise<{text:string, analysis:string, fallback:boolean}>}
     */
    async coach({ topic, side, round = 1, stage, transcript, judgeNotes, scoreboard, priorRounds, signal } = {}) {
      assertNotAborted(signal)
      const sideValue = side === 'con' ? 'con' : 'pro'
      const aiText = await ask({
        system: coachSystem(sideValue, promptFor('coach', sideValue === 'pro' ? 'coach-pro' : 'coach-con')),
        prompt: coachPrompt({ topic, side: sideValue, round, stage, transcript, judgeNotes, scoreboard, priorRounds }),
        signal,
        temperature: 0.7,
      })
      if (aiText) {
        let text = cleanAiText(aiText, 1800)
        if (!/建议/.test(text)) {
          text += `\n\n改进建议：\n${coachSuggestions({ topic, transcript }).map((item, index) => `${index + 1}. ${item}`).join('\n')}`
        }
        const { analysis } = splitCoachText(text)
        return { text, analysis, fallback: false }
      }
      stats.demoFallbacks += 1
      const demo = demoCoach({ topic, round, side: sideValue, transcript, judgeNotes, scoreboard })
      return { text: demo.text, analysis: demo.analysis, fallback: true }
    },

    /**
     * 管理员流程点评（不评分）。
     * @returns {Promise<{text:string, fallback:boolean}>}
     */
    async adminComment({ topic, round = 1, stage, scoreboard, transcript, issues, signal } = {}) {
      assertNotAborted(signal)
      const aiText = await ask({
        system: adminSystem(),
        prompt: adminPrompt({ topic, round, stage, scoreboard, transcript, issues }),
        signal,
        temperature: 0.6,
      })
      if (aiText) return { text: cleanAiText(aiText, 600), fallback: false }
      stats.demoFallbacks += 1
      return {
        text: demoAdminComment({ topic, round, stage, issues }),
        fallback: true,
      }
    },
  }

  return simulator
}
