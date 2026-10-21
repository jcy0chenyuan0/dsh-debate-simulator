/**
 * Host HTTP API（供 Client GUI 与工具共用）。契约见 docs/CONTRACT.md §3。
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { safeJoin, formatBytes } from './archive.js'
import {
  validateFlow,
  defaultFlow,
  DEFAULT_ROUNDS,
  DEFAULT_BUBBLE_SECONDS,
  DEFAULT_DISCUSSION_SECONDS,
  MAX_ROUNDS,
} from './flow.js'

const PREFIX = '/api/dsh-debate'

const MIME = {
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function sendJson(res, status, value) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error || '未知错误') })
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 归一化启动参数；错误直接 throw（调用方转 400）。 */
export function normalizeStart(body, defaults = {}) {
  const input = body && typeof body === 'object' ? body : {}
  const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
  if (!topic) throw new Error('请先输入辩题')
  if (topic.length > 200) throw new Error('辩题不能超过 200 字')
  const raw = input.config && typeof input.config === 'object' ? input.config : {}
  const config = {
    rounds: clampNumber(raw.rounds ?? defaults.rounds, 1, MAX_ROUNDS, DEFAULT_ROUNDS),
    bubbleSeconds: clampNumber(raw.bubbleSeconds ?? defaults.bubbleSeconds, 1, 120, DEFAULT_BUBBLE_SECONDS),
    discussionSeconds: clampNumber(raw.discussionSeconds ?? defaults.discussionSeconds, 30, 1800, DEFAULT_DISCUSSION_SECONDS),
    judges: clampNumber(raw.judges ?? defaults.judges, 1, 3, 1),
    timeScale: clampNumber(raw.timeScale ?? defaults.timeScale, 1, 60, 2),
    mode: 'ai',
    provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim().slice(0, 80) : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim().slice(0, 120) : null,
    reasoningEffort: typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() ? raw.reasoningEffort.trim().slice(0, 40) : null,
    apiBaseUrl: typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim() ? raw.apiBaseUrl.trim().slice(0, 300) : null,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim().slice(0, 4000) : null,
    trainingSide: raw.trainingSide === 'pro' || raw.trainingSide === 'con' ? raw.trainingSide : 'none',
    simpleMode: raw.simpleMode === true,
    loadFlow: raw.loadFlow !== false,
    maxIterations: 6,
    prompts: raw.prompts && typeof raw.prompts === 'object' ? {
      debater: typeof raw.prompts.debater === 'string' ? raw.prompts.debater.trim().slice(0, 4000) || null : null,
      judge: typeof raw.prompts.judge === 'string' ? raw.prompts.judge.trim().slice(0, 4000) || null : null,
      coach: typeof raw.prompts.coach === 'string' ? raw.prompts.coach.trim().slice(0, 4000) || null : null,
      agents: raw.prompts.agents && typeof raw.prompts.agents === 'object'
        ? Object.fromEntries(Object.entries(raw.prompts.agents)
          .filter(([key, value]) => typeof key === 'string' && typeof value === 'string' && value.trim())
          .slice(0, 32)
          .map(([key, value]) => [key.slice(0, 60), value.trim().slice(0, 2000)]))
        : null,
    } : null,
    customFlow: null,
  }
  // 轮次即总轮次上限；训练模式达到目标会提前结束。
  if (raw.customFlow != null) {
    const result = validateFlow(raw.customFlow)
    if (!result.ok) throw new Error(`自定义赛制有误：${result.errors.join('；')}`)
    config.customFlow = result.flow
  }
  return { topic, config }
}

export function registerRoutes(ctx, options) {
  const { version, config, getDefaultEngine, defaultBaseDir, logger, getToolStatus } = options

  const route = (pathname, handler) => {
    const safe = async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger?.('route error', pathname, error)
        if (!res.headersSent) sendError(res, 500, error)
        else res.destroy()
      }
    }
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: pathname, handler: safe }),
      `debate-sim route ${pathname}`,
    )
  }

  route(`${PREFIX}/health`, async (req, res) => {
    const engine = await getDefaultEngine().catch(() => null)
    sendJson(res, 200, {
      ok: true,
      version,
      baseDir: engine?.baseDir ?? defaultBaseDir(),
      active: Boolean(engine?.getState?.().active),
      tool: Boolean(ctx.get('tools')?.get?.('debate_simulation')),
      toolDebug: getToolStatus?.() ?? null,
      sim: engine?.sim?.info?.() ?? null,
    })
  })

  route(`${PREFIX}/state`, async (req, res) => {
    const engine = await getDefaultEngine()
    sendJson(res, 200, { ok: true, state: engine.getState() })
  })

  route(`${PREFIX}/runs`, async (req, res) => {
    const engine = await getDefaultEngine()
    sendJson(res, 200, { ok: true, runs: engine.listRuns() })
  })

  route(`${PREFIX}/records`, async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const engine = await getDefaultEngine()
    const records = engine.getRecords(url.searchParams.get('runId') || undefined)
    sendJson(res, 200, { ok: true, records })
  })

  route(`${PREFIX}/start`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const body = await readBody(req)
    let settings
    try {
      settings = normalizeStart(body, config)
    } catch (error) {
      return sendError(res, 400, error)
    }
    const engine = await getDefaultEngine()
    const state = await engine.start(settings)
    sendJson(res, 200, { ok: true, state })
  })

  route(`${PREFIX}/control`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const body = await readBody(req)
    const action = String(body?.action || '')
    const allowed = new Set(['pause', 'resume', 'skip', 'stop', 'resume-run'])
    if (!allowed.has(action)) return sendError(res, 400, `不支持的操作：${action || '(空)'}`)
    const engine = await getDefaultEngine()
    const state = await engine.control(action)
    sendJson(res, 200, { ok: true, state })
  })

  route(`${PREFIX}/file`, async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const runId = url.searchParams.get('runId') || ''
    const rel = url.searchParams.get('rel') || ''
    if (!runId || !rel) return sendError(res, 400, '缺少 runId 或 rel')
    if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]+$/.test(runId)) return sendError(res, 400, 'runId 非法')
    const engine = await getDefaultEngine()
    const runBase = path.join(engine.baseDir, runId)
    const target = safeJoin(runBase, rel)
    if (!target) return sendError(res, 400, '文件路径非法')
    let stat
    try {
      stat = await fsp.stat(target)
    } catch {
      return sendError(res, 404, '文件不存在')
    }
    if (!stat.isFile()) return sendError(res, 404, '文件不存在')
    const ext = path.extname(target).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    const name = path.basename(target)
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    })
    const data = await fsp.readFile(target)
    res.end(data)
    logger?.('served', runId, rel, formatBytes(stat.size))
  })
}
