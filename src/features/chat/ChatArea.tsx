// ============================================
// ChatArea - 聊天消息显示区域
// ============================================
//
// 这版使用粗颗粒页块级虚拟化：
// - 消息以 20 条为主分块，渲染重量只限制极端页面
// - 视口附近少量页保持真实 DOM
// - 远页折叠成固定高度块，优先使用实测高度，未测量时使用保守估算
//
// 这样滚动链路里不会出现“正在眼前从假高度变真高度的 message”，
// 手感比消息级壳切换稳定得多，同时 DOM 数量也有上限。

import {
  useRef,
  useImperativeHandle,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { animate } from 'motion/mini'
import {
  ImmersiveProcessBlock,
  MessageRenderer,
  messageHasImmersiveFinal,
  messageHasImmersiveProcess,
} from '../message'
import { MessageErrorView } from '../message/parts'
import { messageStore } from '../../store'
import { useTheme } from '../../hooks/useTheme'
import type { Message, MessageError } from '../../types/message'
import { RetryStatusInline, type RetryStatusInlineData } from './RetryStatusInline'
import { buildVisibleMessageEntries, getVisibleMessageForkTargetId } from './chatAreaVisibility'
import { AT_BOTTOM_THRESHOLD_PX } from '../../constants'
import { useChatViewport } from './chatViewport'
import {
  buildContentKeyedChatPages,
  buildExpandedPageSelection,
  buildPageOffsets,
  buildPageRenderSegments,
  computeAnchorRestoreScrollDelta,
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  buildTurnUserStartMap,
  computeExpandedPageRange,
  expandSelectionWithPageKeys,
  PAGE_ADJACENT_OVERSCAN,
  seedMeasuredPageHeightsFromPreviousPages,
  type ChatPage,
  type StableChatPage,
} from './chatPageModel'
import { isScrollAnchorLocked } from '../../utils/scrollUtils'

const LOAD_MORE_ROOT_MARGIN = '240px 0px 0px 0px'
const LOAD_MORE_ANCHOR_CAPTURE_PX = 480
const LOAD_MORE_WHEEL_COOLDOWN_MS = 90
const LOAD_MORE_DEFER_MS = 100
const LOAD_MORE_ANCHOR_SETTLE_MS = 600
const LOAD_MORE_ANCHOR_FALLBACK_MS = 5000
const PENDING_SCROLL_TARGET_KEEPALIVE_MS = 900
const ADJACENT_PAGE_PRELOAD_VIEWPORTS = 12

type LoadMoreAnchorSnapshot = {
  messageId: string
  sourceId: string
  topOffset: number
  bottomOffset: number
}

/** Stable no-op to avoid creating a new closure on every render. */
const NOOP = () => {}

function pageHasStreamingMessage(page: ChatPage): boolean {
  return page.rows.some(row =>
    row.messages.some(
      message => message.isStreaming || (message.info.role === 'assistant' && message.info.time.completed == null),
    ),
  )
}

function pageHasUserMessage(page: ChatPage): boolean {
  return page.rows.some(row => row.messages.some(message => message.info.role === 'user'))
}

function captureLoadMoreAnchor(root: HTMLElement): LoadMoreAnchorSnapshot | null {
  const rootRect = root.getBoundingClientRect()
  const candidates = root.querySelectorAll<HTMLElement>('[data-message-id]')

  let best: LoadMoreAnchorSnapshot | null = null
  let bestVisibleHeight = 0
  for (const element of candidates) {
    const messageId = element.getAttribute('data-message-id')
    if (!messageId) continue
    const sourceId = element.getAttribute('data-anchor-source-id') || messageId

    const rect = element.getBoundingClientRect()
    const intersectsViewport = rect.bottom > rootRect.top && rect.top < rootRect.bottom
    if (!intersectsViewport) continue

    const topOffset = rect.top - rootRect.top
    const visibleHeight = Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top)
    if (
      visibleHeight > bestVisibleHeight ||
      (visibleHeight === bestVisibleHeight && (!best || topOffset < best.topOffset))
    ) {
      best = { messageId, sourceId, topOffset, bottomOffset: rect.bottom - rootRect.top }
      bestVisibleHeight = visibleHeight
    }
  }

  return best
}

function findLoadMoreAnchorTarget(root: HTMLElement, anchor: LoadMoreAnchorSnapshot): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"]`)
  if (direct) return direct
  for (const element of root.querySelectorAll<HTMLElement>('[data-anchor-source-id]')) {
    if (element.getAttribute('data-anchor-source-id') === anchor.sourceId) return element
  }
  return null
}

interface ChatAreaProps {
  messages: Message[]
  pageRecords?: StableChatPage[]
  visibleMessages?: Message[]
  forkTargetIdMap?: Map<string, string | undefined>
  turnDurationMap?: Map<string, number>
  /** 每个可见 assistant 所属回合的用户发送时间；过程折叠前端实时计时起点 */
  turnUserStartMap?: Map<string, number>
  /** 每个用户回合最后一条可见 assistant 的 id；用于仅在最新 step 显示完成信息 */
  turnLatestAssistantIds?: Set<string>
  sessionId?: string | null
  isStreaming?: boolean
  allowStreamingLayoutAnimation?: boolean
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  loadError?: MessageError
  connectionError?: MessageError
  onOpenSettings?: () => void
  hasMoreHistory?: boolean
  onLoadMore?: () => void | Promise<void>
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  registerMessage?: (id: string, element: HTMLElement | null) => void
  retryStatus?: RetryStatusInlineData | null
  bottomPadding?: number
  onVisibleMessageIdsChange?: (ids: string[]) => void
  onAtBottomChange?: (atBottom: boolean) => void
}

export type ChatAreaHandle = {
  scrollToBottom: (instant?: boolean) => void
  scrollToBottomIfAtBottom: () => void
  scrollToLastMessage: () => void
  scrollToMessageIndex: (index: number) => void
  scrollToMessageId: (messageId: string) => void
}

