/**
 * LLM 调用薄封装（契约：docs/CONTRACT.md §2.3）。
 *
 * 只做四件事：
 * 1. 把 DSH `llm.stream()` 的 chunk 流拼成纯文本；
 * 2. 把「外部 signal（暂停/停止）」与「内部超时」合成一个 AbortController；
 * 3. 超时默认 90s，允许 options.llmTimeoutMs 覆盖；
 * 4. 失败时抛错（由 simulate.js 统一回退 demo），不吞掉外部取消。
 *
 * 依赖注入（llm / model）而不是 import DSH 运行时，便于单测与 demo 模式。
 */

/** 默认 LLM 超时：90 秒。 */
export const DEFAULT_LLM_TIMEOUT_MS = 90_000
/** 超时上限，避免配置成天文数字。 */
export const MAX_LLM_TIMEOUT_MS = 600_000
/** 超时下限，允许测试用 10ms 级别的值。 */
export const MIN_LLM_TIMEOUT_MS = 10

/** 统一的中文取消错误。 */
export function abortError(message = '辩论模拟已停止') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  error.aborted = true
  return error
}

/** 判断是否取消类错误（兼容 DOMException / 自造错误）。 */
export function isAbortError(error) {
  if (!error || typeof error !== 'object') return false
  return error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.aborted === true
}

/** signal 已取消就抛 AbortError，供每个回合起点调用。 */
export function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError('辩论模拟已停止')
}

/** 规范化超时毫秒数：非法值回退 fallback，并夹在 10ms..600s。 */
export function normalizeTimeoutMs(value, fallback = DEFAULT_LLM_TIMEOUT_MS) {
  const n = Number(value)
  const base = Number.isFinite(n) && n > 0 ? n : Number(fallback)
  if (!Number.isFinite(base) || base <= 0) return fallback
  return Math.min(MAX_LLM_TIMEOUT_MS, Math.max(MIN_LLM_TIMEOUT_MS, Math.round(base)))
}

/** LLM 超时专用错误（带 code，便于模拟器统计）。 */
export class LlmTimeoutError extends Error {
  constructor(timeoutMs, cause) {
    super(`LLM 调用超时（${timeoutMs}ms）`)
    this.name = 'LlmTimeoutError'
    this.code = 'LLM_TIMEOUT'
    this.timeoutMs = timeoutMs
    if (cause) this.cause = cause
  }
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null
  const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
  const name = typeof model.model === 'string' ? model.model.trim() : ''
  if (!provider || !name) return null
  const out = { provider, model: name }
  if (typeof model.reasoningEffort === 'string' && model.reasoningEffort.trim()) {
    out.reasoningEffort = model.reasoningEffort.trim()
  }
  return out
}

function buildMessages(request) {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages
      .filter((message) => message && typeof message === 'object' && typeof message.role === 'string')
      .map((message) =>
        typeof message.content === 'string'
          ? { ...message, content: [{ type: 'text', text: message.content }] }
          : message,
      )
  }
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  if (!prompt.trim()) return []
  // DSH 的请求消息 content 是 ContentBlock[]；字符串会导致 DeepSeek 传输层拒绝。
  return [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
}

/** 给 iterator.next() 套上取消：signal 一响立即拒绝，不必等适配器返回。 */
function nextWithAbort(iterator, signal) {
  if (!signal) return iterator.next()
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => iterator.next())
      .then(resolve, reject)
      .finally(() => {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* ignore */
        }
      })
  })
}

