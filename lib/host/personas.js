/**
 * 人设与花名册（契约：docs/CONTRACT.md §2.3）。
 *
 * 纯数据 + 纯函数：不读写文件、不联网、无副作用，engine 每轮都可以安全地重新调用
 * createRoster() 得到一份全新的智能体名单。
 *
 * 辩手人设刻意做出四种风格差异（学理 / 数据 / 攻防 / 价值），
 * 同一套风格在正反双方各有一人，保证攻防对称、又不会让八个人说同一种话。
 */

/** 默认评委人数（与插件配置 DEFAULT_CONFIG.judges 保持一致）。 */
export const DEFAULT_JUDGE_COUNT = 1
/** 评委上限（配置 judges: 1..3）。 */
export const MAX_JUDGES = 3

/** 风格代码 → 中文标签。 */
export const STYLE_LABELS = {
  logic: '学理',
  data: '数据',
  attack: '攻防',
  value: '价值',
}

/** 风格 → AI 系统提示里的一句话人设（demo 模板也复用这里的风格判断）。 */
export const STYLE_PROMPTS = {
  logic:
    '你是学理型。开口前先把关键词的定义和判准钉死；对方偷换概念时你会立刻打断纠正。你不爱喊口号，句子偏长一些，但每一句都咬住逻辑。不要用固定的开场套话。',
  data:
    '你是数据型。口袋里总揣着几个数字、样本和对照；你会追问口径、样本量、有没有对照组。你讨厌拍脑袋，但也不会把数据念成报表，数字只是你用来逼对方认账的工具。不要每次都从同一个句式起手。',
  attack:
    '你是攻防型。语速快、句子短，喜欢连续追问和归谬，擅长把话接过来。你享受把整场压缩到一个对方必须回答的问题上，最烦绕来绕去的场面话。不要反复使用同一句口头禅。',
  value:
    '你是价值型。先讲一个具体的人、一个场景，再把话抬到“我们到底想要怎样的生活”；你不太背数据，但擅长把抽象辩题讲出画面感，让评委记住你说的那个人。不要重复同一个故事模板。',
}

/** 八名辩手的种子数据（名字、头像标识 emoji、主题色、风格、格言）。 */
const DEBATER_SEEDS = [
  {
    side: 'pro',
    seat: 1,
    name: '沈砚舟',
    style: 'logic',
    avatar: '🧭',
    color: '#2563eb',
    title: '正方一辩 · 立论者',
    motto: '先把判准立住，胜负自然清楚。',
  },
  {
    side: 'pro',
    seat: 2,
    name: '林知数',
    style: 'data',
    avatar: '📊',
    color: '#0ea5e9',
    title: '正方二辩 · 数据与质询',
    motto: '没有口径的数据，只是另一种修辞。',
  },
  {
    side: 'pro',
    seat: 3,
    name: '秦戈',
    style: 'attack',
    avatar: '⚔️',
    color: '#6366f1',
    title: '正方三辩 · 盘问手',
    motto: '问题问到第三次，答案就藏不住了。',
  },
  {
    side: 'pro',
    seat: 4,
    name: '温言',
    style: 'value',
    avatar: '🕊️',
    color: '#8b5cf6',
    title: '正方四辩 · 结辩者',
    motto: '把道理讲到人心里，才算讲完。',
  },
  {
    side: 'con',
    seat: 1,
    name: '陆衡',
    style: 'logic',
    avatar: '📐',
    color: '#ea580c',
    title: '反方一辩 · 立论者',
    motto: '定义不清，争论就只是各说各话。',
  },
  {
    side: 'con',
    seat: 2,
    name: '许测',
    style: 'data',
    avatar: '🔬',
    color: '#f97316',
    title: '反方二辩 · 数据与质询',
    motto: '个案证明不了趋势，趋势也掩盖不了个案。',
  },
  {
    side: 'con',
    seat: 3,
    name: '韩铮',
    style: 'attack',
    avatar: '🗡️',
    color: '#dc2626',
    title: '反方三辩 · 盘问手',
    motto: '你退一步，我就再问一步。',
  },
  {
    side: 'con',
    seat: 4,
    name: '苏晚',
    style: 'value',
    avatar: '🌅',
    color: '#e11d48',
    title: '反方四辩 · 结辩者',
    motto: '制度的温度，决定了谁会被留下。',
  },
]

