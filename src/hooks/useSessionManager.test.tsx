import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

const { getSessionMock, getSessionMessagesMock, messageStoreMock, themeState, sessionErrorHandlerMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    getSessionMessagesMock: vi.fn(),
    messageStoreMock: {
      getSessionState: vi.fn(),
      setLoadState: vi.fn(),
      setLoadError: vi.fn(),
      setMessages: vi.fn(),
      updateSessionMetadata: vi.fn(),
      prependMessages: vi.fn(),
      setRevertState: vi.fn(),
    },
    themeState: { processCollapseEnabled: false },
    sessionErrorHandlerMock: vi.fn(),
  }),
)

vi.mock('../api', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
  revertMessage: vi.fn(),
  unrevertSession: vi.fn(),
  extractUserMessageContent: vi.fn(),
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
}))

vi.mock('./useTheme', () => ({
  useTheme: () => themeState,
}))

describe('useSessionManager', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getSessionMessagesMock.mockReset()
    messageStoreMock.getSessionState.mockReset()
    messageStoreMock.setLoadState.mockReset()
    messageStoreMock.setLoadError.mockReset()
    messageStoreMock.setMessages.mockReset()
    messageStoreMock.updateSessionMetadata.mockReset()
    messageStoreMock.prependMessages.mockReset()
    messageStoreMock.setRevertState.mockReset()
    sessionErrorHandlerMock.mockReset()
    themeState.processCollapseEnabled = false

    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionMock.mockResolvedValue({ id: 'session-1', directory: '/workspace/demo' })
    getSessionMessagesMock.mockResolvedValue([])
  })

  it('reports missing route sessions when loading returns not found', async () => {
    const onSessionMissing = vi.fn()
    const notFoundError = Object.assign(new Error('session not found'), { status: 404 })
    getSessionMock.mockRejectedValue(notFoundError)
    getSessionMessagesMock.mockRejectedValue(notFoundError)

    renderHook(() =>
      useSessionManager({
        sessionId: 'missing-session',
        directory: '/workspace/demo',
        onSessionMissing,
      }),
    )

    await waitFor(() => {
      expect(onSessionMissing).toHaveBeenCalledWith('missing-session')
    })

    expect(messageStoreMock.setLoadState).toHaveBeenCalledWith('missing-session', 'loading')
    expect(messageStoreMock.setLoadError).toHaveBeenCalledWith(
      'missing-session',
      expect.objectContaining({ name: 'APIError' }),
    )
  })

  it('loads five ten-message pages initially in standard mode', async () => {
    renderHook(() =>
      useSessionManager({
        sessionId: 'session-1',
        directory: '/workspace/demo',
      }),
    )

    await waitFor(() => {
      expect(getSessionMessagesMock).toHaveBeenCalledWith('session-1', 50, '/workspace/demo')
    })
  })

  it('reserves two raw messages per collapsed row', async () => {
    themeState.processCollapseEnabled = true

    renderHook(() =>
      useSessionManager({
        sessionId: 'session-1',
        directory: '/workspace/demo',
      }),
    )

    await waitFor(() => {
      expect(getSessionMessagesMock).toHaveBeenCalledWith('session-1', 100, '/workspace/demo')
    })
  })

  it('fills the larger collapsed baseline after switching modes', async () => {
    const { rerender } = renderHook(() =>
      useSessionManager({
        sessionId: 'session-1',
        directory: '/workspace/demo',
      }),
    )
    await waitFor(() => {
      expect(getSessionMessagesMock).toHaveBeenCalledWith('session-1', 50, '/workspace/demo')
    })

    themeState.processCollapseEnabled = true
    rerender()

    await waitFor(() => {
      expect(getSessionMessagesMock).toHaveBeenCalledWith('session-1', 100, '/workspace/demo')
    })
  })

  it.each([
    { collapsed: false, expectedLimit: 100 },
    { collapsed: true, expectedLimit: 200 },
  ])('loads another five-page batch when collapsed=$collapsed', async ({ collapsed, expectedLimit }) => {
    themeState.processCollapseEnabled = collapsed
    const cachedMessageCount = collapsed ? 100 : 50
    const cachedMessages = Array.from({ length: cachedMessageCount }, (_unused, index) => ({
      info: { id: `message-${index}` },
    }))
    messageStoreMock.getSessionState.mockReturnValue({
      directory: '/workspace/demo',
      hasMoreHistory: true,
      isStale: false,
      loadState: 'loaded',
      messages: cachedMessages,
    })
    const { result } = renderHook(() =>
      useSessionManager({
        sessionId: 'session-1',
        directory: '/workspace/demo',
      }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    expect(getSessionMessagesMock).toHaveBeenCalledWith('session-1', expectedLimit, '/workspace/demo')
  })
})
