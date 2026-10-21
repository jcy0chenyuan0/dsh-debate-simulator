/**
 * engine 组测试：demo 模式（2 环节自定义赛制 / 0.05s 气泡）端到端跑完一轮，
 * 以及「进程中断 → 新引擎 init 恢复 paused → resume-run 继续跑完」。
 * 契约见 docs/CONTRACT.md §2.4 / §2.5 / §2.6 / §5 / §8。
 *
 * 断言重点：
 * - 发言严格串行（相邻气泡的时间区间不重叠，按引擎自己记录的 startedAt/endsAt 判定）；
 * - 轮后「第01轮/」目录被删除、ZIP 存在且内容齐全、rounds-index.json 与 state.json 落盘；
 * - 轮后 agents.alive = 0；
 * - 重启 init() 能把未完成的 run 恢复为 paused，并可继续跑完。
 *
 * 产物全部写在系统临时目录，不污染仓库。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createEngine } from '../lib/host/engine.js'
import { createRoster, createSimulator } from '../lib/host/simulate.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const NODE = process.env.DSH_DEBATE_NODE || process.execPath
const TOPIC = '集成测试：数字化让生活更美好'
const ZIP_NAME = '第01轮_辩论归档.zip'
const RUN_TIMEOUT = 60000

/** 2 环节自定义赛制：1 个陈词 + 1 个质询（4 回合）。 */
const FLOW = [
  {
    id: 'it-opening',
    title: '正方一辩开篇立论',
    kind: 'speech',
    side: 'pro',
    seat: 1,
    seconds: 30,
    description: '测试用陈词环节',
    rule: '给出定义、标准与论点。',
  },
  {
    id: 'it-cross',
    title: '反方二辩质询正方一辩',
    kind: 'cross',
    side: 'con',
    seat: 2,
    targetSeat: 1,
    seconds: 30,
    exchanges: 4,
    canInterrupt: true,
    description: '测试用质询环节',
    rule: '只问不答。',
  },
]

/** 中断探针使用的赛制（与主用例同构，英文标题便于子进程传递）。 */
const CRASH_FLOW = [
  { id: 'crash-opening', title: 'Opening', kind: 'speech', side: 'pro', seat: 1, seconds: 30 },
  { id: 'crash-cross', title: 'Cross', kind: 'cross', side: 'con', seat: 2, targetSeat: 1, seconds: 30, exchanges: 4 },
]

const PUBLIC_STATE_KEYS = [
  'ok',
  'version',
  'runId',
  'topic',
  'created',
  'updated',
  'active',
  'recovered',
  'phase',
  'phaseLabel',
  'mode',
  'rounds',
  'round',
  'stageIndex',
  'stageCount',
  'stage',
  'clock',
  'bubbleSeconds',
  'current',
  'discussion',
  'pro',
  'con',
  'judges',
  'scoreboard',
  'recent',
  'archive',
  'agents',
  'error',
  'lastEvent',
  'config',
]

const ZIP_EXPECTED_NAMES = [
  'README.txt',
  '管理员评论.md',
  '正方/草稿纸.md',
  '正方/讨论记录.md',
  '正方/发言记录.md',
  '正方/分析材料.md',
  '正方/总结.md',
  '反方/草稿纸.md',
  '反方/讨论记录.md',
  '反方/发言记录.md',
  '反方/分析材料.md',
  '反方/总结.md',
  '评委/评委记录.md',
  '评委/计分板.md',
]

/* ------------------------------- 工具函数 ------------------------------- */

function createDemoEngine(baseDir, options = {}) {
  return createEngine({
    baseDir,
    config: { mode: 'demo', llmTimeoutMs: 5000, ...(options.config || {}) },
    createRoster: (rosterOptions) => createRoster(rosterOptions),
    createSimulator: (simOptions) =>
      createSimulator({ ...simOptions, mode: 'demo', llm: null, model: null, logger: options.logger || (() => {}) }),
    logger: options.logger || (() => {}),
  })
}

