/**
 * Lead 集成自检：不依赖 DSH，直接驱动引擎跑一轮 demo，检查串行、归档、清理、恢复。
 * 用法：node scripts/verify.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/host/engine.js'
import { createRoster, createSimulator } from '../lib/host/simulate.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const baseDir = path.join(root, '.verify-runs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
}

async function main() {
  await fsp.rm(baseDir, { recursive: true, force: true })
  const engine = createEngine({
    baseDir,
    config: { mode: 'demo' },
    createRoster,
    createSimulator: (opts) =>
      createSimulator({ ...opts, mode: 'demo', llm: null, model: null, logger: (...a) => console.log('[sim]', ...a) }),
    logger: (...a) => console.log('[engine]', ...a),
  })
  await engine.init()
  const initial = engine.getState()
  assert(initial.phase === 'idle', `初始应为 idle，实际 ${initial.phase}`)

  const customFlow = [
    {
      id: 'v-opening',
      title: '正方一辩开篇立论',
      kind: 'speech',
      side: 'pro',
      seat: 1,
      seconds: 30,
      description: '自检环节',
    },
    {
      id: 'v-cross',
      title: '反方二辩质询',
      kind: 'cross',
      side: 'con',
      seat: 2,
      seconds: 30,
      exchanges: 4,
      canInterrupt: true,
      description: '自检质询',
    },
  ]

  const started = await engine.start({
    topic: '自检：数字化让生活更美好',
    config: {
      rounds: 1,
      bubbleSeconds: 0.05,
      discussionSeconds: 30,
      judges: 1,
      timeScale: 60,
      mode: 'demo',
      customFlow,
    },
  })
  assert(started.runId, 'start 应返回 runId')
  console.log('started', started.runId, started.phase)

  const deadline = Date.now() + 120000
  let state = started
  let sawBubble = false
  let lastSeq = 0
  const speechWindows = []
  while (Date.now() < deadline) {
    state = engine.getState()
    if (state.current) {
      sawBubble = true
      if (state.current.seq !== lastSeq) {
        lastSeq = state.current.seq
        speechWindows.push({ seq: lastSeq, start: state.current.startedAt, end: state.current.endsAt })
      }
    }
    if (state.phase === 'done' || (!state.active && state.phase !== 'paused' && state.phase !== 'idle')) break
    await sleep(80)
  }
  console.log('final phase', state.phase, 'round', state.round, 'scores', state.scoreboard)
  assert(sawBubble, '应观察到至少一条发言气泡')
  assert(state.phase === 'done', `最终应为 done，实际 ${state.phase}（error=${state.error}）`)
  assert(state.agents.alive === 0, `轮后存活智能体应为 0，实际 ${state.agents.alive}`)

  const runDir = path.join(baseDir, state.runId)
  const zip = path.join(runDir, '第01轮_辩论归档.zip')
  assert((await fsp.stat(zip)).size > 0, 'ZIP 应存在且非空')
  const roundDirs = await fsp.readdir(runDir).catch(() => [])
  assert(!roundDirs.includes('第01轮'), `第01轮 工作目录应被清理，实际 ${roundDirs.join(',')}`)
  assert(roundDirs.includes('rounds-index.json'), '应保留 rounds-index.json')

  for (let i = 1; i < speechWindows.length; i += 1) {
    assert(
      speechWindows[i].start >= speechWindows[i - 1].end - 5,
      `发言串行被破坏：第 ${i} 条开始 ${speechWindows[i].start} < 上一条结束 ${speechWindows[i - 1].end}`,
    )
  }

  const records = engine.getRecords()
  assert(records.rounds.length === 1, `records 应有 1 轮，实际 ${records.rounds.length}`)
  assert(records.rounds[0].stages.length === 2, 'records 应有 2 个环节')

  // 恢复能力：伪造一个未完成 run 的 state 检查 init 置 paused
  const recoveryDir = path.join(baseDir, 'recovery-run')
  await fsp.mkdir(recoveryDir, { recursive: true })
  await fsp.writeFile(
    path.join(recoveryDir, 'state.json'),
    JSON.stringify({
      version: 1,
      runId: 'recovery-run',
      topic: '恢复测试',
      phase: 'debate',
      active: true,
      rounds: 1,
      round: 1,
      stageIndex: 3,
      stageCount: 14,
      created: Date.now(),
      updated: Date.now(),
    }),
  )
  const engine2 = createEngine({
    baseDir,
    config: { mode: 'demo' },
    createRoster,
    createSimulator: (opts) => createSimulator({ ...opts, mode: 'demo', llm: null, model: null }),
  })
  await engine2.init()
  const recovered = engine2.getState()
  assert(recovered.phase === 'paused', `恢复后应为 paused，实际 ${recovered.phase}`)
  assert(recovered.recovered === true, 'recovered 标记应为 true')

  await engine.dispose()
  await engine2.dispose()
  console.log('\nALL CHECKS PASSED')
}

main().catch((error) => {
  console.error('\nVERIFY FAILED:', error)
  process.exitCode = 1
})
