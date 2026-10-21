/**
 * 引擎产物落盘辅助：草稿纸 / 讨论记录 / 发言记录 / 分析材料 / 总结 /
 * 评委记录 / 计分板 / 管理员评论 / README / 全部轮次汇总 / DOCX 模型。
 * 契约见 docs/CONTRACT.md §5 / §6。
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { ensureDir, buildDocx, slugify, formatBytes } from './archive.js'

function sleep(ms) {
  // 注意：重试 sleep 不能被 unref，否则进程会在事件循环空转时提前退出，
  // 让正在 await 的落盘 promise 永远悬空（表现为 unsettled top-level await）。
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms))
  })
}

/** 原子写文本（Windows 上 rename 偶发 EPERM，带重试与降级直写）。 */
async function writeTextRobust(filePath, text) {
  await ensureDir(path.dirname(filePath))
  const body = String(text ?? '')
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  await fsp.writeFile(tmp, body, 'utf8')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rename(tmp, filePath)
      return Buffer.byteLength(body, 'utf8')
    } catch {
      await sleep(15 * (attempt + 1))
    }
  }
  try {
    await fsp.copyFile(tmp, filePath)
  } catch {
    await fsp.writeFile(filePath, body, 'utf8')
  }
  await fsp.rm(tmp, { force: true }).catch(() => {})
  return Buffer.byteLength(body, 'utf8')
}

/** 原子写二进制（DOCX）。 */
async function writeBufferRobust(filePath, buffer) {
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  await fsp.writeFile(tmp, buffer)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rename(tmp, filePath)
      return buffer.length
    } catch {
      await sleep(15 * (attempt + 1))
    }
  }
  try {
    await fsp.copyFile(tmp, filePath)
  } catch {
    await fsp.writeFile(filePath, buffer)
  }
  await fsp.rm(tmp, { force: true }).catch(() => {})
  return buffer.length
}

export const SIDE_LABEL = { pro: '正方', con: '反方' }

export function sideLabel(side) {
  return SIDE_LABEL[side] || '中立'
}

export function pad2(value) {
  return String(Math.max(0, Math.trunc(Number(value) || 0))).padStart(2, '0')
}

export function roundDirName(round) {
  return `第${pad2(round)}轮`
}

export function zipName(round) {
  return `${roundDirName(round)}_辩论归档.zip`
}

/** 本轮产物路径表。 */
export function roundPaths(runDir, round) {
  const dir = path.join(runDir, roundDirName(round))
  return {
    round,
    dir,
    zipFile: path.join(runDir, zipName(round)),
    sideDir: (side) => path.join(dir, sideLabel(side)),
    sideFile: (side, name) => path.join(dir, sideLabel(side), name),
    judgeDir: path.join(dir, '评委'),
    judgeFile: (name) => path.join(dir, '评委', name),
    adminFile: path.join(dir, '管理员评论.md'),
    readmeFile: path.join(dir, 'README.txt'),
  }
}

