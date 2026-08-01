import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RESTART_DONE_MARKER,
  buildPtyRestartScript,
  checkHealthOnce,
  decideResult,
  extractDoneCode,
} from './restartServer'

// ============================================
// buildPtyRestartScript
// ============================================

describe('buildPtyRestartScript', () => {
  it('wraps the original command with rc capture and done marker', () => {
    const script = buildPtyRestartScript('systemctl restart opencode')

    expect(script).toContain('{ systemctl restart opencode')
    expect(script).toContain('rc=$?')
    expect(script).toContain(`printf '\\n${RESTART_DONE_MARKER}:%s\\n' "$rc"`)
    expect(script).toContain('} 2>&1')
    // 必须以换行结尾:交互 shell 中无尾换行的行不会被提交执行(真实环境验证过的 bug)
    expect(script.endsWith('\n')).toBe(true)

    // 原始命令、rc 捕获、marker 打印、stderr 合并依次出现
    const commandIndex = script.indexOf('systemctl restart opencode')
    const rcIndex = script.indexOf('rc=$?')
    const markerIndex = script.indexOf(RESTART_DONE_MARKER)
    const redirectIndex = script.indexOf('} 2>&1')
    expect(commandIndex).toBeGreaterThan(-1)
    expect(rcIndex).toBeGreaterThan(commandIndex)
    expect(markerIndex).toBeGreaterThan(rcIndex)
    expect(redirectIndex).toBeGreaterThan(markerIndex)
  })
})

// ============================================
// extractDoneCode
// ============================================

describe('extractDoneCode', () => {
  it('extracts exit code from marker at end of output', () => {
    const output = `systemctl restart opencode\n\n__OPENCODEUI_DONE__:0\n`
    expect(extractDoneCode(output)).toBe(0)
  })

  it('extracts the last marker when multiple exist', () => {
    const output = `a\n__OPENCODEUI_DONE__:1\nb\n__OPENCODEUI_DONE__:42`
    expect(extractDoneCode(output)).toBe(42)
  })

  it('returns null when no marker present', () => {
    expect(extractDoneCode('hello world')).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(extractDoneCode('')).toBeNull()
  })
})

// ============================================
// decideResult
// ============================================

describe('decideResult', () => {
  const base = {
    recovered: false,
    observedOffline: false,
    doneCode: null,
    timedOut: false,
    unauthorized: false,
    cancelled: false,
  }

  it('succeeds when recovered after observing offline', () => {
    const result = decideResult({ ...base, recovered: true, observedOffline: true, doneCode: 0 })
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('reports unconfirmed when recovered but no offline observed', () => {
    const result = decideResult({ ...base, recovered: true, observedOffline: false, doneCode: 0 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unconfirmed')
  })

  it('reports command-failed when doneCode is non-zero', () => {
    const result = decideResult({ ...base, recovered: true, observedOffline: true, doneCode: 1 })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('command-failed')
  })

  it('reports not-recovered when offline observed but timed out', () => {
    const result = decideResult({ ...base, observedOffline: true, timedOut: true })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-recovered')
  })

  it('reports timeout otherwise', () => {
    const result = decideResult({ ...base, timedOut: true })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('timeout')
  })

  it('reports unauthorized', () => {
    const result = decideResult({ ...base, unauthorized: true })
    expect(result.reason).toBe('unauthorized')
  })

  it('reports cancelled', () => {
    const result = decideResult({ ...base, cancelled: true })
    expect(result.reason).toBe('cancelled')
  })
})

// ============================================
// checkHealthOnce
// ============================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('checkHealthOnce', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns online when healthy json returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ healthy: true, version: 'v1.2.3' })))

    const health = await checkHealthOnce({ url: 'http://server.test' })

    expect(health.status).toBe('online')
    expect(health.version).toBe('v1.2.3')
  })

  it('sends Basic auth header when credentials provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ healthy: true, version: 'v1' }))
    vi.stubGlobal('fetch', fetchMock)

    await checkHealthOnce({ url: 'http://server.test', auth: { username: 'opencode', password: 'secret' } })

    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(input).toBe('http://server.test/global/health')
    expect(init.headers).toEqual({ Authorization: `Basic ${btoa('opencode:secret')}` })
  })

  it('returns offline when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const health = await checkHealthOnce({ url: 'http://server.test' })

    expect(health.status).toBe('offline')
    expect(health.error).toBe('network down')
  })

  it('returns unauthorized on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))

    const health = await checkHealthOnce({ url: 'http://server.test' })

    expect(health.status).toBe('unauthorized')
  })

  it('returns error when server is not an OpenCode server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ healthy: false })))

    const health = await checkHealthOnce({ url: 'http://server.test' })

    expect(health.status).toBe('error')
  })

  it('returns error for non-2xx status other than 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))

    const health = await checkHealthOnce({ url: 'http://server.test' })

    expect(health.status).toBe('error')
    expect(health.error).toBe('HTTP 500')
  })
})