/** 把 chunk 流拼成文本；error/aborted 结束块转成异常。可选 onDelta 逐块回调。 */
export async function collectStreamText(stream, signal, onDelta) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('LLM 返回了不可迭代的流')
  }
  const iterator = stream[Symbol.asyncIterator]()
  let text = ''
  try {
    for (;;) {
      const step = await nextWithAbort(iterator, signal)
      if (step.done) break
      const chunk = step.value
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') {
          text += chunk.text
          if (typeof onDelta === 'function' && chunk.text) {
            try {
              onDelta(chunk.text)
            } catch {
              /* 展示回调失败不得中断生成 */
            }
          }
        }
      } else if (chunk.type === 'block-end') {
        if (!text && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          text += chunk.block.text
        }
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error') throw new Error(reason.failure?.message || 'LLM 调用失败')
        if (reason?.kind === 'aborted') {
          const error = abortError(reason.failure?.message || 'LLM 调用被中断')
          error.llmAborted = true
          throw error
        }
        break
      }
    }
  } finally {
    // 只发起关闭、不 await：适配器若卡在 pending await，await iterator.return()
    // 会永久挂住，导致超时/取消都传不出去（demo 回退也就永远不会发生）。
    try {
      const closing = iterator.return?.()
      if (closing && typeof closing.catch === 'function') closing.catch(() => {})
    } catch {
      /* 关闭流的失败不影响主流程 */
    }
  }
  return text
}

/**
 * 创建 LLM 执行器。
 * @param {{
 *   llm?: object|null, model?: {provider:string, model:string, reasoningEffort?:string}|null,
 *   llmTimeoutMs?: number, timeoutMs?: number, logger?: (...args:any[])=>void
 * }} options
 */
export function createLlmRunner(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const llm = opts.llm ?? null
  const model = normalizeModel(opts.model)
  const timeoutMs = normalizeTimeoutMs(opts.llmTimeoutMs ?? opts.timeoutMs, DEFAULT_LLM_TIMEOUT_MS)
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {}
  const stats = { calls: 0, errors: 0, timeouts: 0, lastError: null }
  const log = (...args) => {
    try {
      logger(...args)
    } catch {
      /* 日志失败不得中断辩论 */
    }
  }

  const available = () => Boolean(llm && typeof llm.stream === 'function' && model?.provider && model?.model)

  return {
    llm,
    model,
    timeoutMs,
    stats,
    available,
    /** 单次调用：成功返回非空文本，失败抛错。 */
    async complete(request = {}) {
      const signal = request.signal
      assertNotAborted(signal)
      if (!available()) throw new Error('LLM 不可用或未配置默认模型（agentDefaultModel）')
      const messages = buildMessages(request)
      if (messages.length === 0) throw new Error('LLM 请求缺少 messages / prompt')

      const timeout = normalizeTimeoutMs(request.timeoutMs ?? timeoutMs, timeoutMs)
      const controller = new AbortController()
      let timedOut = false
      const onExternalAbort = () => {
        try {
          controller.abort(abortError())
        } catch {
          /* ignore */
        }
      }
      if (signal) {
        if (signal.aborted) throw abortError()
        signal.addEventListener('abort', onExternalAbort, { once: true })
      }
      const timer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort(new Error('LLM 超时'))
        } catch {
          /* ignore */
        }
      }, timeout)
      // 注意：不要 unref —— 超时定时器必须能独立唤醒事件循环，
      // 否则适配器挂死（pending promise）时进程会直接退出而不是触发超时回退。

      stats.calls += 1
      try {
        const payload = {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          ...(typeof request.system === 'string' && request.system.trim() ? { system: request.system } : {}),
          messages,
          signal: controller.signal,
          ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
          ...(Number.isFinite(Number(request.maxTokens)) && Number(request.maxTokens) > 0
            ? { maxTokens: Math.round(Number(request.maxTokens)) }
            : {}),
        }
        const stream = llm.stream(payload)
        const text = await collectStreamText(stream, controller.signal, request.onDelta)
        const trimmed = text.trim()
        if (!trimmed) throw new Error('LLM 返回空文本')
        return trimmed
      } catch (error) {
        stats.errors += 1
        stats.lastError = error?.message ?? String(error)
        if (timedOut) {
          stats.timeouts += 1
          log('[debate-sim] LLM 超时：', timeout, 'ms')
          throw new LlmTimeoutError(timeout, error)
        }
        if (signal?.aborted) throw abortError()
        throw error instanceof Error ? error : new Error(String(error))
      } finally {
        clearTimeout(timer)
        if (signal) {
          try {
            signal.removeEventListener('abort', onExternalAbort)
          } catch {
            /* ignore */
          }
        }
      }
    },
  }
}
