/**
 * 运行目录持久化：run.json / state.json（防抖 ≤300ms）/ rounds-index.json / 运行列表。
 * 契约见 docs/CONTRACT.md §2.4 / §5。
 *
 * 本模块只负责「读写磁盘 + 防抖」，不解释业务字段；state.json 由引擎传入完整文档
 * （PublicState 超集：publicState + records + cursor + flow），因此恢复时不需要回读
 * 已删除的「第NN轮/」目录。
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { ensureDir, readJsonFile } from './archive.js'

export const STATE_VERSION = 1
export const SAVE_DEBOUNCE_MS = 250
export const RUNS_LIMIT = 20

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function sleep(ms) {
  // 注意：重试 sleep 不能被 unref，否则进程会在事件循环空转时提前退出，
  // 让正在 await 的落盘 promise 永远悬空（表现为 unsettled top-level await）。
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms))
  })
}

/**
 * 原子写 JSON（Windows 上 rename 偶发 EPERM：杀毒/索引占用句柄）。
 * 策略：rename 重试 → copyFile 覆盖 → 直接写；三者都不留 .tmp 残留。
 */
async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.byteLength(text, 'utf8')
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  await fsp.writeFile(tmp, text, 'utf8')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rename(tmp, filePath)
      return bytes
    } catch {
      await sleep(15 * (attempt + 1))
    }
  }
  // rename 被占用：用 copyFile 覆盖（Windows 上更宽容），失败再直写。
  try {
    await fsp.copyFile(tmp, filePath)
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return bytes
  } catch {
    await fsp.writeFile(filePath, text, 'utf8')
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return bytes
  }
}

function metaFrom(dirName, run, state) {
  const phase = state?.phase || run?.phase || 'idle'
  const zips = Array.isArray(state?.archive?.zips) ? state.archive.zips : []
  return {
    runId: state?.runId || run?.runId || dirName,
    topic: state?.topic || run?.topic || '',
    created: Number(state?.created || run?.created || 0) || 0,
    updated: Number(state?.updated || 0) || 0,
    phase,
    round: Number(state?.round || 0) || 0,
    rounds: Number(state?.rounds || run?.config?.rounds || 0) || 0,
    active: state?.active === true,
    recovered: state?.recovered === true,
    mode: state?.mode || run?.config?.mode || 'ai',
    archiveCount: zips.length,
    finalDocx: state?.archive?.finalDocx?.name || null,
    dir: dirName,
  }
}

/**
 * @param {{baseDir:string, logger?:Function, debounceMs?:number}} options
 */
export function createStore(options = {}) {
  const baseDir = path.resolve(String(options.baseDir ?? path.join(process.cwd(), 'debate-runs')))
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const debounceMs = clampNumber(options.debounceMs ?? SAVE_DEBOUNCE_MS, 50, 300, SAVE_DEBOUNCE_MS)

  let timer = null
  let pending = null
  let chain = Promise.resolve()
  let lastError = null
  let closed = false

  function dirFor(runId) {
    return path.join(baseDir, String(runId))
  }

  function statePath(runId) {
    return path.join(dirFor(runId), 'state.json')
  }

  function runPath(runId) {
    return path.join(dirFor(runId), 'run.json')
  }

  function roundsIndexPath(runId) {
    return path.join(dirFor(runId), 'rounds-index.json')
  }

  async function ensureRunDir(runId) {
    await ensureDir(dirFor(runId))
    return dirFor(runId)
  }

  async function writeRun(runId, meta) {
    await ensureRunDir(runId)
    await writeJsonAtomic(runPath(runId), meta)
    return runPath(runId)
  }

  async function readRun(runId) {
    return readJsonFile(runPath(runId), null)
  }

  async function readState(runId) {
    return readJsonFile(statePath(runId), null)
  }

  async function writeStateNow(runId, doc) {
    await ensureRunDir(runId)
    return writeJsonAtomic(statePath(runId), doc)
  }

  /**
   * 防抖保存：同一时刻只保留最后一次快照；写盘串行执行。
   * @param {string} runId
   * @param {() => object} getDoc 返回可 JSON 序列化的完整文档
   */
  function schedule(runId, getDoc) {
    if (closed) return
    pending = { runId: String(runId), getDoc }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flush().catch((err) => logger('[debate] state flush failed', err?.message || err))
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 立即落盘（阶段边界 / 归档前强制调用）。 */
  async function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (pending) {
      const job = pending
      pending = null
      const run = async () => {
        try {
          await writeStateNow(job.runId, job.getDoc())
          lastError = null
        } catch (err) {
          lastError = err
          logger('[debate] state save failed:', err?.message || err)
        }
      }
      chain = chain.then(run, run)
      await chain
    }
    return lastError
  }

  async function close() {
    await flush()
    closed = true
  }

  async function listRuns(limit = RUNS_LIMIT) {
    let entries = []
    try {
      entries = await fsp.readdir(baseDir, { withFileTypes: true })
    } catch {
      return []
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    const metas = []
    for (const name of names) {
      const run = await readJsonFile(runPath(name), null)
      const state = await readJsonFile(statePath(name), null)
      if (!run && !state) continue
      metas.push(metaFrom(name, run, state))
    }
    metas.sort((a, b) => (b.created - a.created) || String(b.runId).localeCompare(String(a.runId)))
    return metas.slice(0, Math.max(1, limit))
  }

  async function loadRun(runId) {
    const run = await readJsonFile(runPath(runId), null)
    const state = await readJsonFile(statePath(runId), null)
    if (!run && !state) return null
    return { run, state }
  }

  async function readRoundsIndex(runId) {
    const value = await readJsonFile(roundsIndexPath(runId), [])
    return Array.isArray(value) ? value : []
  }

  async function writeRoundsIndex(runId, list) {
    await ensureRunDir(runId)
    await writeJsonAtomic(roundsIndexPath(runId), Array.isArray(list) ? list : [])
  }

  async function removeRunDir(runId) {
    await fsp.rm(dirFor(runId), { recursive: true, force: true, maxRetries: 3 })
  }

  /** 清理历史写入遗留的 .tmp-* 文件（进程被杀/rename 失败时会留下）。 */
  async function cleanTmpFiles(runId) {
    try {
      const entries = await fsp.readdir(dirFor(runId))
      await Promise.all(
        entries
          .filter((name) => /\.tmp-\d+-\d+/.test(name))
          .map((name) => fsp.rm(path.join(dirFor(runId), name), { force: true }).catch(() => {})),
      )
    } catch {
      /* 目录还不存在：无需清理 */
    }
  }

  return {
    baseDir,
    debounceMs,
    dirFor,
    statePath,
    runPath,
    roundsIndexPath,
    ensureRunDir,
    writeRun,
    readRun,
    readState,
    writeStateNow,
    schedule,
    flush,
    close,
    listRuns,
    loadRun,
    readRoundsIndex,
    writeRoundsIndex,
    removeRunDir,
    cleanTmpFiles,
  }
}
