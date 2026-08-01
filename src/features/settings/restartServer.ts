// ============================================
// Restart Server - 界面一键重启服务端
//
// 职责：
// 1. 通过 PTY 在服务器上执行用户填写的重启命令
// 2. 全程健康检查验证「断开 → 恢复」
// 3. 提供可单测的纯函数（buildPtyRestartScript / extractDoneCode / decideResult）
// ============================================

import { makeBasicAuthHeader } from '../../store/serverStore'
import type { ServerAuth, ServerHealth } from '../../store/serverStore'
import { createPtySession, getPtyConnectUrl, removePtySession } from '../../api/pty'
import { parsePtyFrame } from '../../utils/ptyProtocol'
import { isTauri } from '../../utils/tauri'

/**
 * 命令完成标记。包装脚本在命令退出后打印：\n__OPENCODEUI_DONE__:<rc>\n
 */
export const RESTART_DONE_MARKER = '__OPENCODEUI_DONE__'

/** 输出截断上限（32KB），超出后保留头部并在末尾追加截断提示 */
const MAX_OUTPUT_BYTES = 32 * 1024
const TRUNCATED_NOTE = '\n[输出已截断]'
/** 用于提取 done marker 的滚动尾部缓冲大小 */
const MARKER_TAIL_BUFFER = 1024

/** 单次健康检查默认超时 */
const HEALTH_CHECK_TIMEOUT_MS = 3000
/** 重启流程总超时（从 preflight 开始计时） */
const DEFAULT_TOTAL_TIMEOUT_MS = 90_000

export type RestartPhase = 'idle' | 'preflight' | 'executing' | 'waiting' | 'recovered' | 'failed'

export interface RestartResult {
  ok: boolean
  phase: RestartPhase
  reason?: string
  output: string
  observedOffline: boolean
  doneCode: number | null
}

export interface RestartFlowServer {
  id: string
  name: string
  url: string
  auth?: { username?: string; password?: string }
}

export interface RunRestartFlowOptions {
  server: RestartFlowServer
  command: string
  onPhase?: (phase: RestartPhase, detail?: string) => void
  onOutput?: (text: string) => void
  isCancelled?: () => boolean
  totalTimeoutMs?: number
}

// ============================================
// 纯函数
// ============================================

/**
 * 生成在 PTY 中发送的包装命令：
 * - 在子 shell 里执行原始命令，保证 stderr 也被捕获
 * - 用 rc 保存退出码，最后通过 printf 输出 done marker
 */
export function buildPtyRestartScript(command: string): string {
  return `{ ${command}
rc=$?
printf '\\n${RESTART_DONE_MARKER}:%s\\n' "$rc"
} 2>&1
`
}

/**
 * 从命令输出中提取退出码。
 * 优先匹配「输出末尾的 marker 行」，否则搜索最后一个 marker 出现位置。
 * 找不到返回 null。
 */
export function extractDoneCode(output: string): number | null {
  const strict = new RegExp(`\\n${RESTART_DONE_MARKER}:(\\d+)\\s*$`).exec(output)
  if (strict) return Number(strict[1])

  const lenient = new RegExp(`${RESTART_DONE_MARKER}:(\\d+)`, 'g')
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = lenient.exec(output)) !== null) {
    last = match
  }
  return last ? Number(last[1]) : null
}

export interface DecideResultInput {
  recovered: boolean
  observedOffline: boolean
  doneCode: number | null
  timedOut: boolean
  unauthorized: boolean
  cancelled: boolean
}

/**
 * 纯函数：根据健康轮询与命令执行结果判定最终结论。
 * 判定顺序（越靠前越「明确」）：
 *   cancelled > unauthorized > command-failed > 成功(已断开并恢复) > unconfirmed > not-recovered > timeout
 */