export const ChatArea = memo(
  forwardRef<ChatAreaHandle, ChatAreaProps>(
    (
      {
        messages,
        pageRecords,
        visibleMessages: visibleMessagesProp,
        forkTargetIdMap: forkTargetIdMapProp,
        turnDurationMap: turnDurationMapProp,
        turnUserStartMap: turnUserStartMapProp,
        turnLatestAssistantIds: turnLatestAssistantIdsProp,
        sessionId,
        isStreaming: _isStreaming = false,
        allowStreamingLayoutAnimation = true,
        loadState = 'idle',
        loadError,
        connectionError,
        onOpenSettings,
        onLoadMore,
        onUndo,
        onFork,
        canUndo,
        hasMoreHistory: _hasMoreHistory = false,
        registerMessage,
        retryStatus = null,
        bottomPadding = 0,
        onVisibleMessageIdsChange,
        onAtBottomChange,
      },
      ref,
    ) => {
      const { t } = useTranslation('chat')
      const scrollRef = useRef<HTMLDivElement>(null)
      const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
      const topSentinelRef = useRef<HTMLDivElement>(null)
      const isAtBottomRef = useRef(true)
      const loadMoreRef = useRef(onLoadMore)
      const isLoadingRef = useRef(false)
      const [isLoadingMore, setIsLoadingMore] = useState(false)
      const [scrollOffsetFromBottom, setScrollOffsetFromBottom] = useState(0)
      const [viewportHeight, setViewportHeight] = useState(0)
      const [measuredPageHeights, setMeasuredPageHeights] = useState<Record<string, number>>({})
      const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null)
      const [pendingLoadMoreAnchorSourceId, setPendingLoadMoreAnchorSourceId] = useState<string | null>(null)
      const scrollSnapshotRafRef = useRef<number | null>(null)
      const pendingLoadMoreAnchorRef = useRef<LoadMoreAnchorSnapshot | null>(null)
      const loadMoreIntentAnchorRef = useRef<LoadMoreAnchorSnapshot | null>(null)
      const loadMoreRequestCompletedRef = useRef(false)
      const pendingLayoutAnchorRef = useRef<LoadMoreAnchorSnapshot | null>(null)
      const pendingLoadMoreTimerRef = useRef<number | null>(null)
      const pendingAnchorReleaseTimerRef = useRef<number | null>(null)
      const pendingScrollClearTimerRef = useRef<number | null>(null)
      const pendingAnchorClearRafRef = useRef<number | null>(null)
      const pendingSessionResetRafRef = useRef<number | null>(null)
      const lastScrollRootSizeRef = useRef({ width: 0, height: 0 })
      const previousActivePagesRef = useRef<{ sessionId?: string | null; pages: StableChatPage[] }>({ pages: [] })
      const settlingScrollMessageIdRef = useRef<string | null>(null)
      const loadMoreRequestIdRef = useRef(0)
      const loadMorePagesBeforeRef = useRef<StableChatPage[] | null>(null)
      const isMountedRef = useRef(true)
      const topSentinelVisibleRef = useRef(false)
      const lastWheelInputAtRef = useRef(0)
      const tryLoadMoreRef = useRef<() => void>(NOOP)

      useEffect(() => {
        loadMoreRef.current = onLoadMore
      }, [onLoadMore])

      const loadMoreBlockedRef = useRef(true)

      const { isWideMode } = useTheme()
      const { presentation } = useChatViewport()
      const atBottomThreshold = presentation.isCompact ? 150 : AT_BOTTOM_THRESHOLD_PX
      const messagePaddingClass = presentation.isCompact ? 'px-3' : 'px-5'
      const messageMaxWidthClass = isWideMode ? 'max-w-[95%] xl:max-w-6xl' : 'max-w-2xl'
      const shouldUseExternalViewModel = pageRecords != null && visibleMessagesProp != null
      const visibleMessageEntries = useMemo(
        () => (shouldUseExternalViewModel ? [] : buildVisibleMessageEntries(messages)),
        [messages, shouldUseExternalViewModel],
      )
      const visibleMessages = useMemo(
        () => visibleMessagesProp ?? visibleMessageEntries.map(entry => entry.message),
        [visibleMessageEntries, visibleMessagesProp],
      )
      const pages = useMemo<StableChatPage[]>(
        () => (shouldUseExternalViewModel ? [] : buildContentKeyedChatPages(visibleMessages)),
        [shouldUseExternalViewModel, visibleMessages],
      )
      const localForkTargetIdMap = useMemo(
        () =>
          forkTargetIdMapProp ??
          new Map(visibleMessageEntries.map(entry => [entry.message.info.id, getVisibleMessageForkTargetId(entry)])),
        [forkTargetIdMapProp, visibleMessageEntries],
      )
      const localTurnDurationMap = useMemo(
        () => turnDurationMapProp ?? buildTurnDurationMap(messages, visibleMessages),
        [messages, turnDurationMapProp, visibleMessages],
      )
      const localTurnUserStartMap = useMemo(
        () => turnUserStartMapProp ?? buildTurnUserStartMap(messages, visibleMessages),
        [messages, turnUserStartMapProp, visibleMessages],
      )
      const localTurnLatestAssistantIds = useMemo(
        () => turnLatestAssistantIdsProp ?? buildTurnLatestAssistantIdSet(visibleMessages),
        [turnLatestAssistantIdsProp, visibleMessages],
      )

      const activePages = pageRecords ?? pages

      useLayoutEffect(() => {
        const previous = previousActivePagesRef.current
        previousActivePagesRef.current = { sessionId, pages: activePages }
        if (previous.sessionId !== sessionId || previous.pages.length === 0 || activePages.length === 0) return

        setMeasuredPageHeights(current => {
          const seeded = seedMeasuredPageHeightsFromPreviousPages({
            pages: activePages,
            previousPages: previous.pages,
            measuredPageHeights: current,
          })
          if (seeded === current) return current
          return seeded
        })
      }, [activePages, sessionId])

      const pendingTargetPageIndex = useMemo(
        () =>
          pendingScrollMessageId == null
            ? -1
            : activePages.findIndex(page => page.messageIds.includes(pendingScrollMessageId)),
        [activePages, pendingScrollMessageId],
      )

      const pendingLoadMoreAnchorPageIndex = useMemo(
        () =>
          pendingLoadMoreAnchorSourceId == null
            ? -1
            : activePages.findIndex(page =>
                page.messageIds.some(
                  messageId => (localForkTargetIdMap.get(messageId) ?? messageId) === pendingLoadMoreAnchorSourceId,
                ),
              ),
        [activePages, localForkTargetIdMap, pendingLoadMoreAnchorSourceId],
      )

      const expandedPageRange = useMemo(
        () =>
          computeExpandedPageRange({
            pages: activePages,
            measuredPageHeights,
            scrollOffsetFromBottom,
            viewportHeight,
            adjacentPageCount: PAGE_ADJACENT_OVERSCAN,
            adjacentPageMaxSourceHeight: viewportHeight * ADJACENT_PAGE_PRELOAD_VIEWPORTS,
          }),
        [activePages, measuredPageHeights, scrollOffsetFromBottom, viewportHeight],
      )

      const expandedPageSelection = useMemo(
        () => buildExpandedPageSelection(expandedPageRange, [pendingTargetPageIndex, pendingLoadMoreAnchorPageIndex]),
        [expandedPageRange, pendingLoadMoreAnchorPageIndex, pendingTargetPageIndex],
      )

      const streamingPageKeys = useMemo(() => {
        const keys = new Set<string>()
        for (const page of activePages) {
          if (pageHasStreamingMessage(page)) keys.add(page.key)
        }
        return keys
      }, [activePages])

      const renderPageSelection = useMemo(
        () =>
          expandSelectionWithPageKeys({
            pages: activePages,
            expandedPageSelection,
            pageKeys: streamingPageKeys,
          }),
        [activePages, expandedPageSelection, streamingPageKeys],
      )

      const renderSegments = useMemo(
        () =>
          buildPageRenderSegments({
            pages: activePages,
            expandedPageSelection: renderPageSelection,
            measuredPageHeights,
          }),
        [activePages, measuredPageHeights, renderPageSelection],
      )

      const clearPendingLoadMoreTimer = useCallback(() => {
        if (pendingLoadMoreTimerRef.current === null) return
        window.clearTimeout(pendingLoadMoreTimerRef.current)
        pendingLoadMoreTimerRef.current = null
      }, [])

      const clearPendingScrollTimer = useCallback(() => {
        if (pendingScrollClearTimerRef.current === null) return
        window.clearTimeout(pendingScrollClearTimerRef.current)
        pendingScrollClearTimerRef.current = null
      }, [])

      const clearPendingAnchorReleaseTimer = useCallback(() => {
        if (pendingAnchorReleaseTimerRef.current === null) return
        window.clearTimeout(pendingAnchorReleaseTimerRef.current)
        pendingAnchorReleaseTimerRef.current = null
      }, [])

      const clearPendingLoadMoreAnchorMessage = useCallback(() => {
        if (pendingAnchorClearRafRef.current !== null) cancelAnimationFrame(pendingAnchorClearRafRef.current)
        pendingAnchorClearRafRef.current = requestAnimationFrame(() => {
          pendingAnchorClearRafRef.current = null
          setPendingLoadMoreAnchorSourceId(null)
        })
      }, [])

      const releasePendingLoadMoreAnchor = useCallback(() => {
        clearPendingAnchorReleaseTimer()
        pendingLoadMoreAnchorRef.current = null
        loadMoreRequestCompletedRef.current = false
        clearPendingLoadMoreAnchorMessage()
      }, [clearPendingAnchorReleaseTimer, clearPendingLoadMoreAnchorMessage])

      const schedulePendingLoadMoreAnchorRelease = useCallback(
        (delay: number) => {
          clearPendingAnchorReleaseTimer()
          pendingAnchorReleaseTimerRef.current = window.setTimeout(() => {
            pendingAnchorReleaseTimerRef.current = null
            pendingLoadMoreAnchorRef.current = null
            loadMoreRequestCompletedRef.current = false
            clearPendingLoadMoreAnchorMessage()
          }, delay)
        },
        [clearPendingAnchorReleaseTimer, clearPendingLoadMoreAnchorMessage],
      )

      const resetSessionViewState = useCallback(() => {
        if (pendingSessionResetRafRef.current !== null) cancelAnimationFrame(pendingSessionResetRafRef.current)
        pendingSessionResetRafRef.current = requestAnimationFrame(() => {
          pendingSessionResetRafRef.current = null
          setIsLoadingMore(false)
          setMeasuredPageHeights({})
          setPendingScrollMessageId(null)
        })
      }, [])

      useEffect(() => {
        isMountedRef.current = true
        return () => {
          isMountedRef.current = false
          loadMoreRequestIdRef.current += 1
          clearPendingLoadMoreTimer()
          clearPendingScrollTimer()
          clearPendingAnchorReleaseTimer()
          if (scrollSnapshotRafRef.current !== null) cancelAnimationFrame(scrollSnapshotRafRef.current)
          if (pendingAnchorClearRafRef.current !== null) cancelAnimationFrame(pendingAnchorClearRafRef.current)
          if (pendingSessionResetRafRef.current !== null) cancelAnimationFrame(pendingSessionResetRafRef.current)
        }
      }, [clearPendingAnchorReleaseTimer, clearPendingLoadMoreTimer, clearPendingScrollTimer])

      const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
        scrollRef.current = node
        setScrollRoot(prev => (prev === node ? prev : node))
      }, [])

      const updateScrollOffsetSnapshot = useCallback(() => {
        const root = scrollRef.current
        if (!root) return

        const nextOffset = Math.abs(root.scrollTop)
        if (scrollSnapshotRafRef.current !== null) cancelAnimationFrame(scrollSnapshotRafRef.current)
        scrollSnapshotRafRef.current = requestAnimationFrame(() => {
          scrollSnapshotRafRef.current = null
          setScrollOffsetFromBottom(prev => {
            const delta = nextOffset - prev
            if (Math.abs(delta) < 1) return prev
            return nextOffset
          })
        })
      }, [])

      useEffect(() => {
        const root = scrollRoot
        if (!root || typeof ResizeObserver === 'undefined') return

        const syncViewport = () => {
          const nextSize = { width: root.clientWidth, height: root.clientHeight }
          const previousSize = lastScrollRootSizeRef.current
          const widthChanged = Math.abs(previousSize.width - nextSize.width) >= 1
          const heightChanged = Math.abs(previousSize.height - nextSize.height) >= 1

          if (widthChanged || heightChanged) {
            lastScrollRootSizeRef.current = nextSize
          }

          setViewportHeight(prev => (Math.abs(prev - nextSize.height) < 1 ? prev : nextSize.height))
        }

        syncViewport()
        const observer = new ResizeObserver(syncViewport)
        observer.observe(root)
        return () => observer.disconnect()
      }, [scrollRoot])

      useEffect(() => {
        const root = scrollRef.current
        if (!root) return

        const onScroll = () => {
          const hasOverflow = root.scrollHeight > root.clientHeight + 1
          const distFromBottom = Math.abs(root.scrollTop)
          const distFromTop = Math.max(0, root.scrollHeight - root.clientHeight - distFromBottom)
          const atBottom = !hasOverflow || distFromBottom <= atBottomThreshold
          const previous = isAtBottomRef.current
          isAtBottomRef.current = atBottom
          if (previous !== atBottom) onAtBottomChange?.(atBottom)

          if (
            loadMoreIntentAnchorRef.current === null &&
            Date.now() - lastWheelInputAtRef.current < LOAD_MORE_WHEEL_COOLDOWN_MS + LOAD_MORE_DEFER_MS &&
            distFromTop <= LOAD_MORE_ANCHOR_CAPTURE_PX
          ) {
            loadMoreIntentAnchorRef.current = captureLoadMoreAnchor(root)
          }

          updateScrollOffsetSnapshot()
        }

        const onOlderScrollIntent = () => {
          lastWheelInputAtRef.current = Date.now()
          if (pendingLoadMoreAnchorRef.current && !isLoadingRef.current) {
            releasePendingLoadMoreAnchor()
          }
          const distFromTop = Math.max(0, root.scrollHeight - root.clientHeight - Math.abs(root.scrollTop))
          loadMoreIntentAnchorRef.current = distFromTop <= 1 ? captureLoadMoreAnchor(root) : null
          loadMoreBlockedRef.current = false
          tryLoadMoreRef.current()
        }

        const onWheel = (event: WheelEvent) => {
          if (event.deltaY > 0) {
            releasePendingLoadMoreAnchor()
            return
          }
          onOlderScrollIntent()
        }

        const onKeyDown = (event: KeyboardEvent) => {
          const activeElement = document.activeElement
          const focusedScrollRoot =
            activeElement instanceof Element ? activeElement.closest('[data-chat-scroll-root]') : null
          if (focusedScrollRoot ? focusedScrollRoot !== root : !root.matches(':hover')) return
          const target = event.target
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
          ) {
            return
          }
          if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
            onOlderScrollIntent()
          } else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
            releasePendingLoadMoreAnchor()
          }
        }

        let touchStartOffset: number | null = null
        let scrollbarStartOffset: number | null = null

        const onTouchStart = () => {
          touchStartOffset = Math.abs(root.scrollTop)
        }

        const onTouchEnd = () => {
          if (touchStartOffset === null) return
          const startOffset = touchStartOffset
          touchStartOffset = null
          const nextOffset = Math.abs(root.scrollTop)
          if (nextOffset > startOffset + 1) onOlderScrollIntent()
          else if (nextOffset < startOffset - 1) releasePendingLoadMoreAnchor()
          else if (root.scrollHeight - root.clientHeight - nextOffset <= 1) onOlderScrollIntent()
        }

        const onPointerDown = (event: PointerEvent) => {
          const rect = root.getBoundingClientRect()
          if (event.clientX >= rect.right - 24) scrollbarStartOffset = Math.abs(root.scrollTop)
        }

        const onPointerUp = () => {
          if (scrollbarStartOffset === null) return
          const startOffset = scrollbarStartOffset
          scrollbarStartOffset = null
          const nextOffset = Math.abs(root.scrollTop)
          if (nextOffset > startOffset + 1) onOlderScrollIntent()
          else if (nextOffset < startOffset - 1) releasePendingLoadMoreAnchor()
        }

        root.addEventListener('scroll', onScroll, { passive: true })
        root.addEventListener('wheel', onWheel, { passive: true })
        root.addEventListener('touchstart', onTouchStart, { passive: true })
        root.addEventListener('touchend', onTouchEnd, { passive: true })
        root.addEventListener('pointerdown', onPointerDown, { passive: true })
        window.addEventListener('pointerup', onPointerUp, { passive: true })
        window.addEventListener('keydown', onKeyDown)
        updateScrollOffsetSnapshot()
        return () => {
          root.removeEventListener('scroll', onScroll)
          root.removeEventListener('wheel', onWheel)
          root.removeEventListener('touchstart', onTouchStart)
          root.removeEventListener('touchend', onTouchEnd)
          root.removeEventListener('pointerdown', onPointerDown)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('keydown', onKeyDown)
        }
      }, [atBottomThreshold, onAtBottomChange, releasePendingLoadMoreAnchor, updateScrollOffsetSnapshot])

      const prevSessionIdRef = useRef(sessionId)
      useEffect(() => {
        if (sessionId === prevSessionIdRef.current) return
        prevSessionIdRef.current = sessionId
        isAtBottomRef.current = true
        loadMoreBlockedRef.current = true
        pendingLoadMoreAnchorRef.current = null
        loadMoreIntentAnchorRef.current = null
        loadMoreRequestCompletedRef.current = false
        loadMorePagesBeforeRef.current = null
        previousActivePagesRef.current = { sessionId, pages: [] }
        clearPendingLoadMoreAnchorMessage()
        topSentinelVisibleRef.current = false
        loadMoreRequestIdRef.current += 1
        isLoadingRef.current = false
        clearPendingLoadMoreTimer()
        clearPendingAnchorReleaseTimer()
        settlingScrollMessageIdRef.current = null
        clearPendingScrollTimer()
        resetSessionViewState()
        onAtBottomChange?.(true)
        onVisibleMessageIdsChange?.([])

        requestAnimationFrame(() => {
          const root = scrollRef.current
          if (!root) return
          root.scrollTop = 0
          updateScrollOffsetSnapshot()
          animate(root, { opacity: [0, 1] }, { duration: 0.2, ease: 'easeOut' })
        })
      }, [
        clearPendingLoadMoreTimer,
        clearPendingLoadMoreAnchorMessage,
        clearPendingScrollTimer,
        clearPendingAnchorReleaseTimer,
        onAtBottomChange,
        onVisibleMessageIdsChange,
        resetSessionViewState,
        sessionId,
        updateScrollOffsetSnapshot,
        visibleMessages,
      ])

      useEffect(() => {
        if (loadState !== 'loaded') return
        requestAnimationFrame(() => {
          const root = scrollRef.current
          if (root && isAtBottomRef.current) {
            root.scrollTop = 0
            updateScrollOffsetSnapshot()
          }
        })
      }, [loadState, updateScrollOffsetSnapshot])

      const tryLoadMore = useCallback(() => {
        if (isLoadingRef.current) return
        if (!topSentinelVisibleRef.current) return
        if (loadMoreBlockedRef.current) return

        const root = scrollRef.current
        if (!root) return
        const distFromTop = Math.max(0, root.scrollHeight - root.clientHeight - Math.abs(root.scrollTop))
        if (distFromTop > LOAD_MORE_ANCHOR_CAPTURE_PX) return

        const fn = loadMoreRef.current
        if (!fn) return

        const sid = sessionId
        if (!sid) return
        const hasMore = messageStore.getSessionState(sid)?.hasMoreHistory ?? false
        if (!hasMore) return

        const sinceWheel = Date.now() - lastWheelInputAtRef.current
        if (sinceWheel < LOAD_MORE_WHEEL_COOLDOWN_MS) {
          clearPendingLoadMoreTimer()
          pendingLoadMoreTimerRef.current = window.setTimeout(() => {
            pendingLoadMoreTimerRef.current = null
            tryLoadMoreRef.current()
          }, LOAD_MORE_DEFER_MS)
          return
        }

        clearPendingAnchorReleaseTimer()
        const anchor = loadMoreIntentAnchorRef.current ?? captureLoadMoreAnchor(root)
        loadMoreIntentAnchorRef.current = null
        pendingLoadMoreAnchorRef.current = anchor
        loadMorePagesBeforeRef.current = activePages
        if (pendingAnchorClearRafRef.current !== null) {
          cancelAnimationFrame(pendingAnchorClearRafRef.current)
          pendingAnchorClearRafRef.current = null
        }
        setPendingLoadMoreAnchorSourceId(anchor?.sourceId ?? null)

        loadMoreBlockedRef.current = true
        loadMoreRequestCompletedRef.current = false
        const requestId = ++loadMoreRequestIdRef.current
        const requestSessionId = sid
        isLoadingRef.current = true
        setIsLoadingMore(true)
        Promise.resolve(fn()).finally(() => {
          if (!isMountedRef.current || loadMoreRequestIdRef.current !== requestId || sessionId !== requestSessionId) {
            return
          }
          isLoadingRef.current = false
          setIsLoadingMore(false)
          if (!pendingLoadMoreAnchorRef.current) {
            loadMoreRequestCompletedRef.current = false
            return
          }
          loadMoreRequestCompletedRef.current = true
          schedulePendingLoadMoreAnchorRelease(LOAD_MORE_ANCHOR_FALLBACK_MS)
        })
      }, [
        activePages,
        clearPendingAnchorReleaseTimer,
        clearPendingLoadMoreTimer,
        schedulePendingLoadMoreAnchorRelease,
        sessionId,
      ])

      useEffect(() => {
        tryLoadMoreRef.current = tryLoadMore
      }, [tryLoadMore])

      useEffect(() => {
        const sentinel = topSentinelRef.current
        const root = scrollRef.current
        if (!sentinel || !root) return

        const observer = new IntersectionObserver(
          ([entry]) => {
            topSentinelVisibleRef.current = entry.isIntersecting
            if (!entry.isIntersecting) {
              clearPendingLoadMoreTimer()
              return
            }
            tryLoadMore()
          },
          { root, rootMargin: LOAD_MORE_ROOT_MARGIN },
        )

        observer.observe(sentinel)
        return () => {
          observer.disconnect()
          topSentinelVisibleRef.current = false
          clearPendingLoadMoreTimer()
        }
      }, [clearPendingLoadMoreTimer, tryLoadMore, visibleMessages])

      useLayoutEffect(() => {
        const anchor = pendingLoadMoreAnchorRef.current
        const root = scrollRef.current
        if (!anchor || !root) return
        const target = findLoadMoreAnchorTarget(root, anchor)
        if (!target) return

        const rootRect = root.getBoundingClientRect()
        const nextBottomOffset = target.getBoundingClientRect().bottom - rootRect.top
        const delta = computeAnchorRestoreScrollDelta(anchor.bottomOffset, nextBottomOffset)
        if (Math.abs(delta) >= 1) {
          root.scrollTop += delta
          updateScrollOffsetSnapshot()
        }
        if (loadMoreRequestCompletedRef.current && activePages !== loadMorePagesBeforeRef.current) {
          schedulePendingLoadMoreAnchorRelease(LOAD_MORE_ANCHOR_SETTLE_MS)
        }
      }, [
        activePages,
        isLoadingMore,
        measuredPageHeights,
        renderSegments,
        schedulePendingLoadMoreAnchorRelease,
        updateScrollOffsetSnapshot,
      ])

      useLayoutEffect(() => {
        const anchor = pendingLayoutAnchorRef.current
        const root = scrollRef.current
        if (!anchor || !root) return

        const target = root.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"]`)
        pendingLayoutAnchorRef.current = null
        if (!target) return

        const rootRect = root.getBoundingClientRect()
        const nextTopOffset = target.getBoundingClientRect().top - rootRect.top
        const delta = computeAnchorRestoreScrollDelta(anchor.topOffset, nextTopOffset)
        if (Math.abs(delta) >= 1) {
          root.scrollTop += delta
          updateScrollOffsetSnapshot()
        }
      }, [activePages, measuredPageHeights, renderSegments, updateScrollOffsetSnapshot])

      const onVisibleIdsChangeRef = useRef(onVisibleMessageIdsChange)
      useEffect(() => {
        onVisibleIdsChangeRef.current = onVisibleMessageIdsChange
      }, [onVisibleMessageIdsChange])

      useEffect(() => {
        const root = scrollRef.current
        if (!root) return

        const visibleIds = new Set<string>()
        const observer = new IntersectionObserver(
          entries => {
            let changed = false
            for (const entry of entries) {
              const id = entry.target.getAttribute('data-message-id')
              if (!id) continue
              if (entry.isIntersecting) {
                if (!visibleIds.has(id)) {
                  visibleIds.add(id)
                  changed = true
                }
              } else if (visibleIds.has(id)) {
                visibleIds.delete(id)
                changed = true
              }
            }
            if (changed) onVisibleIdsChangeRef.current?.(Array.from(visibleIds))
          },
          { root, rootMargin: '100% 0px' },
        )

        const elements = root.querySelectorAll<HTMLElement>('[data-message-id]')
        elements.forEach(element => observer.observe(element))

        return () => observer.disconnect()
      }, [activePages, expandedPageRange.endIndex, expandedPageRange.startIndex])

      useEffect(() => {
        if (!pendingScrollMessageId) return
        const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${pendingScrollMessageId}"]`)
        if (!target) return
        if (settlingScrollMessageIdRef.current === pendingScrollMessageId) return

        settlingScrollMessageIdRef.current = pendingScrollMessageId
        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        clearPendingScrollTimer()
        pendingScrollClearTimerRef.current = window.setTimeout(() => {
          pendingScrollClearTimerRef.current = null
          if (settlingScrollMessageIdRef.current !== pendingScrollMessageId) return
          settlingScrollMessageIdRef.current = null
          setPendingScrollMessageId(current => (current === pendingScrollMessageId ? null : current))
        }, PENDING_SCROLL_TARGET_KEEPALIVE_MS)
      }, [
        activePages,
        clearPendingScrollTimer,
        expandedPageRange.endIndex,
        expandedPageRange.startIndex,
        pendingScrollMessageId,
      ])

      const updateMeasuredPageHeight = useCallback((pageKey: string, nextHeight: number) => {
        if (nextHeight <= 0) return
        setMeasuredPageHeights(previous => {
          const current = previous[pageKey] ?? null
          // 与测量侧阈值对齐，避免动画中途 1px 抖动触发整树更新
          if (current !== null && Math.abs(current - nextHeight) < PAGE_HEIGHT_MEASURE_MIN_DELTA_PX) {
            return previous
          }
          const root = scrollRef.current
          // steps/过程折叠正在锁 header 时，页高锚点让路，避免两个补偿互相抢 scrollTop
          if (
            root &&
            !isAtBottomRef.current &&
            !isScrollAnchorLocked() &&
            current !== null &&
            Math.abs(current - nextHeight) >= PAGE_HEIGHT_MEASURE_MIN_DELTA_PX
          ) {
            pendingLayoutAnchorRef.current = captureLoadMoreAnchor(root)
          }
          const next = { ...previous, [pageKey]: nextHeight }
          return next
        })
      }, [])

      const requestScrollToMessage = useCallback(
        (messageId: string, behavior: ScrollBehavior) => {
          const root = scrollRef.current
          if (!root) return

          const directTarget = root.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
          if (directTarget) {
            directTarget.scrollIntoView({ block: 'start', behavior })
            return
          }

          const targetPageIndex = activePages.findIndex(page => page.messageIds.includes(messageId))
          if (targetPageIndex === -1) return

          const pageOffsets = buildPageOffsets(activePages, measuredPageHeights)
          root.scrollTo({ top: -pageOffsets[targetPageIndex], behavior: behavior === 'smooth' ? 'auto' : behavior })
          updateScrollOffsetSnapshot()
          settlingScrollMessageIdRef.current = null
          clearPendingScrollTimer()
          setPendingScrollMessageId(messageId)
        },
        [activePages, clearPendingScrollTimer, measuredPageHeights, updateScrollOffsetSnapshot],
      )

      useImperativeHandle(
        ref,
        () => ({
          scrollToBottom: (instant = false) => {
            const root = scrollRef.current
            if (!root) return
            root.scrollTo({ top: 0, behavior: instant ? 'auto' : 'smooth' })
          },
          scrollToBottomIfAtBottom: () => {
            const root = scrollRef.current
            if (!root) return
            if (Math.abs(root.scrollTop) > 2) return
            root.scrollTop = 0
          },
          scrollToLastMessage: () => {
            if (visibleMessages.length === 0) return
            requestScrollToMessage(visibleMessages[visibleMessages.length - 1].info.id, 'auto')
          },
          scrollToMessageIndex: (index: number) => {
            const message = visibleMessages[index]
            if (!message) return
            requestScrollToMessage(message.info.id, 'smooth')
          },
          scrollToMessageId: (messageId: string) => {
            requestScrollToMessage(messageId, 'smooth')
          },
        }),
        [requestScrollToMessage, visibleMessages],
      )

      return (
        <div className="h-full overflow-hidden contain-strict relative">
          {loadState === 'loading' && visibleMessages.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-text-400 session-loading-indicator">
                <span className="w-5 h-5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                <span className="text-[length:var(--fs-base)]">{t('chatArea.loadingSession')}</span>
              </div>
            </div>
          )}

          <div
            ref={setScrollContainerRef}
            data-chat-scroll-root="true"
            className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar contain-content flex flex-col-reverse [overflow-anchor:none]"
          >
            <div className="flex-1" />

            <div
              className="shrink-0"
              style={{
                height: bottomPadding > 0 ? `${bottomPadding + 48}px` : '256px',
              }}
            />

            {retryStatus && (
              <div className={`w-full ${messageMaxWidthClass} mx-auto ${messagePaddingClass} shrink-0`}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0">
                    <RetryStatusInline status={retryStatus} />
                  </div>
                </div>
              </div>
            )}

            {visibleMessages.length === 0 && (loadError || connectionError) && (
              <div className={`w-full ${messageMaxWidthClass} mx-auto ${messagePaddingClass} shrink-0`}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0 space-y-2">
                    <MessageErrorView error={loadError ?? connectionError!} />
                    {connectionError && onOpenSettings && (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="rounded-md border border-border-200 bg-bg-100 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
                      >
                        Open server settings
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {renderSegments.map(segment =>
              segment.kind === 'expanded' ? (
                <PageBlock
                  key={segment.key}
                  page={segment.page}
                  messageMaxWidthClass={messageMaxWidthClass}
                  messagePaddingClass={messagePaddingClass}
                  registerMessage={registerMessage}
                  onUndo={onUndo}
                  onFork={onFork}
                  canUndo={canUndo}
                  turnDurationMap={localTurnDurationMap}
                  turnUserStartMap={localTurnUserStartMap}
                  turnLatestAssistantIds={localTurnLatestAssistantIds}
                  forkTargetIdMap={localForkTargetIdMap}
                  allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                  onMeasuredHeightChange={updateMeasuredPageHeight}
                />
              ) : (
                <CollapsedPagesBlock key={segment.key} height={segment.height} />
              ),
            )}

            {visibleMessages.length > 0 && isLoadingMore && (
              <div className="flex justify-center py-3 shrink-0">
                <div className="flex items-center gap-2 text-text-400 text-[length:var(--fs-sm)]">
                  <span className="w-3.5 h-3.5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                  {t('chatArea.loadingHistory')}
                </div>
              </div>
            )}

            <div className="mobile-chat-top-spacer shrink-0" />
            <div ref={topSentinelRef} className="h-px shrink-0" aria-hidden="true" />
          </div>
        </div>
      )
    },
  ),
)