async function waitForState(engine, predicate, timeoutMs = RUN_TIMEOUT) {
  const startedAt = Date.now()
  let last = engine.getState()
  while (Date.now() - startedAt < timeoutMs) {
    last = engine.getState()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待引擎状态超时（${timeoutMs}ms）：phase=${last.phase} round=${last.round} stage=${last.stageIndex} error=${last.error || 'none'}`)
}

/** 等待 JSON 文件落盘到期望内容（state.json 由 250ms 防抖写入，需容忍短暂滞后）。 */
async function waitForJson(file, predicate, timeoutMs = 15000) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (predicate(value)) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`等待 ${file} 落盘超时：${lastError ? lastError.message : '内容未满足条件'}`)
}

/** 极简 ZIP 解包（store 模式）：返回名称 / 标志位 / 内容。 */
function readZipEntries(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0, 'ZIP 缺少 EOCD 结束记录')
  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, `第 ${index + 1} 条中央目录签名不符`)
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    const size = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 本地文件头签名不符`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    entries.push({ name, flags, method, size, data: buf.subarray(dataStart, dataStart + size) })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

let pythonCache

function findPython() {
  if (pythonCache !== undefined) return pythonCache
  const candidates = [
    process.env.DSH_PYTHON,
    process.env.DEBATE_PYTHON,
    process.env.PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter((value) => typeof value === 'string' && value.trim())
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-c', 'import docx'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (probe.status === 0) {
      pythonCache = exe
      return pythonCache
    }
  }
  pythonCache = null
  return pythonCache
}

/** 用 python-docx 读段落；没有 python-docx 时返回 null。 */
function readDocxParagraphs(file) {
  const python = findPython()
  if (!python) return null
  const code = `
import json, sys
import docx
document = docx.Document(sys.argv[1])
print(json.dumps({"paragraphs": [p.text for p in document.paragraphs], "tables": len(document.tables)}, ensure_ascii=False))
`
  const result = spawnSync(python, ['-c', code, file], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.status !== 0) throw new Error(`python-docx 读取失败：${result.stderr || result.status}`)
  return JSON.parse(result.stdout)
}

/* --------------------------------- 用例 --------------------------------- */

test('engine：空目录 init 后为 idle，PublicState 字段齐全，非法控制/启动参数被拒绝', { timeout: 30000 }, async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-idle-'))
  const engine = createDemoEngine(baseDir)
  t.after(async () => {
    await engine.dispose().catch(() => {})
    await fsp.rm(baseDir, { recursive: true, force: true })
  })

  const state = await engine.init()
  assert.equal(state.phase, 'idle')
  assert.equal(state.phaseLabel, '空闲')
  assert.equal(state.active, false)
  assert.equal(state.runId, null)
  for (const key of PUBLIC_STATE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(state, key), `PublicState 缺字段：${key}`)
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)), 'PublicState 必须可 JSON 序列化')
  assert.equal(Array.isArray(engine.listRuns()), true)
  assert.equal(engine.listRuns().length, 0)

  await assert.rejects(() => engine.control('pause'), /没有进行中的辩论/)
  await assert.rejects(() => engine.control('resume'), /没有可继续的辩论/)
  await assert.rejects(() => engine.control('跳一下'), /未知控制指令/)
  await assert.rejects(() => engine.start({ topic: '   ' }), /辩题不能为空/)
  await assert.rejects(() => engine.start({ topic: '长'.repeat(201) }), /200/)
  assert.equal(engine.getState().phase, 'idle', '失败的 start 不得留下运行状态')
})