export function decideResult(input: DecideResultInput): { ok: boolean; reason?: string } {
  if (input.cancelled) return { ok: false, reason: 'cancelled' }
  if (input.unauthorized) return { ok: false, reason: 'unauthorized' }
  if (input.doneCode !== null && input.doneCode !== 0) return { ok: false, reason: 'command-failed' }
  if (input.recovered && input.observedOffline) return { ok: true }
  if (input.recovered) return { ok: false, reason: 'unconfirmed' }
  if (input.observedOffline) return { ok: false, reason: 'not-recovered' }
  if (input.timedOut) return { ok: false, reason: 'timeout' }
  return { ok: false, reason: 'timeout' }
}

// ============================================
// 健康探测
// ============================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeConnectionError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Connection timed out'
  if (!(err instanceof Error)) return 'Connection failed'
  return err.message || 'Connection failed'
}

/**
 * 获取统一的 fetch 实现（Tauri 桌面端用 plugin-http，浏览器用原生 fetch）。
 * 与 serverStore.checkHealth 保持一致，但独立实现，避免污染 serverStore 的 healthMap。
 */
async function getUnifiedFetch(): Promise<typeof globalThis.fetch> {
  if (!isTauri()) return globalThis.fetch
  try {
    const mod = await import('@tauri-apps/plugin-http')
    return mod.fetch as unknown as typeof globalThis.fetch
  } catch {
    return globalThis.fetch
  }
}

/**
 * 独立健康探测：GET {url}/global/health。
 * 判定规则与 serverStore.checkHealth 一致：
 * online = HTTP ok + JSON + healthy === true + version 非空；
 * 401 → unauthorized；其他非 2xx → error；网络异常/超时 → offline。
 * 不写入 serverStore 的 healthMap，避免干扰现有健康状态 UI。
 */
