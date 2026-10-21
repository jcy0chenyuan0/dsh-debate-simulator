/**
 * flow 组测试：默认 14 环节赛制、validateFlow 归一化与拒错、planTurns 回合规划。
 * 契约见 docs/CONTRACT.md §2.2 / §8。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultFlow,
  validateFlow,
  planTurns,
  DEFAULT_ROUNDS,
  MAX_ROUNDS,
  MAX_STAGES,
  DEFAULT_BUBBLE_SECONDS,
  DEFAULT_DISCUSSION_SECONDS,
} from '../lib/host/flow.js'

const EXPECTED_IDS = [
  'pro-opening',
  'con-cross-1',
  'con-opening',
  'pro-cross-1',
  'con-summary-1',
  'pro-summary-1',
  'fourth-dialogue',
  'pro-inquiry',
  'con-inquiry',
  'pro-inquiry-summary',
  'con-inquiry-summary',
  'free-debate',
  'con-closing',
  'pro-closing',
]

const EXPECTED_SECONDS = [180, 90, 180, 90, 120, 120, 90, 90, 90, 120, 120, 180, 210, 210]

const EXPECTED_KINDS = [
  'speech',
  'cross',
  'speech',
  'cross',
  'speech',
  'speech',
  'dialogue',
  'inquiry',
  'inquiry',
  'speech',
  'speech',
  'free',
  'speech',
  'speech',
]

test('defaultFlow：14 个环节，顺序 / 秒数 / 环节类型符合赛制', () => {
  const flow = defaultFlow()
  assert.equal(flow.length, 14, '默认赛制必须是 14 个环节')
  assert.deepEqual(flow.map((stage) => stage.id), EXPECTED_IDS)
  assert.deepEqual(flow.map((stage) => stage.seconds), EXPECTED_SECONDS)
  assert.deepEqual(flow.map((stage) => stage.kind), EXPECTED_KINDS)
})

test('defaultFlow：计时方式（单边计时 / 双方分开计时）与先手正确', () => {
  const flow = defaultFlow()
  const byId = new Map(flow.map((stage) => [stage.id, stage]))
  for (const stage of flow) {
    assert.ok(stage.title, `${stage.id} 缺少中文标题`)
    assert.ok(stage.description, `${stage.id} 缺少环节说明`)
    assert.ok(stage.rule, `${stage.id} 缺少给智能体的规则提醒`)
  }
  // 质询 / 盘问单边计时：只对质询（盘问）方计时，回答方不计时
  assert.equal(byId.get('con-cross-1').singleSide, true)
  assert.equal(byId.get('pro-cross-1').singleSide, true)
  assert.equal(byId.get('pro-inquiry').singleSide, true)
  assert.equal(byId.get('pro-inquiry').respondentNoClock, true)
  assert.equal(byId.get('con-inquiry').targetExclude.length, 1)
  // 对辩与自由辩论：双方分开计时
  assert.equal(byId.get('fourth-dialogue').perSide, true)
  assert.equal(byId.get('fourth-dialogue').first, 'pro')
  assert.equal(byId.get('free-debate').perSide, true)
  assert.equal(byId.get('free-debate').first, 'pro')
  // 陈词席位：一辩立论、四辩总结
  assert.equal(byId.get('pro-opening').seat, 1)
  assert.equal(byId.get('pro-closing').seat, 4)
  assert.equal(byId.get('con-closing').seat, 4)
  // 先反后正：反方四辩总结陈词在正方之前
  const conIndex = flow.findIndex((stage) => stage.id === 'con-closing')
  const proIndex = flow.findIndex((stage) => stage.id === 'pro-closing')
  assert.ok(conIndex > 0 && conIndex < proIndex, '反方总结陈词应先于正方总结陈词')
})

test('defaultFlow：默认赛制本身可通过 validateFlow（归一化后不丢环节）', () => {
  const result = validateFlow(defaultFlow())
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('；'))
  assert.equal(result.flow.length, 14)
  assert.deepEqual(result.flow.map((stage) => stage.seconds), EXPECTED_SECONDS)
  assert.deepEqual(result.flow.map((stage) => stage.id), EXPECTED_IDS)
})

test('validateFlow：非数组 / 空数组 / 超长数组被拒绝，错误信息为中文', () => {
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'not-a-flow'],
    ['对象无 stages', { foo: 1 }],
    ['空数组', []],
    ['超过上限', Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ id: `s-${i}`, title: `环节${i}`, seconds: 30 }))],
  ]
  for (const [label, input] of cases) {
    const result = validateFlow(input)
    assert.equal(result.ok, false, `${label} 应被拒绝`)
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, `${label} 应给出错误原因`)
    for (const message of result.errors) {
      assert.equal(typeof message, 'string')
      assert.match(message, /[\u4e00-\u9fa5]/, `${label} 的错误信息应为中文：${message}`)
    }
  }
})

test('validateFlow：脏数据逐项拒绝（缺标题 / 秒数越界 / 非法 kind / 重复 id / side 冲突）', () => {
  const cases = [
    { label: '缺标题', stage: { seconds: 30 }, pattern: /标题/ },
    { label: '缺秒数', stage: { title: '环节' }, pattern: /seconds/ },
    { label: '秒数非数字', stage: { title: '环节', seconds: 'abc' }, pattern: /seconds/ },
    { label: '非法 kind', stage: { title: '环节', seconds: 30, kind: 'speechh' }, pattern: /kind/ },
    { label: '非法 side', stage: { title: '环节', seconds: 30, side: 'left' }, pattern: /side/ },
    { label: 'speech 用 both', stage: { title: '环节', seconds: 30, kind: 'speech', side: 'both' }, pattern: /both/ },
    { label: 'perSide + singleSide', stage: { title: '环节', seconds: 30, kind: 'dialogue', perSide: true, singleSide: true }, pattern: /perSide|singleSide/ },
  ]
  for (const { label, stage, pattern } of cases) {
    const result = validateFlow([stage])
    assert.equal(result.ok, false, `${label} 应被拒绝`)
    assert.ok(
      result.errors.some((message) => pattern.test(message)),
      `${label} 的错误应匹配 ${pattern}，实际：${result.errors.join('；')}`,
    )
  }

  const duplicate = validateFlow([
    { id: 'same', title: '环节一', seconds: 30 },
    { id: 'same', title: '环节二', seconds: 30 },
  ])
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.errors.some((message) => /重复/.test(message)), '重复 id 应被拒绝')

  const notObject = validateFlow([{ title: '环节', seconds: 30 }, 'x'])
  assert.equal(notObject.ok, false)
  assert.ok(notObject.errors.some((message) => /对象/.test(message)))

  // 秒数越界按契约「限 1..1800」收敛，不当作错误
  const clamped = validateFlow([
    { title: '太短', seconds: 0 },
    { title: '太长', seconds: 1801 },
  ])
  assert.equal(clamped.ok, true, clamped.ok ? '' : clamped.errors.join('；'))
  assert.deepEqual(clamped.flow.map((stage) => stage.seconds), [1, 1800])
})

test('validateFlow：归一化补默认值 / 裁剪长度 / 限制范围', () => {
  const result = validateFlow({
    stages: [
      { title: '自 由 辩 论', seconds: 60, kind: 'free', exchanges: 99, seats: [9, 0] },
      { title: '盘问', seconds: 30, kind: 'inquiry', side: 'pro', seat: 3, targetExclude: [1, 1, 9] },
      { id: 'x'.repeat(80), title: '标'.repeat(80), seconds: 1800, kind: 'speech', side: 'con', seat: 9 },
    ],
  })
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('；'))
  const [free, inquiry, speech] = result.flow

  assert.equal(free.kind, 'free')
  assert.equal(free.side, 'both', 'free 环节必须归一化为双方')
  assert.equal(free.exchanges, 12, 'exchanges 应被限制到 12')
  assert.deepEqual(free.seats, [4, 1], 'seats 应被限制到 1..4')
  assert.equal(free.first, 'pro', '双方环节默认正方先手')

  assert.equal(inquiry.kind, 'inquiry')
  assert.equal(inquiry.side, 'pro')
  assert.equal(inquiry.seat, 3)
  assert.deepEqual(inquiry.targetExclude, [1, 4], 'targetExclude 应去重并限制到 1..4')

  assert.equal(speech.id.length, 48, 'id 应被裁剪到 48 字符')
  assert.equal(speech.title.length, 60, 'title 应被裁剪到 60 字符')
  assert.equal(speech.seconds, 1800)
  assert.equal(speech.seat, 4, 'seat 越界时应收敛到 4')

  const minimal = validateFlow([{ title: '最小环节', seconds: 30 }])
  assert.equal(minimal.ok, true)
  assert.equal(minimal.flow[0].kind, 'speech')
  assert.equal(minimal.flow[0].side, 'pro')
  assert.equal(minimal.flow[0].exchanges, 4)
  assert.equal(minimal.flow[0].perSide, false)
  assert.equal(minimal.flow[0].singleSide, false)
})

test('planTurns：陈词环节只有 1 个回合，消耗全部环节计时', () => {
  const turns = planTurns({ side: 'pro', kind: 'speech', seat: 2, seconds: 120 })
  assert.deepEqual(turns, [{ side: 'pro', role: 'speaker', seat: 2, share: 1 }])
})

test('planTurns：质询 / 盘问交替，质询方分摊计时，回答方不计时', () => {
  for (const kind of ['cross', 'inquiry']) {
    const turns = planTurns({ side: 'con', kind, seat: 2, seconds: 90, exchanges: 4 })
    assert.equal(turns.length, 4, `${kind} 4 轮交换应产生 4 个回合`)
    assert.deepEqual(turns.map((turn) => turn.side), ['con', 'pro', 'con', 'pro'])
    assert.deepEqual(turns.map((turn) => turn.role), ['examiner', 'responder', 'examiner', 'responder'])
    assert.deepEqual(turns.map((turn) => turn.seat), [2, null, 2, null])
    assert.deepEqual(turns.map((turn) => turn.share), [0.5, 0, 0.5, 0])
    assert.equal(turns.reduce((sum, turn) => sum + turn.share, 0), 1, '质询方 share 之和应为 1')
  }

  const odd = planTurns({ side: 'pro', kind: 'cross', seat: 1, seconds: 90, exchanges: 5 })
  assert.equal(odd.length, 5)
  assert.equal(odd.filter((turn) => turn.role === 'examiner').length, 3, '5 轮交换应由质询方收尾')
  assert.equal(Math.round(odd.reduce((sum, turn) => sum + turn.share, 0) * 1000) / 1000, 1)
})

test('planTurns：对辩 / 自由辩论双方交替，各自计时，按 seats 分配席位', () => {
  const dialogue = planTurns({
    side: 'both',
    kind: 'dialogue',
    seats: [4, 4],
    seconds: 90,
    perSide: true,
    first: 'pro',
    exchanges: 6,
  })
  assert.equal(dialogue.length, 6)
  assert.deepEqual(dialogue.map((turn) => turn.side), ['pro', 'con', 'pro', 'con', 'pro', 'con'])
  assert.deepEqual(dialogue.map((turn) => turn.seat), [4, 4, 4, 4, 4, 4])
  assert.deepEqual(dialogue.map((turn) => turn.role), ['speaker', 'speaker', 'speaker', 'speaker', 'speaker', 'speaker'])
  assert.deepEqual(dialogue.map((turn) => turn.share), [1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3])

  const conFirst = planTurns({ side: 'both', kind: 'dialogue', seconds: 90, first: 'con', exchanges: 4 })
  assert.deepEqual(conFirst.map((turn) => turn.side), ['con', 'pro', 'con', 'pro'])

  const free = planTurns({ side: 'both', kind: 'free', seconds: 180, first: 'pro', exchanges: 8 })
  assert.equal(free.length, 8)
  assert.ok(free.every((turn) => turn.role === 'free'), '自由辩论回合角色应为 free')
  assert.equal(free.filter((turn) => turn.side === 'pro').length, 4)
  assert.equal(free.filter((turn) => turn.side === 'con').length, 4)
  assert.deepEqual(free.map((turn) => turn.share), [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25])
})

test('planTurns：exchanges 越界时收敛到 1..12，且不修改入参', () => {
  const stage = { side: 'pro', kind: 'cross', seat: 1, seconds: 90, exchanges: 99 }
  const snapshot = JSON.parse(JSON.stringify(stage))
  const turns = planTurns(stage)
  assert.equal(turns.length, 12, 'exchanges 99 应收敛到 12 轮')
  assert.deepEqual(stage, snapshot, 'planTurns 不得修改传入的 stage')

  assert.equal(planTurns({ side: 'pro', kind: 'cross', seat: 1, seconds: 90, exchanges: 0 }).length, 4)
  assert.equal(planTurns({ side: 'pro', kind: 'cross', seat: 1, seconds: 90 }).length, 4)
})

test('常量：轮次 / 气泡 / 讨论时长默认值符合契约', () => {
  assert.equal(DEFAULT_ROUNDS, 3)
  assert.equal(MAX_ROUNDS, 100)
  assert.equal(MAX_STAGES, 60)
  assert.equal(DEFAULT_BUBBLE_SECONDS, 10)
  assert.equal(DEFAULT_DISCUSSION_SECONDS, 180)
})