interface PageBlockProps {
  page: ChatPage
  messageMaxWidthClass: string
  messagePaddingClass: string
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  turnDurationMap: Map<string, number>
  turnUserStartMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  forkTargetIdMap: Map<string, string | undefined>
  allowStreamingLayoutAnimation: boolean
  onMeasuredHeightChange: (pageKey: string, nextHeight: number) => void
}

interface PageDerivedValueProps {
  page: ChatPage
  turnDurationMap: Map<string, number>
  turnUserStartMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  forkTargetIdMap: Map<string, string | undefined>
}

function pageMessageDerivedValuesEqual(previous: PageDerivedValueProps, next: PageDerivedValueProps) {
  return previous.page.messageIds.every(messageId => {
    return (
      previous.turnDurationMap.get(messageId) === next.turnDurationMap.get(messageId) &&
      previous.turnUserStartMap.get(messageId) === next.turnUserStartMap.get(messageId) &&
      previous.turnLatestAssistantIds.has(messageId) === next.turnLatestAssistantIds.has(messageId) &&
      previous.forkTargetIdMap.get(messageId) === next.forkTargetIdMap.get(messageId)
    )
  })
}

export function arePageBlockPropsEqual(previous: PageBlockProps, next: PageBlockProps) {
  if (previous.page !== next.page) return false
  if (previous.messageMaxWidthClass !== next.messageMaxWidthClass) return false
  if (previous.messagePaddingClass !== next.messagePaddingClass) return false
  if (previous.registerMessage !== next.registerMessage) return false
  if (previous.onUndo !== next.onUndo && pageHasUserMessage(next.page)) return false
  if (previous.onFork !== next.onFork) return false
  if (previous.canUndo !== next.canUndo && pageHasUserMessage(next.page)) return false
  if (
    previous.allowStreamingLayoutAnimation !== next.allowStreamingLayoutAnimation &&
    (pageHasStreamingMessage(previous.page) || pageHasStreamingMessage(next.page))
  ) {
    return false
  }
  if (previous.onMeasuredHeightChange !== next.onMeasuredHeightChange) return false
  return pageMessageDerivedValuesEqual(previous, next)
}