export async function checkHealthOnce(
  server: { url: string; auth?: { username?: string; password?: string } },
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<ServerHealth> {
  const healthUrl = `${server.url}/global/health`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const startTime = Date.now()

  try {
    const headers: Record<string, string> = {}
    if (server.auth?.password) {
      const auth: ServerAuth = { username: server.auth.username || 'opencode', password: server.auth.password }
      headers['Authorization'] = makeBasicAuthHeader(auth)
    }

    const f = await getUnifiedFetch()
    const response = await f(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      headers,
    })

    const latency = Date.now() - startTime

    if (response.ok) {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('application/json')) {
        return {
          status: 'error',
          latency,
          lastCheck: Date.now(),
          error: 'Server did not return OpenCode health JSON',
        }
      }

      let data: unknown
      try {
        data = await response.json()
      } catch {
        return { status: 'error', latency, lastCheck: Date.now(), error: 'Invalid OpenCode health JSON' }
      }

      if (isRecord(data) && data.healthy === true && typeof data.version === 'string' && data.version.trim()) {
        return { status: 'online', latency, lastCheck: Date.now(), version: data.version }
      }
      return { status: 'error', latency, lastCheck: Date.now(), error: 'Not an OpenCode server' }
    }

    if (response.status === 401) {
      return { status: 'unauthorized', latency, lastCheck: Date.now(), error: 'Invalid credentials' }
    }
    return { status: 'error', latency, lastCheck: Date.now(), error: `HTTP ${response.status}` }
  } catch (err) {
    return { status: 'offline', lastCheck: Date.now(), error: normalizeConnectionError(err) }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================
// PTY 辅助
// ============================================

interface PtyCommandOptions {
  ptyId: string
  script: string
  onOutput?: (text: string) => void
  onDoneCode?: (code: number) => void
  isStopped?: () => boolean
  timeoutMs?: number
}

interface PtyCommandResult {
  output: string
  doneCode: number | null
  wsClosed: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 在指定 PTY 上发送脚本并收集输出。
 * 结束条件：done marker 出现 / WebSocket 断开（服务被杀）/ 超时 / 被外部停止。
 * 输出截断上限 32KB（保留头部 + 截断提示），done marker 通过滚动尾部缓冲提取。
 */
function runPtyCommand(options: PtyCommandOptions): Promise<PtyCommandResult> {
  return new Promise(resolve => {
    const { ptyId, script, onOutput, onDoneCode } = options
    const timeoutMs = options.timeoutMs ?? 15000
    const startedAt = Date.now()
    let output = ''
    let tailBuffer = ''
    let truncated = false
    let doneCode: number | null = null
    let wsClosed = false
    let settled = false

    const ws = new WebSocket(getPtyConnectUrl(ptyId))
    ws.binaryType = 'arraybuffer'

    const appendOutput = (text: string) => {
      tailBuffer += text
      if (tailBuffer.length > MARKER_TAIL_BUFFER) {
        tailBuffer = tailBuffer.slice(-MARKER_TAIL_BUFFER)
      }
      if (!truncated) {
        output += text
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(0, MAX_OUTPUT_BYTES) + TRUNCATED_NOTE
          truncated = true
        }
      }
      onOutput?.(text)
    }

    const settle = () => {
      if (settled) return
      settled = true
      clearInterval(checker)
      try {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      } catch {
        // ignore
      }
      if (doneCode !== null) onDoneCode?.(doneCode)
      resolve({ output, doneCode, wsClosed })
    }

    // 兜底：超时或被外部停止时强制结束
    const checker = setInterval(() => {
      if (Date.now() - startedAt >= timeoutMs || options.isStopped?.()) settle()
    }, 200)

    ws.onopen = () => {
      try {
        ws.send(script)
      } catch {
        settle()
      }
    }

    ws.onmessage = event => {
      const frame = parsePtyFrame(event.data as string | ArrayBuffer)
      if (!frame || frame.kind === 'control') return
      appendOutput(frame.data)
      const code = extractDoneCode(tailBuffer)
      if (code !== null) {
        doneCode = code
        settle()
      }
    }

    ws.onclose = () => {
      wsClosed = true
      settle()
    }

    ws.onerror = () => {
      // onclose 会在 onerror 之后触发，结束逻辑交给 onclose
    }
  })
}

// ============================================
// 自动识别
// ============================================

/**
 * 自动识别 systemd 服务是否可用。
 * 先做一次健康检查（在线才继续），再通过 PTY 执行探测命令，
 * 输出包含 'RC:0' 说明 opencode.service 存在且处于 active 状态。
 */
export async function detectSystemdActive(
  server: RestartFlowServer,
  options?: { onOutput?: (text: string) => void; timeoutMs?: number },
): Promise<boolean> {
  const health = await checkHealthOnce(server, HEALTH_CHECK_TIMEOUT_MS)
  if (health.status !== 'online') return false

  let ptyId: string | null = null
  try {
    const pty = await createPtySession({})
    ptyId = pty.id
    const probe = 'systemctl is-active --quiet opencode.service 2>/dev/null; echo "RC:$?"'
    const result = await runPtyCommand({
      ptyId,
      script: buildPtyRestartScript(probe),
      onOutput: options?.onOutput,
      timeoutMs: options?.timeoutMs ?? 10_000,
    })
    return result.output.includes('RC:0')
  } catch {
    return false
  } finally {
    if (ptyId) void removePtySession(ptyId).catch(() => {})
  }
}

// ============================================
// 重启主流程
// ============================================

/**
 * 完整重启流程：
 * preflight（连续 2 次 online）→ executing（PTY 执行命令）→ waiting（健康轮询等恢复）→ 结果判定。
 * 轮询与命令执行并发进行；观察到非 online 即记录 observedOffline，连续 2 次 online 视为恢复。
 * 收尾（finally）：关闭 WebSocket（runPtyCommand 内部完成）、removePtySession、停止轮询。
 */
export async function runRestartFlow(options: RunRestartFlowOptions): Promise<RestartResult> {
  const { server, command, onPhase, onOutput, isCancelled } = options
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const startedAt = Date.now()

  const cancelled = () => isCancelled?.() === true
  const deadlineReached = () => Date.now() - startedAt >= totalTimeoutMs

  const state: {
    doneCode: number | null
    output: string
    observedOffline: boolean
    recovered: boolean
    unauthorized: boolean
    timedOut: boolean
    execDone: boolean
  } = {
    doneCode: null,
    output: '',
    observedOffline: false,
    recovered: false,
    unauthorized: false,
    timedOut: false,
    execDone: false,
  }

  let ptyId: string | null = null
  let stopPoll = false
  let finished = false

  const finish = (result: RestartResult): RestartResult => {
    if (finished) return result
    finished = true
    stopPoll = true
    onPhase?.(result.phase, result.reason)
    return result
  }

  const fail = (reason: string, extra?: { output?: string }): RestartResult =>
    finish({
      ok: false,
      phase: 'failed',
      reason,
      output: extra?.output ?? state.output,
      observedOffline: state.observedOffline,
      doneCode: state.doneCode,
    })

  try {
    // ---- preflight：连续 2 次 online ----
    onPhase?.('preflight')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (cancelled()) return fail('cancelled')
      if (deadlineReached()) return fail('timeout')
      const health = await checkHealthOnce(server, HEALTH_CHECK_TIMEOUT_MS)
      if (health.status === 'unauthorized') return fail('unauthorized')
      if (health.status !== 'online') return fail('offline')
      if (attempt === 0) await sleep(300)
    }

    // ---- executing：创建 PTY 并执行命令 ----
    onPhase?.('executing')
    try {
      const pty = await createPtySession({})
      ptyId = pty.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail('exec-error', { output: `Failed to create PTY session: ${msg}` })
    }

    const execPromise = runPtyCommand({
      ptyId,
      script: buildPtyRestartScript(command),
      onOutput,
      onDoneCode: code => {
        state.doneCode = code
      },
      isStopped: () => cancelled() || deadlineReached() || stopPoll,
      timeoutMs: totalTimeoutMs,
    }).then(result => {
      state.doneCode = result.doneCode
      state.output = result.output
      state.execDone = true
      return result
    })

    // ---- waiting：与 executing 并发开启健康轮询 ----
    const pollPromise = (async () => {
      let consecutiveOnline = 0
      while (!stopPoll) {
        if (cancelled()) return
        if (deadlineReached()) {
          state.timedOut = true
          return
        }
        const health = await checkHealthOnce(server, HEALTH_CHECK_TIMEOUT_MS)
        if (health.status === 'unauthorized') {
          state.unauthorized = true
          return
        }
        if (health.status === 'online') {
          consecutiveOnline += 1
          // 只有「观察过断开」或「命令已执行完成」后才认可恢复，避免命令未执行完就被判定成功
          if (consecutiveOnline >= 2 && (state.observedOffline || state.execDone)) {
            state.recovered = true
            return
          }
        } else {
          consecutiveOnline = 0
          if (health.status !== 'checking') state.observedOffline = true
        }
        await sleep(500)
      }
    })()

    onPhase?.('waiting')
    await Promise.race([execPromise, pollPromise])

    // 轮询已恢复时让命令执行尽快收敛
    if (state.recovered) stopPoll = true
    await execPromise.catch(() => {})
    stopPoll = true
    await pollPromise.catch(() => {})

    if (cancelled()) return fail('cancelled')
    if (state.unauthorized) return fail('unauthorized')
    state.timedOut = state.timedOut || deadlineReached()

    const decision = decideResult({
      recovered: state.recovered,
      observedOffline: state.observedOffline,
      doneCode: state.doneCode,
      timedOut: state.timedOut,
      unauthorized: state.unauthorized,
      cancelled: false,
    })

    if (decision.ok) {
      return finish({
        ok: true,
        phase: 'recovered',
        output: state.output,
        observedOffline: state.observedOffline,
        doneCode: state.doneCode,
      })
    }
    return fail(decision.reason ?? 'timeout')
  } finally {
    stopPoll = true
    if (ptyId) {
      void removePtySession(ptyId).catch(() => {})
    }
  }
}