export function fmtClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`
}

export function fmtTime(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function fmtDateTime(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTime(n)}`
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function blockQuote(value) {
  const body = text(value) || '（无内容）'
  return body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

function list(items, fallback = '（无）') {
  const arr = (Array.isArray(items) ? items : []).filter((item) => text(item))
  if (arr.length === 0) return `- ${fallback}`
  return arr.map((item) => `- ${text(item)}`).join('\n')
}

/* ------------------------------ 单侧产物 ------------------------------- */

/** 草稿纸：讨论阶段形成的论点/论据，后续发言可复用。 */
export function renderDraftPaper({ topic, side, round, now, material, points, discussionSummary }) {
  const lines = [
    `# ${sideLabel(side)} · 草稿纸（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 立场：${sideLabel(side)}`,
    `- 更新：${fmtDateTime(now)}`,
    '',
    '## 一、立论骨架',
    '',
    list(points),
    '',
    '## 二、讨论阶段要点',
    '',
    blockQuote(discussionSummary || material || '讨论阶段尚未产生要点。'),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function writeDraftPaper(filePath, data) {
  await writeTextRobust(filePath, renderDraftPaper(data))
}

/** 讨论记录：本方言行全量。 */
export function renderDiscussionRecord({ topic, side, round, seconds, wallSeconds, turns, summary }) {
  const list2 = Array.isArray(turns) ? turns : []
  const lines = [
    `# ${sideLabel(side)} · 讨论记录（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 限时：${fmtClock(seconds)}（墙钟 ${fmtClock(wallSeconds)}）`,
    `- 发言数：${list2.length}`,
    '',
    '## 发言',
    '',
  ]
  if (list2.length === 0) lines.push('（无发言）', '')
  list2.forEach((turn, index) => {
    lines.push(`### ${index + 1}. ${text(turn.speakerName) || '辩手'} · ${fmtTime(turn.at)}`, '', blockQuote(turn.text), '')
  })
  lines.push('## 讨论小结', '', blockQuote(summary || '（无小结）'), '')
  return `${lines.join('\n')}\n`
}

export async function writeDiscussionRecord(filePath, data) {
  await writeTextRobust(filePath, renderDiscussionRecord(data))
}

/** 发言记录：按环节分组的本方言行。 */
export function renderSpeechRecord({ topic, side, round, stages, now, coachText }) {
  const lines = [
    `# ${sideLabel(side)} · 发言记录（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 更新：${fmtDateTime(now)}`,
    '',
  ]
  const stageList = Array.isArray(stages) ? stages : []
  let count = 0
  for (const stage of stageList) {
    const speeches = (stage.speeches || []).filter((speech) => speech.side === side)
    if (speeches.length === 0) continue
    lines.push(`## 环节 ${stage.stageIndex + 1}：${text(stage.title) || '未命名环节'}`, '')
    for (const speech of speeches) {
      count += 1
      lines.push(
        `### ${text(speech.speakerName) || '辩手'} · ${fmtTime(speech.at)}`,
        '',
        blockQuote(speech.text),
        '',
      )
    }
  }
  if (count === 0) lines.push('（本环节尚未产生发言）', '')
  const coach = text(coachText)
  if (coach) lines.push('## 教练总结', '', blockQuote(coach), '')
  return `${lines.join('\n')}\n`
}

export async function writeSpeechRecord(filePath, data) {
  await writeTextRobust(filePath, renderSpeechRecord(data))
}

/** 分析材料：本方可用的赛制说明、对手信息与讨论沉淀（不含评委记录）。 */
export function renderAnalysisMaterial({ topic, side, round, flow, material, discussionSummary }) {
  const lines = [
    `# ${sideLabel(side)} · 分析材料（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 立场：${sideLabel(side)}`,
    '',
    '## 一、赛制与时间',
    '',
  ]
  const stages = Array.isArray(flow) ? flow : []
  if (stages.length === 0) lines.push('- （未配置赛制）')
  stages.forEach((stage, index) => {
    lines.push(`- 环节 ${index + 1}：${text(stage.title)}（${stage.seconds} 秒${stage.perSide ? '，双方各自计时' : ''}）`)
  })
  lines.push('', '## 二、我方素材', '', blockQuote(material || '（无补充材料）'), '')
  lines.push('## 三、讨论沉淀', '', blockQuote(discussionSummary || '（讨论阶段尚未产生沉淀）'), '')
  return `${lines.join('\n')}\n`
}

export async function writeAnalysisMaterial(filePath, data) {
  await writeTextRobust(filePath, renderAnalysisMaterial(data))
}

/** 教练总结。 */
export function renderCoachSummary({ topic, side, round, text: body, analysis, scoreboard }) {
  const lines = [
    `# ${sideLabel(side)} · 第${pad2(round)}轮总结`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 当前比分：正方 ${Number(scoreboard?.pro) || 0} : ${Number(scoreboard?.con) || 0} 反方`,
    '',
    '## 一、总结陈词',
    '',
    blockQuote(body || '（教练未产出内容）'),
    '',
  ]
  const extra = text(analysis)
  if (extra) lines.push('## 二、复盘分析', '', blockQuote(extra), '')
  return `${lines.join('\n')}\n`
}

export async function writeCoachSummary(filePath, data) {
  await writeTextRobust(filePath, renderCoachSummary(data))
}

/* ------------------------------ 评委产物 ------------------------------- */

export function renderJudgeRecord({ topic, round, notes, now }) {
  const lines = [
    `# 评委记录（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 更新：${fmtDateTime(now)}`,
    '',
  ]
  const list3 = Array.isArray(notes) ? notes : []
  if (list3.length === 0) lines.push('（暂无评分记录）', '')
  list3.forEach((note) => {
    lines.push(
      `## 环节 ${Number(note.stageIndex) + 1} · ${text(note.stageTitle) || ''}`,
      '',
      `### ${text(note.judgeName) || '评委'} · ${fmtTime(note.at)}`,
      '',
      `- 正方：${Number(note.pro) || 0}`,
      `- 反方：${Number(note.con) || 0}`,
    )
    const findings = (note.findings || []).filter((item) => text(item))
    if (findings.length) {
      lines.push('- 要点：', ...findings.map((item) => `  - ${text(item)}`))
    }
    lines.push('', blockQuote(note.comment || '（无点评）'), '')
  })
  return `${lines.join('\n')}\n`
}

export async function writeJudgeRecord(filePath, data) {
  await writeTextRobust(filePath, renderJudgeRecord(data))
}

export function renderScoreboard({ topic, round, history, judges, pro, con, now }) {
  const lines = [
    `# 计分板（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 更新：${fmtDateTime(now)}`,
    `- 当前：正方 ${Number(pro) || 0} : ${Number(con) || 0} 反方`,
    '',
    '## 评委',
    '',
    '| 评委 | 正方 | 反方 |',
    '| --- | --- | --- |',
  ]
  const judgeList = Array.isArray(judges) ? judges : []
  if (judgeList.length === 0) lines.push('| （暂无评委） | 0 | 0 |')
  judgeList.forEach((judge) => {
    lines.push(`| ${text(judge.name) || judge.id} | ${Number(judge.scorePro) || 0} | ${Number(judge.scoreCon) || 0} |`)
  })
  lines.push('', '## 环节评分', '', '| 环节 | 评委 | 正方 | 反方 | 点评 |', '| --- | --- | --- | --- | --- |')
  const list4 = Array.isArray(history) ? history : []
  if (list4.length === 0) lines.push('| — | — | 0 | 0 | （暂无） |')
  list4.forEach((item) => {
    lines.push(
      `| ${Number(item.stageIndex) + 1}. ${text(item.stageTitle) || ''} | ${text(item.judgeName) || '评委'} | ${Number(item.pro) || 0} | ${Number(item.con) || 0} | ${text(item.comment).replace(/\|/g, '/').slice(0, 60) || '—'} |`,
    )
  })
  return `${lines.join('\n')}\n`
}

export async function writeScoreboard(filePath, data) {
  await writeTextRobust(filePath, renderScoreboard(data))
}

/* ---------------------------- 管理员 / README -------------------------- */

export function renderAdminComment({ topic, round, rounds, adminText, scoreboard, issues, now }) {
  const lines = [
    `# 管理员评论（第${pad2(round)}轮）`,
    '',
    `- 辩题：${text(topic) || '—'}`,
    `- 轮次：第 ${round} / ${rounds} 轮`,
    `- 时间：${fmtDateTime(now)}`,
    `- 比分：正方 ${Number(scoreboard?.pro) || 0} : ${Number(scoreboard?.con) || 0} 反方`,
    '',
    '## 评论',
    '',
    blockQuote(adminText || '（管理员未产出评论）'),
    '',
  ]
  const list5 = (Array.isArray(issues) ? issues : []).filter((item) => text(item))
  if (list5.length) lines.push('## 运行提示', '', list5.map((item) => `- ${text(item)}`).join('\n'), '')
  return `${lines.join('\n')}\n`
}

export async function writeAdminComment(filePath, data) {
  await writeTextRobust(filePath, renderAdminComment(data))
}

export function renderRoundReadme(data) {
  const {
    topic, runId, round, rounds, mode, createdAt, scores, stageCount, speechCount, judgeCount,
    files, zipName: zip, coachLines, adminComment,
  } = data
  const lines = [
    '辩论模拟 · 轮次归档说明',
    '================================',
    '',
    `辩题：${text(topic) || '—'}`,
    `运行 ID：${text(runId) || '—'}`,
    `轮次：第 ${round} / ${rounds} 轮`,
    `模式：${mode === 'demo' ? '演示模式' : mode === 'mixed' ? '混合模式' : 'AI 模式'}`,
    `开始时间：${fmtDateTime(createdAt)}`,
    `比分：正方 ${Number(scores?.pro) || 0} : ${Number(scores?.con) || 0} 反方`,
    `环节数：${stageCount || 0} · 发言数：${speechCount || 0} · 评委数：${judgeCount || 0}`,
    '',
    '包内文件',
    '--------------------------------',
  ]
  const list6 = Array.isArray(files) ? files : []
  if (list6.length === 0) lines.push('  （无文件）')
  list6.forEach((file) => {
    lines.push(`  ${file.name}  (${formatBytes(file.bytes || 0)})`)
  })
  lines.push('', '教练总结摘要', '--------------------------------')
  const coaches = Array.isArray(coachLines) ? coachLines : []
  if (coaches.length === 0) lines.push('  （无）')
  coaches.forEach((item) => lines.push(`  ${item.side}：${text(item.text).slice(0, 200) || '（无）'}`))
  lines.push('', '管理员评论摘要', '--------------------------------')
  lines.push(`  ${text(adminComment).slice(0, 400) || '（无）'}`, '')
  lines.push(`归档文件：${zip || '—'}`, '')
  lines.push('说明：本轮「第NN轮/」临时目录已在打包后删除；原始文件全部包含在本 ZIP 内。', '')
  return `${lines.join('\n')}\n`
}

export async function writeRoundReadme(filePath, data) {
  const body = renderRoundReadme(data)
  await writeTextRobust(filePath, body)
  return body
}

/* --------------------------- 全部轮次汇总 ------------------------------ */

function judgeSummaryLines(roundRecord) {
  const notes = Array.isArray(roundRecord?.judgeNotes) ? roundRecord.judgeNotes : []
  if (notes.length === 0) return ['- （本轮无评委记录）']
  return notes.map(
    (note) =>
      `- 环节 ${Number(note.stageIndex) + 1}（${note.judgeName || '评委'}）：正方 ${Number(note.pro) || 0} / 反方 ${Number(note.con) || 0} — ${text(note.comment).slice(0, 120) || '无点评'}`,
  )
}

export function buildAllRoundsMd({ topic, runId, records, roundsIndex, config, createdAt, finishedAt }) {
  const rounds = Array.isArray(records?.rounds) ? records.rounds : []
  const index = Array.isArray(roundsIndex) ? roundsIndex : []
  const last = rounds[rounds.length - 1]
  const lines = [
    `# 辩论模拟全程汇总 · ${text(topic) || '未命名辩题'}`,
    '',
    `- 运行 ID：${text(runId) || '—'}`,
    `- 创建时间：${fmtDateTime(createdAt)}`,
    `- 完成时间：${fmtDateTime(finishedAt)}`,
    `- 轮次：${rounds.length || config?.rounds || 0} 轮`,
    `- 模式：${config?.mode === 'demo' ? '演示模式' : 'AI 模式'} · 气泡 ${config?.bubbleSeconds ?? '—'} 秒 · 讨论 ${config?.discussionSeconds ?? '—'} 秒 · 节奏 ×${config?.timeScale ?? 1}`,
    `- 末轮比分：正方 ${Number(last?.scores?.pro) || 0} : ${Number(last?.scores?.con) || 0} 反方`,
    '',
    '## 一、轮次总览',
    '',
    '| 轮次 | 正方 | 反方 | 发言数 | 评委记录 | 归档文件 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  if (rounds.length === 0) lines.push('| — | 0 | 0 | 0 | 0 | — |')
  rounds.forEach((roundRecord) => {
    const speechCount = (roundRecord.stages || []).reduce((sum, stage) => sum + (stage.speeches || []).length, 0)
    const archive = roundRecord.archiveRel || index.find((item) => item.round === roundRecord.round)?.archiveRel || '—'
    lines.push(
      `| 第 ${roundRecord.round} 轮 | ${Number(roundRecord.scores?.pro) || 0} | ${Number(roundRecord.scores?.con) || 0} | ${speechCount} | ${(roundRecord.judgeNotes || []).length} | ${archive} |`,
    )
  })
  lines.push('')

  rounds.forEach((roundRecord) => {
    lines.push(`## 第 ${roundRecord.round} 轮`, '')
    lines.push(`- 比分：正方 ${Number(roundRecord.scores?.pro) || 0} : ${Number(roundRecord.scores?.con) || 0} 反方`)
    const discussionPro = (roundRecord.discussion?.pro || []).length
    const discussionCon = (roundRecord.discussion?.con || []).length
    lines.push(`- 讨论发言：正方 ${discussionPro} 条 / 反方 ${discussionCon} 条`)
    const archiveEntry = index.find((item) => item.round === roundRecord.round)
    if (archiveEntry?.archiveRel) lines.push(`- 归档：${archiveEntry.archiveRel}（${formatBytes(archiveEntry.bytes || 0)}）`)
    lines.push('', '### 评委记录', '', ...judgeSummaryLines(roundRecord), '')
    const summaries = roundRecord.summaries || {}
    lines.push('### 正方教练总结', '', blockQuote(summaries.pro || '（无）'), '')
    lines.push('### 反方教练总结', '', blockQuote(summaries.con || '（无）'), '')
    lines.push('### 管理员评论', '', blockQuote(summaries.admin || '（无）'), '')
    lines.push('### 环节发言索引', '')
    ;(roundRecord.stages || []).forEach((stage) => {
      const speeches = stage.speeches || []
      const names = speeches.map((speech) => `${speech.speakerName}（${speech.side === 'pro' ? '正' : '反'}）`).join('、')
      lines.push(`- 环节 ${Number(stage.stageIndex) + 1}：${stage.title} — ${speeches.length} 条${names ? `：${names}` : ''}`)
    })
    lines.push('')
  })

  lines.push('## 二、产物清单', '')
  lines.push('- 每轮归档：`第NN轮_辩论归档.zip`（含管理员评论、正方/、反方/、评委/、README.txt）')
  const docx = records?.final?.docxRel
  if (docx) lines.push(`- Word 总结：\`${docx}\``)
  lines.push('- 轮次索引：`rounds-index.json`')
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function buildDocxModel({ topic, runId, records, roundsIndex, config, createdAt, finishedAt }) {
  const rounds = Array.isArray(records?.rounds) ? records.rounds : []
  const index = Array.isArray(roundsIndex) ? roundsIndex : []
  const sections = []
  const overviewRows = rounds.map((roundRecord) => {
    const speechCount = (roundRecord.stages || []).reduce((sum, stage) => sum + (stage.speeches || []).length, 0)
    return [
      `第 ${roundRecord.round} 轮`,
      String(Number(roundRecord.scores?.pro) || 0),
      String(Number(roundRecord.scores?.con) || 0),
      String(speechCount),
      String((roundRecord.judgeNotes || []).length),
    ]
  })
  sections.push({
    heading: '一、轮次总览',
    paragraphs: [
      `辩题：${topic}`,
      `运行 ID：${runId}`,
      `模式：${config?.mode === 'demo' ? '演示模式' : 'AI 模式'}，轮次 ${rounds.length}，气泡 ${config?.bubbleSeconds ?? '—'} 秒，讨论 ${config?.discussionSeconds ?? '—'} 秒。`,
      `生成时间：${fmtDateTime(finishedAt)}`,
    ],
    table: {
      headers: ['轮次', '正方', '反方', '发言数', '评委记录'],
      rows: overviewRows.length ? overviewRows : [['—', '0', '0', '0', '0']],
    },
  })
  for (const roundRecord of rounds) {
    const summaries = roundRecord.summaries || {}
    const stageLines = (roundRecord.stages || []).map((stage) => {
      const speeches = stage.speeches || []
      return `环节 ${Number(stage.stageIndex) + 1}「${stage.title}」：${speeches.length} 条发言`
    })
    const archiveEntry = index.find((item) => item.round === roundRecord.round)
    sections.push({
      heading: `二、第 ${roundRecord.round} 轮`,
      paragraphs: [
        `比分：正方 ${Number(roundRecord.scores?.pro) || 0} : ${Number(roundRecord.scores?.con) || 0} 反方`,
        `归档：${archiveEntry?.archiveRel || roundRecord.archiveRel || '—'}`,
        ...stageLines,
      ],
      bullets: [
        `正方教练总结：${text(summaries.pro).slice(0, 400) || '（无）'}`,
        `反方教练总结：${text(summaries.con).slice(0, 400) || '（无）'}`,
        `管理员评论：${text(summaries.admin).slice(0, 400) || '（无）'}`,
      ],
    })
  }
  const judgeRows = []
  for (const roundRecord of rounds) {
    for (const note of roundRecord.judgeNotes || []) {
      judgeRows.push([
        `第 ${roundRecord.round} 轮`,
        `环节 ${Number(note.stageIndex) + 1}`,
        note.judgeName || '评委',
        String(Number(note.pro) || 0),
        String(Number(note.con) || 0),
        text(note.comment).slice(0, 80) || '—',
      ])
    }
  }
  sections.push({
    heading: '三、评委评分明细',
    paragraphs: ['全部环节的正反方绝对分与点评摘要如下。'],
    table: {
      headers: ['轮次', '环节', '评委', '正方', '反方', '点评'],
      rows: judgeRows.length ? judgeRows : [['—', '—', '—', '0', '0', '—']],
    },
  })
  sections.push({
    heading: '四、归档产物',
    bullets: index.map((item) => `${item.archiveRel || zipName(item.round)}（${formatBytes(item.bytes || 0)}）`).concat(['rounds-index.json', '全部轮次汇总.md']),
  })
  return {
    title: `辩论模拟总结：${topic}`,
    subtitle: `${runId} · ${fmtDateTime(finishedAt)}`,
    sections,
    footer: '由 DSH 辩论模拟插件生成',
  }
}

/** 最后一轮：写「全部轮次汇总.md」+「辩论模拟总结_<slug>.docx」。 */
export async function writeFinalArtifacts(data) {
  const { runDir, topic, slug } = data
  await ensureDir(runDir)
  const summaryName = '全部轮次汇总.md'
  const summaryPath = path.join(runDir, summaryName)
  const summaryText = buildAllRoundsMd(data)
  await writeTextRobust(summaryPath, summaryText)
  const docxName = `辩论模拟总结_${slugify(slug || topic, 'debate')}.docx`
  const docxPath = path.join(runDir, docxName)
  const buffer = buildDocx(buildDocxModel(data))
  await writeBufferRobust(docxPath, buffer)
  return {
    summaryMd: { name: summaryName, rel: summaryName, bytes: Buffer.byteLength(summaryText, 'utf8') },
    finalDocx: { name: docxName, rel: docxName, bytes: buffer.length },
  }
}