/** 评委候选（按配置取前 N 个）。 */
const JUDGE_SEEDS = [
  { name: '顾清和', avatar: '⚖️', color: '#0f766e', title: '首席评委', focus: '论证完整性与判准一致性' },
  { name: '罗知远', avatar: '🧮', color: '#7c3aed', title: '评委', focus: '数据口径与事实核查' },
  { name: '白露', avatar: '📖', color: '#b45309', title: '评委', focus: '价值表达与现场感染力' },
]

/** 双方教练。（教练不是辩手，不参与发言计时。） */
const COACH_SEEDS = {
  pro: {
    name: '林致远',
    avatar: '🧑‍🏫',
    color: '#1d4ed8',
    title: '正方教练',
    motto: '赢在准备，输在侥幸。',
  },
  con: {
    name: '岑野',
    avatar: '🧑‍🏫',
    color: '#c2410c',
    title: '反方教练',
    motto: '先想清楚对方最强的一击。',
  },
}

/** 管理员（调度、计时、纪律与归档）。 */
const ADMIN_SEED = {
  name: '纪衡',
  avatar: '🗂️',
  color: '#334155',
  title: '调度管理员',
  motto: '流程不乱，辩论才好看。',
}

function makeDebater(seed) {
  return {
    id: `${seed.side}-${seed.seat}`,
    name: seed.name,
    side: seed.side,
    seat: seed.seat,
    role: 'debater',
    avatar: seed.avatar,
    color: seed.color,
    title: seed.title,
    style: seed.style,
    styleLabel: STYLE_LABELS[seed.style],
    motto: seed.motto,
  }
}

function makeJudge(seed, index) {
  return {
    id: `judge-${index + 1}`,
    name: seed.name,
    side: 'neutral',
    seat: null,
    role: 'judge',
    avatar: seed.avatar,
    color: seed.color,
    title: seed.title,
    focus: seed.focus,
    motto: '只按判准投票。',
  }
}

function makeCoach(side) {
  const seed = COACH_SEEDS[side]
  return {
    id: `coach-${side}`,
    name: seed.name,
    side,
    seat: null,
    role: 'coach',
    avatar: seed.avatar,
    color: seed.color,
    title: seed.title,
    motto: seed.motto,
  }
}

