/**
 * contexts 组测试：权限隔离（辩手无计分板 / 评委记录 / 对方草稿；评委与教练可见全部）。
 * 契约见 docs/CONTRACT.md §2.3 / §8。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoster } from '../lib/host/personas.js'
import {
  buildContext,
  assertIsolation,
  normalizeTranscript,
  normalizeDrafts,
  ownDrafts,
  isFullAccessRole,
  FULL_ACCESS_ROLES,
} from '../lib/host/contexts.js'

const TOPIC = '数字化让生活更美好'
const PRO_DRAFT = '正方内部草稿-ALPHA'
const CON_DRAFT = '反方内部草稿-BETA'

const roster = createRoster({ judges: 2 })

function findAgent(id) {
  const all = [...roster.pro, ...roster.con, ...roster.judges, roster.coaches.pro, roster.coaches.con, roster.admin]
  const agent = all.find((item) => item.id === id)
  assert.ok(agent, `花名册里应有 ${id}`)
  return agent
}

function makeRunView() {
  return {
    topic: TOPIC,
    round: 2,
    stage: { id: 'pro-opening', title: '正方一辩开篇立论', kind: 'speech', side: 'pro', seconds: 180 },
    transcript: [
      { side: 'pro', speakerId: 'pro-1', speakerName: '正方一辩', text: '正方陈述甲', stageTitle: '开篇立论', at: 1 },
      { side: 'con', speakerId: 'con-1', speakerName: '反方一辩', text: '反方陈述乙', stageTitle: '开篇立论', at: 2 },
      { side: 'con', speakerId: 'con-2', speakerName: '反方二辩', text: '私密备忘', private: true, at: 3 },
      { side: 'pro', speakerId: 'pro-2', speakerName: '正方二辩', text: '仅评委可见', forRoles: ['judge'], at: 4 },
    ],
    drafts: { pro: PRO_DRAFT, con: CON_DRAFT },
    scoreboard: {
      pro: 88,
      con: 76,
      history: [{ round: 2, stageIndex: 0, stageTitle: '开篇立论', pro: 88, con: 76, comment: '正方更清晰' }],
    },
    judgeNotes: [
      { stageIndex: 0, stageTitle: '开篇立论', judgeId: 'judge-1', judgeName: '评委甲', pro: 88, con: 76, comment: '正方论证更完整' },
    ],
    ownSpeeches: [{ side: 'pro', speakerId: 'pro-1', speakerName: '正方一辩', text: '正方陈述甲' }],
    materials: ['分析材料一', '分析材料二'],
    priorRounds: [{ round: 1, scores: { pro: 80, con: 75 } }],
  }
}

test('花名册：8 名辩手 + 1..3 评委 + 双教练 + 管理员，id 符合契约', () => {
  assert.equal(roster.pro.length, 4)
  assert.equal(roster.con.length, 4)
  assert.equal(roster.judges.length, 2)
  assert.deepEqual(roster.pro.map((agent) => agent.id), ['pro-1', 'pro-2', 'pro-3', 'pro-4'])
  assert.deepEqual(roster.con.map((agent) => agent.id), ['con-1', 'con-2', 'con-3', 'con-4'])
  assert.deepEqual(roster.judges.map((agent) => agent.id), ['judge-1', 'judge-2'])
  assert.equal(roster.coaches.pro.id, 'coach-pro')
  assert.equal(roster.coaches.con.id, 'coach-con')
  assert.equal(roster.admin.id, 'admin')
  assert.deepEqual(roster.pro.map((agent) => agent.seat), [1, 2, 3, 4])
  for (const agent of [...roster.pro, ...roster.con]) {
    assert.equal(agent.role, 'debater')
    assert.ok(agent.name && agent.avatar && /^#[0-9a-f]{6}$/i.test(agent.color), `${agent.id} 应有人设/头像/主题色`)
  }
  assert.equal(createRoster({ judges: 3 }).judges.length, 3)
  assert.equal(createRoster({ judges: 9 }).judges.length, 3, '评委数上限为 3')
})

test('辩手上下文：无计分板、无评委记录、无他轮隐私记录、无对方草稿', () => {
  const runView = makeRunView()
  const bundle = buildContext(findAgent('pro-1'), runView)

  assert.equal(bundle.visibility, 'limited')
  assert.equal(bundle.role, 'debater')
  assert.equal(bundle.side, 'pro')
  assert.equal(bundle.topic, TOPIC)
  assert.equal(bundle.round, 2)

  for (const forbidden of ['scoreboard', 'judgeNotes', 'priorRounds', 'notes']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(bundle, forbidden),
      false,
      `辩手上下文不得包含 ${forbidden}`,
    )
  }

  const json = JSON.stringify(bundle)
  assert.ok(json.includes(PRO_DRAFT), '辩手应能看到本方草稿')
  assert.ok(!json.includes(CON_DRAFT), '辩手上下文不得出现对方草稿')
  assert.ok(!json.includes('私密备忘'), '标记 private 的记录不得进入上下文')
  assert.ok(!json.includes('仅评委可见'), 'forRoles 不匹配的记录不得进入上下文')
  assert.ok(!json.includes('评委甲'), '辩手上下文不得出现评委点评')
  assert.ok(bundle.transcript.length === 2, `辩手转录应只保留 2 条公开记录，实际 ${bundle.transcript.length}`)
  assert.equal(bundle.ownSpeeches.length, 1)
  assert.equal(bundle.ownSpeeches[0].speakerId, 'pro-1')
  assert.equal(bundle.materials.length, 2)
  assert.equal(bundle.draft, PRO_DRAFT)

  assert.doesNotThrow(() => assertIsolation(findAgent('pro-1'), bundle))
  assert.doesNotThrow(() => assertIsolation(findAgent('con-2'), buildContext(findAgent('con-2'), runView)))
})

test('评委 / 教练 / 管理员上下文：可见全部记录、计分板与双方草稿', () => {
  const runView = makeRunView()

  for (const id of ['judge-1', 'coach-pro', 'coach-con', 'admin']) {
    const agent = findAgent(id)
    const bundle = buildContext(agent, runView)
    assert.equal(bundle.visibility, 'full', `${id} 应拥有完整视野`)
    assert.ok(bundle.scoreboard && bundle.scoreboard.pro === 88, `${id} 应能看到计分板`)
    assert.equal(bundle.judgeNotes.length >= 1, true, `${id} 应能看到评委记录`)
    assert.equal(bundle.judgeNotes[0].judgeName, '评委甲')
    assert.equal(bundle.priorRounds.length, 1, `${id} 应能看到他轮记录`)
    const draftText = bundle.drafts.map((draft) => draft.text).join('\n')
    assert.ok(draftText.includes(PRO_DRAFT) && draftText.includes(CON_DRAFT), `${id} 应能看到双方草稿`)
    assert.ok(!bundle.transcript.some((item) => item.text === '私密备忘'), 'private 记录对谁都不进入通用转录')
    assert.doesNotThrow(() => assertIsolation(agent, bundle))
  }

  const judgeBundle = buildContext(findAgent('judge-1'), runView)
  assert.ok(judgeBundle.transcript.some((item) => item.text === '仅评委可见'), 'forRoles=judge 的记录应进入评委转录')
  assert.deepEqual(FULL_ACCESS_ROLES.slice().sort(), ['admin', 'coach', 'judge'])
  assert.equal(isFullAccessRole('judge'), true)
  assert.equal(isFullAccessRole('debater'), false)
  assert.equal(isFullAccessRole(''), false)
})

test('assertIsolation：辩手 bundle 出现越权字段即 throw', () => {
  const agent = findAgent('pro-1')
  const bundle = buildContext(agent, makeRunView())

  assert.throws(
    () => assertIsolation(agent, { ...bundle, scoreboard: { pro: 88, con: 76 } }),
    /权限隔离违规[\s\S]*计分板/,
  )
  assert.throws(
    () => assertIsolation(agent, { ...bundle, judgeNotes: [{ comment: '评委点评' }] }),
    /权限隔离违规[\s\S]*评委记录/,
  )
  assert.throws(
    () => assertIsolation(agent, { ...bundle, drafts: [{ side: 'con', text: CON_DRAFT }] }),
    /权限隔离违规[\s\S]*对方草稿/,
  )
  assert.throws(
    () => assertIsolation(agent, { ...bundle, priorRounds: [{ round: 1 }] }),
    /权限隔离违规[\s\S]*(他轮|priorRounds)/,
  )
  assert.throws(() => assertIsolation(agent, null), /权限隔离违规/)
  assert.throws(() => assertIsolation(agent, 'not-an-object'), /权限隔离违规/)

  // 评委/教练/管理员带这些字段是合法的
  const judge = findAgent('judge-1')
  assert.doesNotThrow(() => assertIsolation(judge, { ...buildContext(judge, makeRunView()), scoreboard: { pro: 1, con: 2 } }))
})

test('normalizeTranscript / normalizeDrafts / ownDrafts：形状归一与越权过滤', () => {
  const bare = normalizeTranscript(makeRunView().transcript)
  assert.equal(bare.length, 3, '未指定角色时应保留 forRoles 记录，但丢弃 private 记录')
  assert.deepEqual(bare.map((item) => item.text), ['正方陈述甲', '反方陈述乙', '仅评委可见'])
  assert.equal(bare[0].side, 'pro')
  assert.equal(normalizeTranscript(null).length, 0)
  assert.equal(normalizeTranscript([{ text: '   ' }]).length, 0, '空白文本应被丢弃')

  const asDebater = normalizeTranscript(makeRunView().transcript, { role: 'debater' })
  assert.equal(asDebater.length, 2, '辩手转录应丢弃 forRoles=judge 与 private 记录')
  const asJudge = normalizeTranscript(makeRunView().transcript, { role: 'judge' })
  assert.ok(asJudge.some((item) => item.text === '仅评委可见'))
  const asCoach = normalizeTranscript(makeRunView().transcript, { role: 'coach' })
  assert.ok(!asCoach.some((item) => item.text === '仅评委可见'))

  const fromString = normalizeDrafts('单条草稿')
  assert.equal(fromString.length, 1)
  assert.equal(fromString[0].text, '单条草稿')

  const bySide = normalizeDrafts({ pro: PRO_DRAFT, con: CON_DRAFT })
  assert.deepEqual(bySide.map((draft) => draft.side), ['pro', 'con'])

  const byAgent = normalizeDrafts([{ agentId: 'pro-2', text: '二辩草稿' }, { agentId: 'con-1', text: '反方草稿' }])
  assert.deepEqual(byAgent.map((draft) => draft.side), ['pro', 'con'])

  const own = ownDrafts({ pro: PRO_DRAFT, con: CON_DRAFT }, findAgent('pro-3'))
  assert.equal(own.length, 1)
  assert.equal(own[0].side, 'pro')
  assert.ok(!JSON.stringify(own).includes(CON_DRAFT))
})

test('buildContext：不修改入参，且对残缺输入给出安全默认值', () => {
  const runView = makeRunView()
  const snapshot = JSON.parse(JSON.stringify(runView))
  buildContext(findAgent('pro-2'), runView)
  assert.deepEqual(runView, snapshot, 'buildContext 不得修改 runView')

  const loose = buildContext(findAgent('pro-2'), null)
  assert.equal(loose.topic, '')
  assert.equal(loose.round, 1)
  assert.deepEqual(loose.transcript, [])
  assert.deepEqual(loose.materials, [])
  assert.equal(loose.visibility, 'limited')
  assert.equal(loose.agent.id, 'pro-2')

  const weird = buildContext(findAgent('pro-2'), { topic: 42, round: 'x', transcript: 'oops', drafts: null })
  assert.equal(weird.topic, '')
  assert.equal(weird.round, 1)
  assert.deepEqual(weird.transcript, [])

  const unknownRole = buildContext({ id: 'ghost', role: 'unknown-role' }, runView)
  assert.equal(unknownRole.visibility, 'limited', '未知角色按最小权限处理')
  assert.equal(Object.prototype.hasOwnProperty.call(unknownRole, 'scoreboard'), false)
})