test('engine：demo 模式 2 环节 / 0.05s 气泡跑完一轮——串行、归档、清理、智能体下线', { timeout: RUN_TIMEOUT }, async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-run-'))
  const logs = []
  const logger = (...args) => logs.push(args.map((value) => String(value)).join(' '))
  const engine = createDemoEngine(baseDir, { logger })
  t.after(async () => {
    await engine.dispose().catch(() => {})
    await fsp.rm(baseDir, { recursive: true, force: true })
  })

  await engine.init()

  // 通过 onChange 捕获每一条气泡：引擎在气泡开始展示的那一刻同步 emit。
  const bubbles = []
  const off = engine.onChange((snapshot) => {
    const current = snapshot.current
    if (!current) return
    if (bubbles.some((item) => item.seq === current.seq)) return
    bubbles.push({
      seq: current.seq,
      kind: current.kind,
      side: current.side,
      speakerId: current.speakerId,
      text: current.text,
      startedAt: current.startedAt,
      endsAt: current.endsAt,
      durationMs: current.durationMs,
    })
  })
  t.after(() => off())

  const started = await engine.start({
    topic: TOPIC,
    config: {
      rounds: 1,
      bubbleSeconds: 0.05,
      discussionSeconds: 1,
      judges: 1,
      timeScale: 60,
      mode: 'demo',
      customFlow: FLOW,
    },
  })
  assert.equal(typeof started.runId, 'string')
  assert.ok(started.runId.length > 0, 'start 应返回 runId')
  assert.match(started.runId, /^\d{8}-\d{6}-/)
  assert.equal(started.topic, TOPIC)
  assert.equal(started.rounds, 1)
  assert.equal(started.round, 1)
  assert.equal(started.bubbleSeconds, 0.05)
  assert.equal(started.mode, 'demo')
  assert.equal(started.config.customFlow, true)
  assert.equal(started.config.judges, 1)
  assert.equal(started.active, true)

  const final = await waitForState(engine, (state) => state.phase === 'done' || state.phase === 'error')
  assert.equal(final.phase, 'done', `引擎未跑完：phase=${final.phase} error=${final.error || 'none'}\n最近日志：\n${logs.slice(-10).join('\n')}`)
  assert.equal(final.error, null, `运行过程中出现错误：${final.error}`)
  assert.equal(final.active, false)
  assert.equal(final.current, null)
  assert.equal(final.agents.alive, 0, '轮后存活智能体必须为 0')
  assert.equal(final.agents.count, 0, '轮后智能体总数必须为 0')

  /* ------------------------------ 严格串行 ------------------------------ */
  const ordered = [...bubbles].sort((a, b) => a.seq - b.seq)
  const discussionBubbles = ordered.filter((bubble) => bubble.kind === 'discussion')
  const debateBubbles = ordered.filter((bubble) => bubble.kind === 'speech' || bubble.kind === 'cross')
  const coachBubbles = ordered.filter((bubble) => bubble.kind === 'summary')

  assert.equal(discussionBubbles.length, 0, `讨论阶段不应再走发言气泡（讨论只做准备），实际 ${discussionBubbles.length}`)
  assert.equal(debateBubbles.length, 5, `辩论阶段应有 5 条气泡（1 陈词 + 4 质询），实际 ${debateBubbles.length}`)
  assert.equal(coachBubbles.length, 2, `教练总结应有 2 条气泡，实际 ${coachBubbles.length}`)
  assert.equal(ordered.length, 7, `一轮应产生 7 条气泡，实际 ${ordered.length}`)
  assert.equal(new Set(ordered.map((bubble) => bubble.seq)).size, ordered.length, '气泡 seq 不得重复')

  for (const bubble of ordered) {
    assert.equal(bubble.endsAt - bubble.startedAt, 50, `气泡 ${bubble.seq} 的展示时长应为 bubbleSeconds=0.05 秒`)
    assert.equal(bubble.durationMs, 50)
    assert.ok(bubble.text.length > 0, `气泡 ${bubble.seq} 不应为空文本`)
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    assert.ok(
      current.startedAt >= previous.endsAt,
      `发言串行被破坏：seq ${current.seq} 开始于 ${current.startedAt}，早于上一条 seq ${previous.seq} 的结束时间 ${previous.endsAt}`,
    )
    assert.ok(current.startedAt >= previous.startedAt, '气泡时间必须单调递增')
  }

  /* --------------------------- 记录（§2.6） --------------------------- */
  const records = engine.getRecords()
  assert.equal(records.ok, true)
  assert.equal(records.runId, final.runId)
  assert.equal(records.topic, TOPIC)
  assert.equal(records.mode, 'demo')
  assert.equal(records.rounds.length, 1)
  const round = records.rounds[0]
  assert.equal(round.round, 1)
  assert.equal(round.stages.length, 2, '应记录 2 个环节')
  assert.equal(round.stages[0].title, FLOW[0].title)
  assert.equal(round.stages[1].title, FLOW[1].title)
  assert.equal(round.stages[0].speeches.length, 1)
  assert.equal(round.stages[1].speeches.length, 4)
  for (const stage of round.stages) {
    for (const speech of stage.speeches) {
      assert.ok(speech.speakerId && speech.speakerName, '每条发言都应有 speakerId / speakerName')
      assert.ok(speech.text.length > 0)
      assert.equal(speech.stageTitle, stage.title)
      // 思考层：演示模式也会生成「内心判断」，并随记录落库（不对外发言，但可回看）
      assert.equal(typeof speech.thought, 'string')
      assert.ok(speech.thought.length > 0, '演示模式每条发言都应带内心思考层 thought')
    }
  }
  // 讨论双栏：state.discussion.turns 在讨论阶段就提前写入，双方各 4 条（左右两栏同时展示）
  assert.ok(round.discussion.pro.length >= 4, '讨论记录应至少含正方 4 条（不限制轮数，直到计时结束）')
  assert.ok(round.discussion.con.length >= 4, '讨论记录应至少含反方 4 条（不限制轮数，直到计时结束）')
  // 记录中的发言区间同样两两不重叠（按引擎自己的时间戳）
  const recordedSpeeches = round.stages.flatMap((stage) => stage.speeches).sort((a, b) => a.seq - b.seq)
  assert.equal(recordedSpeeches.length, 5)
  for (let index = 1; index < recordedSpeeches.length; index += 1) {
    assert.ok(
      recordedSpeeches[index].at >= recordedSpeeches[index - 1].endsAt,
      `记录中的发言区间重叠：${recordedSpeeches[index].seq}`,
    )
  }
  assert.ok(round.discussion.pro.length >= 1, '应记录正方讨论')
  assert.ok(round.discussion.con.length >= 1, '应记录反方讨论')
  assert.equal(round.judgeNotes.length, 2, '2 个环节 × 1 位评委 = 2 条评委记录')
  assert.ok(round.judgeNotes.every((note) => note.comment && note.comment.length > 0), '评委记录应有点评')
  assert.ok(round.scores.pro > 0 && round.scores.con > 0, '应产生正反方评分')
  assert.equal(final.scoreboard.pro, round.scores.pro)
  assert.ok(round.summaries.pro.length > 0, '正方教练总结应落库')
  assert.ok(round.summaries.con.length > 0, '反方教练总结应落库')
  assert.ok(round.summaries.admin.length > 0, '管理员评论应落库')
  assert.equal(round.archiveRel, ZIP_NAME)
  assert.equal(records.issueLog.length, 0, `演示模式不应产生回退/错误记录：${JSON.stringify(records.issueLog)}`)
  assert.ok(records.final.summaryMd, 'records.final.summaryMd 应指向汇总 Markdown')
  assert.ok(records.final.docxRel, 'records.final.docxRel 应指向 Word 总结')
  assert.equal(final.recent.length, 7)

  /* ---------------------------- 磁盘产物（§5） ---------------------------- */
  const runDir = path.join(baseDir, final.runId)
  const dirEntries = await fsp.readdir(runDir)
  assert.ok(!dirEntries.includes('第01轮'), `轮次工作目录应被删除，实际：${dirEntries.join(', ')}`)
  assert.ok(dirEntries.includes(ZIP_NAME), `应保留第 1 轮 ZIP，实际：${dirEntries.join(', ')}`)
  assert.ok(dirEntries.includes('rounds-index.json'), '应保留 rounds-index.json')
  assert.ok(dirEntries.includes('state.json'), '应保留 state.json')
  assert.ok(dirEntries.includes('run.json'), '应保留 run.json')
  assert.ok(dirEntries.includes('全部轮次汇总.md'), '最后一轮应生成全部轮次汇总.md')
  const docxName = dirEntries.find((name) => name.startsWith('辩论模拟总结_') && name.endsWith('.docx'))
  assert.ok(docxName, `最后一轮应生成 Word 总结，实际：${dirEntries.join(', ')}`)

  const runJson = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'))
  assert.equal(runJson.runId, final.runId)
  assert.equal(runJson.topic, TOPIC)
  assert.equal(runJson.config.rounds, 1)
  assert.equal(runJson.config.bubbleSeconds, 0.05)
  assert.equal(Array.isArray(runJson.flow), true)
  assert.equal(runJson.flow.length, 2, 'run.json 应保存自定义赛制')

  // 内存里的 done 可能早于最后一次 flushState，这里等 state.json 真正落盘为 done
  const stateDoc = await waitForJson(path.join(runDir, 'state.json'), (doc) => doc.phase === 'done')
  assert.equal(stateDoc.phase, 'done', 'state.json 的落盘状态应为 done')
  assert.equal(stateDoc.active, false)
  assert.ok(stateDoc.records && stateDoc.records.rounds.length === 1, 'state.json 应携带完整记录（供恢复/记录查询）')
  assert.equal(stateDoc.cursor.summaryDone, true)

  const index = JSON.parse(await fsp.readFile(path.join(runDir, 'rounds-index.json'), 'utf8'))
  assert.equal(Array.isArray(index), true)
  assert.equal(index.length, 1)
  assert.equal(index[0].round, 1)
  assert.equal(index[0].archiveRel, ZIP_NAME)
  assert.equal(index[0].topic, TOPIC)
  assert.equal(index[0].stageCount, 2)
  assert.equal(index[0].speechCount, 5)
  assert.equal(index[0].judgeNotesCount, 2)
  assert.ok(index[0].discussionCount >= 8)
  assert.ok(index[0].bytes > 0)
  assert.ok(Array.isArray(index[0].files) && index[0].files.length >= ZIP_EXPECTED_NAMES.length)

  const zipPath = path.join(runDir, ZIP_NAME)
  const zipStat = await fsp.stat(zipPath)
  assert.ok(zipStat.size > 0, 'ZIP 必须存在且非空')
  assert.equal(zipStat.size, index[0].bytes, 'rounds-index.json 记录的字节数应与 ZIP 实际大小一致')
  const zipEntries = readZipEntries(await fsp.readFile(zipPath))
  const zipNames = zipEntries.map((entry) => entry.name)
  for (const expected of ZIP_EXPECTED_NAMES) {
    assert.ok(zipNames.includes(expected), `ZIP 缺少条目：${expected}（实际：${zipNames.join(', ')}）`)
  }
  for (const entry of zipEntries) {
    assert.equal(entry.method, 0, `${entry.name} 应为 store（不压缩）`)
    assert.equal(entry.flags & 0x0800, 0x0800, `${entry.name} 必须置 UTF-8 通用标志位`)
    assert.equal(entry.data.length, entry.size, `${entry.name} 本地数据长度与目录记录不符`)
  }
  const readmeEntry = zipEntries.find((entry) => entry.name === 'README.txt')
  const readmeText = readmeEntry.data.toString('utf8')
  assert.ok(readmeText.includes(TOPIC), 'ZIP 内 README.txt 应包含辩题')
  assert.ok(readmeText.includes(ZIP_NAME), 'ZIP 内 README.txt 应说明归档文件名')
  const speechFile = zipEntries.find((entry) => entry.name === '正方/发言记录.md').data.toString('utf8')
  assert.ok(speechFile.includes(FLOW[0].title), '正方发言记录应包含环节标题')
  assert.ok(speechFile.includes(TOPIC), '正方发言记录应包含辩题')

  const summaryMd = await fsp.readFile(path.join(runDir, '全部轮次汇总.md'), 'utf8')
  assert.ok(summaryMd.includes(TOPIC), '汇总 Markdown 应包含辩题')
  assert.ok(summaryMd.includes('第 1 轮'), '汇总 Markdown 应包含轮次')
  assert.ok(summaryMd.includes('管理员评论'), '汇总 Markdown 应包含管理员评论段')

  // Word 总结：先做 Node 侧结构校验，再用 python-docx 读段落
  const docxBuf = await fsp.readFile(path.join(runDir, docxName))
  const docxParts = readZipEntries(docxBuf).map((entry) => entry.name)
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'docProps/core.xml']) {
    assert.ok(docxParts.includes(part), `Word 总结缺少部件：${part}`)
  }
  const docxReport = readDocxParagraphs(path.join(runDir, docxName))
  if (docxReport) {
    const joined = docxReport.paragraphs.join('\n')
    assert.ok(docxReport.paragraphs.length > 5, 'Word 总结应有多个段落')
    assert.ok(joined.includes(TOPIC), 'Word 总结正文应包含辩题')
    assert.ok(joined.includes('一、轮次总览'), 'Word 总结应包含「轮次总览」章节')
    assert.ok(joined.includes('三、评委评分明细'), 'Word 总结应包含「评委评分明细」章节')
    assert.ok(docxReport.tables >= 2, `Word 总结应至少有 2 个表格（总览 + 评分明细），实际 ${docxReport.tables}`)
  }

  /* ------------------- 重启：已完成 run 不应被当作未完成恢复 ------------------- */
  const engineB = createDemoEngine(baseDir)
  t.after(() => engineB.dispose().catch(() => {}))
  const stateB = await engineB.init()
  assert.equal(stateB.phase, 'idle', '已完成（done）的 run 不应被恢复为 paused')
  assert.equal(stateB.recovered, false)
  assert.equal(stateB.runId, null)
  const runs = engineB.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].phase, 'done')
  assert.equal(runs[0].archiveCount, 1)
  assert.equal(runs[0].topic, TOPIC)
})