function makeAdmin() {
  return {
    id: 'admin',
    name: ADMIN_SEED.name,
    side: 'neutral',
    seat: null,
    role: 'admin',
    avatar: ADMIN_SEED.avatar,
    color: ADMIN_SEED.color,
    title: ADMIN_SEED.title,
    motto: ADMIN_SEED.motto,
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 兼容 createRoster()、createRoster(2)、createRoster({ judges: 3 })。 */
function resolveJudgeCount(options) {
  if (typeof options === 'number') return clampInt(options, 1, MAX_JUDGES, DEFAULT_JUDGE_COUNT)
  if (options && typeof options === 'object') {
    return clampInt(options.judges ?? options.judgeCount, 1, MAX_JUDGES, DEFAULT_JUDGE_COUNT)
  }
  return DEFAULT_JUDGE_COUNT
}

/**
 * 创建一份完整花名册：8 名辩手 + N 名评委 + 双教练 + 管理员。
 * @param {{judges?:number}|number} [options]
 * @returns {{
 *   admin: object, pro: object[], con: object[], judges: object[],
 *   coaches: {pro:object, con:object}, all: object[]
 * }}
 */
export function createRoster(options = {}) {
  const judgeCount = resolveJudgeCount(options)
  const pro = DEBATER_SEEDS.filter((seed) => seed.side === 'pro').map(makeDebater)
  const con = DEBATER_SEEDS.filter((seed) => seed.side === 'con').map(makeDebater)
  const judges = JUDGE_SEEDS.slice(0, judgeCount).map(makeJudge)
  const coaches = { pro: makeCoach('pro'), con: makeCoach('con') }
  const admin = makeAdmin()
  // 对外一律用位置称呼，不出现个人姓名：正方一辩 / 反方二辩 / 评委一 / 正方教练 / 主席。
  const CN = ['一', '二', '三', '四']
  for (const agent of pro) agent.name = `正方${CN[agent.seat - 1] || agent.seat}辩`
  for (const agent of con) agent.name = `反方${CN[agent.seat - 1] || agent.seat}辩`
  judges.forEach((agent, index) => { agent.name = `评委${index + 1}` })
  coaches.pro.name = '正方教练'
  coaches.con.name = '反方教练'
  admin.name = '主席'
  return {
    admin,
    pro,
    con,
    judges,
    coaches,
    all: [...pro, ...con, ...judges, coaches.pro, coaches.con, admin],
  }
}

/** 花名册里的全部智能体（含管理员），防御性拷贝。 */
export function listAgents(roster) {
  if (!roster || typeof roster !== 'object') return []
  const out = []
  for (const agent of [...(roster.pro ?? []), ...(roster.con ?? []), ...(roster.judges ?? [])]) {
    if (agent) out.push(agent)
  }
  if (roster.coaches?.pro) out.push(roster.coaches.pro)
  if (roster.coaches?.con) out.push(roster.coaches.con)
  if (roster.admin) out.push(roster.admin)
  return out
}

/** 按 id 查找智能体，找不到返回 null。 */
export function findAgent(roster, id) {
  if (!id) return null
  return listAgents(roster).find((agent) => agent.id === id) ?? null
}

/** 某一方的 4 名辩手（按席位排序）。 */
export function agentsForSide(roster, side) {
  const list = side === 'con' ? roster?.con : roster?.pro
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => Number(a.seat ?? 0) - Number(b.seat ?? 0))
}

/** 席位查人（超出范围返回 null）。 */
export function debaterForSeat(roster, side, seat) {
  return agentsForSide(roster, side).find((agent) => Number(agent.seat) === Number(seat)) ?? null
}

/**
 * 拼一段可直接塞进 AI 系统提示的人设描述。
 * 辩手/评委/教练/管理员分别有不同的行为约束。
 */
export function personaPrompt(agent) {
  const role = agent?.role ?? 'debater'
  const name = agent?.name ?? '辩手'
  const sideLabel = agent?.side === 'pro' ? '正方' : agent?.side === 'con' ? '反方' : '中立'
  if (role === 'judge') {
    return [
      `你是评委「${name}」，${agent?.title ?? '本场评委'}，平时最看重${agent?.focus ?? '论证是否真的成立'}。`,
      '你说话像一位带过队的评委：先点出这一轮最要命的那一次交锋，再解释分为什么这么给，不绕弯子。',
      '你不偏袒任何一方，也不会被漂亮话带走；但你允许自己被一句真正有说服力的话打动。',
    ].join('')
  }
  if (role === 'coach') {
    return [
      `你是${sideLabel}教练「${name}」。`,
      `赛后你把队员叫到一边，先点出最疼的那个瞬间，再告诉他们下一场怎么改。你说话直接、护短，但不护错。`,
      '你不代替辩手发言，也不替评委打分；你只对自己人说话。',
    ].join('')
  }
  if (role === 'admin') {
    return [
      `你是本场辩论的主席/管理员「${name}」。`,
      '你负责流程、计时和秩序，语气稳、话不多；你点评节奏和规则，不评价谁讲得更好，也不给分。',
    ].join('')
  }
  return [
    `你是${sideLabel}${agent?.seat ? `${agent.seat}辩` : '辩手'}。`,
    '按赛制完成本环节任务，用清楚、自然的口语表达；不要表演性格，不要固定口头禅或固定开场白。',
    '记住：你输出的永远是你“开口说出来的话”，不是你的思考、提纲、战术分析或内心独白。',
  ].join('')
}