/** 展开/流式时高度连续变，过密测量会拖着 ChatArea setState 发颤 */
const PAGE_HEIGHT_MEASURE_MIN_DELTA_PX = 4

function usePageHeightMeasurement(
  pageKey: string,
  onMeasuredHeightChange: (pageKey: string, nextHeight: number) => void,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const lastReportedHeightRef = useRef(0)
  const measureRafRef = useRef<number | null>(null)

  const flushMeasure = useCallback(() => {
    measureRafRef.current = null
    const element = wrapperRef.current
    if (!element) return
    const nextHeight = element.offsetHeight
    if (nextHeight <= 0) return
    const last = lastReportedHeightRef.current
    // 首次或变化够大才上报，避免 grid-rows 动画每帧刷 setState
    if (last > 0 && Math.abs(nextHeight - last) < PAGE_HEIGHT_MEASURE_MIN_DELTA_PX) return
    lastReportedHeightRef.current = nextHeight
    onMeasuredHeightChange(pageKey, nextHeight)
  }, [onMeasuredHeightChange, pageKey])

  const scheduleMeasure = useCallback(() => {
    if (measureRafRef.current !== null) return
    measureRafRef.current = requestAnimationFrame(flushMeasure)
  }, [flushMeasure])

  useLayoutEffect(() => {
    // 布局变化后立刻量一次（不节流阈值，保证虚拟化高度不过期）
    const element = wrapperRef.current
    if (!element) return
    const nextHeight = element.offsetHeight
    if (nextHeight <= 0) return
    lastReportedHeightRef.current = nextHeight
    onMeasuredHeightChange(pageKey, nextHeight)
  }, [onMeasuredHeightChange, pageKey])

  useEffect(() => {
    const element = wrapperRef.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current)
        measureRafRef.current = null
      }
    }
  }, [scheduleMeasure])

  return wrapperRef
}