test('engine：进程中断后新引擎 init 恢复为 paused，resume-run 可继续跑完并归档', { timeout: RUN_TIMEOUT }, async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-recover-'))
  let engine = null
  // 先 dispose 再删目录：dispose 会 flush state.json，顺序反了就会把目录重新创建出来。
  t.after(async () => {
    if (engine) await engine.dispose().catch(() => {})
    await fsp.rm(baseDir, { recursive: true, force: true })
  })

  // 子进程启动真实引擎，跑到辩论阶段就 process.exit（模拟宿主被杀，state.json 停在 debate）
  const probe = spawnCrashProbe(baseDir)
  assert.equal(
    probe.status,
    0,
    `中断探针子进程失败（status=${probe.status}）：${String(probe.stderr || '').slice(0, 1200)}`,
  )

  const dirNames = (await fsp.readdir(baseDir)).filter((name) => !name.startsWith('.'))
  assert.equal(dirNames.length, 1, `中断后应留下 1 个 run 目录，实际：${dirNames.join(', ')}`)
  const runId = dirNames[0]
  const snapshot = JSON.parse(await fsp.readFile(path.join(baseDir, runId, 'state.json'), 'utf8'))
  assert.equal(snapshot.phase, 'debate', `中断点应停在辩论阶段，实际 ${snapshot.phase}`)
  assert.equal(snapshot.active, true)
  assert.equal(snapshot.phaseDetail, 'debate')

  // 新进程的引擎（这里在同进程新建实例，等价于重启后的 init）应加载并置 paused
  engine = createDemoEngine(baseDir)

  const recovered = await engine.init()
  assert.equal(recovered.runId, runId)
  assert.equal(recovered.phase, 'paused', `恢复后应为 paused，实际 ${recovered.phase}`)
  assert.equal(recovered.phaseLabel, '已暂停')
  assert.equal(recovered.recovered, true, 'recovered 标记应为 true')
  assert.equal(recovered.paused, true)
  assert.equal(recovered.active, true)
  assert.equal(recovered.phaseDetail, 'debate', '应保留中断时真实所处的阶段')
  assert.equal(recovered.topic, 'Crash Restart Probe')
  assert.equal(recovered.round, snapshot.round)
  assert.equal(recovered.stageIndex, snapshot.stageIndex)
  assert.equal(recovered.stageCount, CRASH_FLOW.length)

  const recoveredRecords = engine.getRecords()
  assert.equal(recoveredRecords.rounds.length, 1, '讨论记录应随 state.json 一并恢复')
  assert.ok(recoveredRecords.rounds[0].discussion.pro.length >= 1)
  assert.ok(recoveredRecords.rounds[0].discussion.con.length >= 1)

  const runsBefore = engine.listRuns()
  assert.equal(runsBefore.length, 1)
  assert.notEqual(runsBefore[0].phase, 'idle', '未完成的 run 不应被标记为 idle')

  // 恢复后继续：resume-run 重新启动循环，跑完剩余环节并归档
  const resumed = await engine.control('resume-run')
  assert.equal(resumed.paused, false)
  assert.equal(resumed.recovered, false)
  assert.equal(resumed.active, true)

  const final = await waitForState(engine, (state) => state.phase === 'done' || state.phase === 'error')
  assert.equal(final.phase, 'done', `恢复后未跑完：phase=${final.phase} error=${final.error || 'none'}`)
  assert.equal(final.error, null, `恢复后运行出错：${final.error}`)
  assert.equal(final.runId, runId, '恢复运行应沿用原 runId')
  assert.equal(final.agents.alive, 0)

  const runDir = path.join(baseDir, runId)
  const entries = await fsp.readdir(runDir)
  assert.ok(entries.includes(ZIP_NAME), `恢复后应生成第 1 轮 ZIP，实际：${entries.join(', ')}`)
  assert.ok(!entries.includes('第01轮'), `恢复后轮次工作目录仍应被清理，实际：${entries.join(', ')}`)
  assert.ok(entries.includes('rounds-index.json'))
  assert.ok(
    entries.some((name) => name.startsWith('辩论模拟总结_') && name.endsWith('.docx')),
    '恢复后跑完末轮应生成 Word 总结',
  )
  const index = JSON.parse(await fsp.readFile(path.join(runDir, 'rounds-index.json'), 'utf8'))
  assert.equal(index.length, 1)
  assert.equal(index[0].round, 1)
  assert.ok(index[0].speechCount >= 5, `恢复后应补齐 5 条发言，实际 ${index[0].speechCount}`)
})

/* ------------------------------ 中断探针 ------------------------------ */

function spawnCrashProbe(baseDir) {
  const engineUrl = pathToFileURL(path.join(ROOT, 'lib', 'host', 'engine.js')).href
  const simulateUrl = pathToFileURL(path.join(ROOT, 'lib', 'host', 'simulate.js')).href
  const code = `
import fs from 'node:fs'
import path from 'node:path'
import { createEngine } from ${JSON.stringify(engineUrl)}
import { createRoster, createSimulator } from ${JSON.stringify(simulateUrl)}

const baseDir = process.argv[1]
const engine = createEngine({
  baseDir,
  config: { mode: 'demo', llmTimeoutMs: 5000 },
  createRoster,
  createSimulator: (options) => createSimulator({ ...options, mode: 'demo', llm: null, model: null }),
})
await engine.init()
const state = await engine.start({
  topic: 'Crash Restart Probe',
  config: {
    rounds: 1,
    bubbleSeconds: 0.3,
    discussionSeconds: 1,
    judges: 1,
    timeScale: 60,
    mode: 'demo',
    customFlow: ${JSON.stringify(CRASH_FLOW)},
  },
})
const file = path.join(baseDir, state.runId, 'state.json')
const deadline = Date.now() + 20000
while (Date.now() < deadline) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (doc.phase === 'debate' && doc.active === true) process.exit(0)
  } catch {
    /* state.json 还没写完，继续等 */
  }
  await new Promise((resolve) => setTimeout(resolve, 15))
}
process.exit(3)
`
  return spawnSync(NODE, ['--input-type=module', '-e', code, baseDir], {
    encoding: 'utf8',
    timeout: 40000,
    env: { ...process.env },
  })
}