const PageBlock = memo(function PageBlock({
  page,
  messageMaxWidthClass,
  messagePaddingClass,
  registerMessage,
  onUndo,
  onFork,
  canUndo,
  turnDurationMap,
  turnUserStartMap,
  turnLatestAssistantIds,
  forkTargetIdMap,
  allowStreamingLayoutAnimation,
  onMeasuredHeightChange,
}: PageBlockProps) {
  const wrapperRef = usePageHeightMeasurement(page.key, onMeasuredHeightChange)
  const { processCollapseEnabled } = useTheme()

  const renderMessage = (
    message: Message,
    immersiveContentScope?: 'all' | 'process' | 'final' | 'inline',
  ) => (
    <RenderedMessageItem
      key={`${message.info.id}:${immersiveContentScope ?? 'all'}`}
      messageId={message.info.id}
      anchorSourceId={forkTargetIdMap.get(message.info.id) ?? message.info.id}
      registerMessage={registerMessage}
    >
      <MessageRenderer
        message={message}
        allowStreamingLayoutAnimation={message.isStreaming ? allowStreamingLayoutAnimation : false}
        turnDuration={turnDurationMap.get(message.info.id)}
        isTurnLatestAssistant={
          message.info.role === 'assistant' ? turnLatestAssistantIds.has(message.info.id) : undefined
        }
        immersiveContentScope={immersiveContentScope}
        onUndo={message.info.role === 'user' ? onUndo : undefined}
        onFork={onFork}
        forkMessageId={forkTargetIdMap.get(message.info.id)}
        canUndo={message.info.role === 'user' ? canUndo : undefined}
        onEnsureParts={NOOP}
      />
    </RenderedMessageItem>
  )

  const renderRowShell = (
    row: ChatPage['rows'][number],
    isUser: boolean,
    content: ReactNode,
  ) => {
    const verticalPaddingClass = row.continuesFromPrevious
      ? row.continuesToNext
        ? 'pt-2 pb-0'
        : 'pt-2 pb-3'
      : row.continuesToNext
        ? 'pt-3 pb-0'
        : 'py-3'
    return (
      <div
        key={row.key}
        className={`w-full ${messageMaxWidthClass} mx-auto ${messagePaddingClass} ${verticalPaddingClass} transition-[max-width] duration-300 ease-in-out`}
      >
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
          <div className={`message-renderer-shell min-w-0 group ${!isUser ? 'w-full' : ''} flex flex-col gap-2`}>
            {content}
          </div>
        </div>
      </div>
    )
  }

  // 过程折叠：按 user → assistants 回合渲染；用户一发送就挂「处理中」计时
  if (processCollapseEnabled) {
    type TurnSeg = {
      key: string
      userRows: ChatPage['rows']
      assistantRows: ChatPage['rows']
    }
    const turns: TurnSeg[] = []
    let current: TurnSeg | null = null
    for (const row of page.rows) {
      const isUser = row.messages[0]?.info.role === 'user'
      if (isUser) {
        if (current) turns.push(current)
        current = { key: row.key, userRows: [row], assistantRows: [] }
      } else if (current) {
        current.assistantRows.push(row)
      } else {
        // 页首孤立 assistant（跨页切分）：当作无 user 的回合
        current = { key: row.key, userRows: [], assistantRows: [row] }
      }
    }
    if (current) turns.push(current)

    return (
      <div ref={wrapperRef} className="shrink-0" data-page-key={page.key}>
        {turns.map((turn, turnIndex) => {
          const assistantMessages = turn.assistantRows.flatMap(r => r.messages)
          const finalAssistant =
            assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
          const finalAssistantId = finalAssistant?.info.id ?? null
          const finalHasProcess = !!finalAssistant && messageHasImmersiveProcess(finalAssistant)
          const finalHasAnswer = !!finalAssistant && messageHasImmersiveFinal(finalAssistant)

          const processMessages = assistantMessages.filter(m => {
            if (m.info.id !== finalAssistantId) return true
            return finalHasProcess
          })
          const finalMessages =
            finalAssistant && (finalHasAnswer || !finalHasProcess) ? [finalAssistant] : []

          const waitingForFirstAssistant =
            turn.userRows.length > 0 && assistantMessages.length === 0
          const hasLiveAssistantWork = assistantMessages.some(
            m =>
              m.isStreaming ||
              m.parts.some(
                p =>
                  p.type === 'tool' &&
                  (p.state.status === 'running' || p.state.status === 'pending'),
              ),
          )
          const allAssistantsSettled =
            assistantMessages.length > 0 &&
            assistantMessages.every(m => m.info.time.completed != null) &&
            !hasLiveAssistantWork
          // 进行中必须前端实时走表：等首包 / 工具跑着 / 多步间隙 / 尚未全部 completed
          // 只有整轮真正结束后才用后端 turnDurationMap 校正
          const turnIsActive =
            waitingForFirstAssistant || hasLiveAssistantWork || !allAssistantsSettled

          // 用户发送时间：优先 map；否则取本回合 user.created
          let userStart: number | undefined
          for (const m of assistantMessages) {
            const start = turnUserStartMap.get(m.info.id)
            if (start != null) {
              userStart = start
              break
            }
          }
          if (userStart == null) {
            for (const row of turn.userRows) {
              const created = row.messages[0]?.info.time.created
              if (created != null) {
                userStart = created
                break
              }
            }
          }
          if (userStart == null && assistantMessages[0]) {
            userStart = assistantMessages[0].info.time.created
          }

          // 整轮结束后的校正时长；进行中由 ImmersiveProcessHeader 用 startedAt 本地走表
          const settledDurationMs = (() => {
            if (turnIsActive || userStart == null) return undefined
            for (const m of [...assistantMessages].reverse()) {
              const mapped = turnDurationMap.get(m.info.id)
              if (mapped != null && mapped > 0) return mapped
            }
            const last = assistantMessages[assistantMessages.length - 1]
            const end = last?.info.time.completed
            if (end != null && end > userStart) return end - userStart
            return 0
          })()

          // 有过程、或用户已发还在等/跑 → 显示过程块
          const showProcessBlock = processMessages.length > 0 || turnIsActive
          // 跨页续段：本页没有 user、且 row 标记 continuesFromPrevious → 不重复套「已处理」外壳
          const isTurnContinuation =
            turn.userRows.length === 0 &&
            !!turn.assistantRows[0]?.continuesFromPrevious
          // 稳定 stateKey：优先 user 发送时间，避免流结束后 key 变化导致重挂两个块
          const processStateKey =
            userStart != null
              ? `turn-process:start:${userStart}`
              : `turn-process:key:${turn.key}`

          const processBody = processMessages.map(message =>
            renderMessage(message, message.info.id === finalAssistantId ? 'process' : 'inline'),
          )

          return (
            <div key={turn.key} className="contents">
              {turn.userRows.map(row =>
                renderRowShell(
                  row,
                  true,
                  row.messages.map(message => renderMessage(message)),
                ),
              )}
              {(showProcessBlock || finalMessages.length > 0 || turn.assistantRows.length > 0) && (
                renderRowShell(
                  turn.assistantRows[0] ??
                    ({
                      key: `${turn.key}:process`,
                      messages: [],
                      messageIds: [],
                      estimatedHeight: 40,
                      continuesFromPrevious: false,
                      continuesToNext: turnIndex < turns.length - 1,
                    } as ChatPage['rows'][number]),
                  false,
                  <>
                    {showProcessBlock &&
                      (isTurnContinuation ? (
                        // 续页只渲染过程内容，不再套一层「已处理」
                        <div className="flex flex-col gap-2">{processBody}</div>
                      ) : (
                        <ImmersiveProcessBlock
                          stateKey={processStateKey}
                          startedAt={userStart}
                          durationMs={settledDurationMs}
                          isActive={turnIsActive}
                        >
                          {processBody}
                        </ImmersiveProcessBlock>
                      ))}
                    {finalMessages.map(message =>
                      renderMessage(message, finalHasProcess ? 'final' : 'all'),
                    )}
                  </>,
                )
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className="shrink-0" data-page-key={page.key}>
      {page.rows.map(row => {
        const isUser = row.messages[0].info.role === 'user'
        return renderRowShell(
          row,
          isUser,
          row.messages.map(message => renderMessage(message)),
        )
      })}
    </div>
  )
}, arePageBlockPropsEqual)

const CollapsedPagesBlock = memo(function CollapsedPagesBlock({ height }: { height: number }) {
  return <div className="shrink-0" style={{ height: `${height}px`, overflowAnchor: 'none' }} aria-hidden="true" />
})

interface RenderedMessageItemProps {
  messageId: string
  anchorSourceId: string
  registerMessage?: (id: string, element: HTMLElement | null) => void
  children: ReactNode
}

const RenderedMessageItem = memo(function RenderedMessageItem({
  messageId,
  anchorSourceId,
  registerMessage,
  children,
}: RenderedMessageItemProps) {
  const setElement = useCallback(
    (node: HTMLDivElement | null) => {
      registerMessage?.(messageId, node)
    },
    [messageId, registerMessage],
  )

  return (
    <div ref={setElement} data-message-id={messageId} data-anchor-source-id={anchorSourceId}>
      {children}
    </div>
  )
})
