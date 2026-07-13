// ============================================
// ChatArea - 聊天消息显示区域
// ============================================
//
// 这版使用粗颗粒页块级虚拟化 + 正向 flex-col：
// - 消息以 20 条为主分块，渲染重量只限制极端页面
// - 视口附近少量页保持真实 DOM；远页折叠成固定高度块
// - pages[0]=最新，渲染时倒序，视觉上旧→新
// - 贴底时 ResizeObserver 钉 scrollTop，流式自然跟底

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
import { MessageRenderer } from '../message'
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
/** 跟流阈值：比 UI 贴底阈值更紧，避免轻微上滚仍被拽回 */
const STICK_FOLLOW_THRESHOLD_PX = 24

/** 正向 column：距底部距离 */
function getDistanceFromBottom(root: HTMLElement) {
  return Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
}

function getDistanceFromTop(root: HTMLElement) {
  return Math.max(0, root.scrollTop)
}

function scrollRootToBottom(root: HTMLElement, behavior: ScrollBehavior = 'auto') {
  const top = Math.max(0, root.scrollHeight - root.clientHeight)
  if (behavior === 'smooth') root.scrollTo({ top, behavior })
  else root.scrollTop = top
}

function isStuckToBottom(root: HTMLElement, threshold = STICK_FOLLOW_THRESHOLD_PX) {
  return getDistanceFromBottom(root) <= threshold
}

/**
 * 贴底跟流意图：只被用户主动离开底部打断。
 * 内容暴涨时浏览器会暂时增大 distFromBottom；若用距离判断会误停跟流。
 * 因此 pin 只看 stickyFollow，不看瞬时距离。
 */

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
      const chatContentRef = useRef<HTMLDivElement>(null)
      const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
      const topSentinelRef = useRef<HTMLDivElement>(null)
      const isAtBottomRef = useRef(true)
      /** 跟流意图：默认 true；仅用户上滚离开底部后 false；回到底部/点回底 true */
      const stickyFollowRef = useRef(true)
      /** 程序化钉底中：忽略 scroll 事件对 isAtBottom 的误判 */
      const pinningToBottomRef = useRef(false)
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
      // 给 rAF 里判断「展开页是否会变」用，避免在 setState updater 里做副作用
      const scrollOffsetFromBottomRef = useRef(0)
      const viewportHeightRef = useRef(0)
      const measuredPageHeightsRef = useRef<Record<string, number>>({})
      const activePagesRef = useRef<StableChatPage[]>([])

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
      const localTurnLatestAssistantIds = useMemo(
        () => turnLatestAssistantIdsProp ?? buildTurnLatestAssistantIdSet(visibleMessages),
        [turnLatestAssistantIdsProp, visibleMessages],
      )

      const activePages = pageRecords ?? pages
      activePagesRef.current = activePages
      scrollOffsetFromBottomRef.current = scrollOffsetFromBottom
      viewportHeightRef.current = viewportHeight
      measuredPageHeightsRef.current = measuredPageHeights

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

        if (scrollSnapshotRafRef.current !== null) cancelAnimationFrame(scrollSnapshotRafRef.current)
        scrollSnapshotRafRef.current = requestAnimationFrame(() => {
          scrollSnapshotRafRef.current = null
          const liveRoot = scrollRef.current
          if (!liveRoot) return

          const liveOffset = getDistanceFromBottom(liveRoot)
          const previousOffset = scrollOffsetFromBottomRef.current
          if (Math.abs(liveOffset - previousOffset) < 1) return

          // 只有展开页集合真会变时才钉锚点，避免每次滚动都 restore 和用户手感打架
          if (!isAtBottomRef.current && !isScrollAnchorLocked()) {
            const pages = activePagesRef.current
            const heights = measuredPageHeightsRef.current
            const viewport = viewportHeightRef.current
            if (pages.length > 0 && viewport > 0) {
              const previousRange = computeExpandedPageRange({
                pages,
                measuredPageHeights: heights,
                scrollOffsetFromBottom: previousOffset,
                viewportHeight: viewport,
                adjacentPageCount: PAGE_ADJACENT_OVERSCAN,
                adjacentPageMaxSourceHeight: viewport * ADJACENT_PAGE_PRELOAD_VIEWPORTS,
              })
              const nextRange = computeExpandedPageRange({
                pages,
                measuredPageHeights: heights,
                scrollOffsetFromBottom: liveOffset,
                viewportHeight: viewport,
                adjacentPageCount: PAGE_ADJACENT_OVERSCAN,
                adjacentPageMaxSourceHeight: viewport * ADJACENT_PAGE_PRELOAD_VIEWPORTS,
              })
              if (
                previousRange.startIndex !== nextRange.startIndex ||
                previousRange.endIndex !== nextRange.endIndex
              ) {
                const anchor = captureLoadMoreAnchor(liveRoot)
                if (anchor) pendingLayoutAnchorRef.current = anchor
              }
            }
          }

          scrollOffsetFromBottomRef.current = liveOffset
          setScrollOffsetFromBottom(liveOffset)
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
          // 程序化钉底过程中：强制保持贴底态，避免内容暴涨瞬间误关跟流
          if (pinningToBottomRef.current) {
            if (!isAtBottomRef.current) {
              isAtBottomRef.current = true
              onAtBottomChange?.(true)
            }
            updateScrollOffsetSnapshot()
            return
          }

          const hasOverflow = root.scrollHeight > root.clientHeight + 1
          const distFromBottom = getDistanceFromBottom(root)
          const distFromTop = getDistanceFromTop(root)
          const atBottom = !hasOverflow || distFromBottom <= atBottomThreshold
          const previous = isAtBottomRef.current
          isAtBottomRef.current = atBottom
          if (previous !== atBottom) onAtBottomChange?.(atBottom)

          // 用户回到底部 → 恢复跟流；明显离开底部且已有上滚意图 → 停跟流
          if (atBottom || distFromBottom <= STICK_FOLLOW_THRESHOLD_PX) {
            stickyFollowRef.current = true
          }

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
          // 用户主动往上看：立刻停止跟流（不要等距离阈值，避免和钉底抢）
          stickyFollowRef.current = false
          if (pendingLoadMoreAnchorRef.current && !isLoadingRef.current) {
            releasePendingLoadMoreAnchor()
          }
          const distFromTop = getDistanceFromTop(root)
          loadMoreIntentAnchorRef.current = distFromTop <= 1 ? captureLoadMoreAnchor(root) : null
          loadMoreBlockedRef.current = false
          tryLoadMoreRef.current()
        }

        const onWheel = (event: WheelEvent) => {
          // 正向：deltaY < 0 往上看更老；deltaY > 0 往下贴底
          if (event.deltaY > 0) {
            releasePendingLoadMoreAnchor()
            // 往下滚时若已近底，恢复跟流
            if (isStuckToBottom(root, atBottomThreshold)) stickyFollowRef.current = true
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
          touchStartOffset = getDistanceFromBottom(root)
        }

        const onTouchEnd = () => {
          if (touchStartOffset === null) return
          const startOffset = touchStartOffset
          touchStartOffset = null
          const nextOffset = getDistanceFromBottom(root)
          // 距底变大 = 往上翻历史
          if (nextOffset > startOffset + 1) onOlderScrollIntent()
          else if (nextOffset < startOffset - 1) releasePendingLoadMoreAnchor()
          else if (getDistanceFromTop(root) <= 1) onOlderScrollIntent()
        }

        const onPointerDown = (event: PointerEvent) => {
          const rect = root.getBoundingClientRect()
          if (event.clientX >= rect.right - 24) scrollbarStartOffset = getDistanceFromBottom(root)
        }

        const onPointerUp = () => {
          if (scrollbarStartOffset === null) return
          const startOffset = scrollbarStartOffset
          scrollbarStartOffset = null
          const nextOffset = getDistanceFromBottom(root)
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
        stickyFollowRef.current = true
        pinningToBottomRef.current = false
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
          stickyFollowRef.current = true
          scrollRootToBottom(root)
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
            scrollRootToBottom(root)
            updateScrollOffsetSnapshot()
          }
        })
      }, [loadState, updateScrollOffsetSnapshot])

      const pinToBottomIfFollowing = useCallback(() => {
        const root = scrollRef.current
        if (!root || !stickyFollowRef.current) return false

        const maxTop = Math.max(0, root.scrollHeight - root.clientHeight)
        // 已在底：仍可能下一帧继续长高，轻量再钉，不打断 pinning 状态机
        if (Math.abs(root.scrollTop - maxTop) < 1) {
          root.scrollTop = maxTop
          isAtBottomRef.current = true
          return true
        }

        pinningToBottomRef.current = true
        const before = root.scrollTop
        scrollRootToBottom(root)
        isAtBottomRef.current = true

        // 双 rAF：工具块/图片连挂时第二帧再钉，避免半途 dist 飙高误关 UI 贴底
        requestAnimationFrame(() => {
          if (stickyFollowRef.current) {
            scrollRootToBottom(root)
            isAtBottomRef.current = true
          }
          requestAnimationFrame(() => {
            pinningToBottomRef.current = false
            if (stickyFollowRef.current) {
              scrollRootToBottom(root)
              isAtBottomRef.current = true
            }
            if (Math.abs(root.scrollTop - before) >= 1) updateScrollOffsetSnapshot()
          })
        })
        return true
      }, [updateScrollOffsetSnapshot])

      // 贴底跟流：只看 stickyFollow 意图 + 内容壳高度，不看瞬时 distFromBottom
      useEffect(() => {
        const root = scrollRoot
        const content = chatContentRef.current
        if (!root || !content || typeof ResizeObserver === 'undefined') return

        const ro = new ResizeObserver(() => {
          pinToBottomIfFollowing()
        })
        ro.observe(content)
        return () => ro.disconnect()
      }, [pinToBottomIfFollowing, scrollRoot, sessionId, visibleMessages.length])

      // React 提交后（批量工具块挂载）再钉一次，补 RO 可能晚一拍的情况
      useLayoutEffect(() => {
        if (!stickyFollowRef.current) return
        pinToBottomIfFollowing()
      }, [pinToBottomIfFollowing, activePages, measuredPageHeights, renderSegments, _isStreaming])

      const tryLoadMore = useCallback(() => {
        if (isLoadingRef.current) return
        if (!topSentinelVisibleRef.current) return
        if (loadMoreBlockedRef.current) return

        const root = scrollRef.current
        if (!root) return
        const distFromTop = getDistanceFromTop(root)
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

        // 找不到目标就保留锚点，等下一次 layout（页刚展开时可能晚一帧）
        const target = findLoadMoreAnchorTarget(root, anchor)
        if (!target) return
        pendingLayoutAnchorRef.current = null

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
        const current = measuredPageHeightsRef.current[pageKey] ?? null
        if (current !== null && Math.abs(current - nextHeight) < 1) return

        const root = scrollRef.current
        // 仅“二次测高”时钉锚点（图片/iframe 异步长高）。
        // 首次测高不钉：折叠→展开由 offset 变更前的锚点负责，避免盖掉预锚点。
        if (
          root &&
          !isAtBottomRef.current &&
          !isScrollAnchorLocked() &&
          current !== null &&
          Math.abs(current - nextHeight) >= 1 &&
          pendingLayoutAnchorRef.current === null
        ) {
          const anchor = captureLoadMoreAnchor(root)
          if (anchor) pendingLayoutAnchorRef.current = anchor
        }

        setMeasuredPageHeights(previous => {
          const prevHeight = previous[pageKey] ?? null
          if (prevHeight !== null && Math.abs(prevHeight - nextHeight) < 1) return previous
          const next = { ...previous, [pageKey]: nextHeight }
          measuredPageHeightsRef.current = next
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

          // pages[0]=最新在底：距顶 = 总高 - 页底偏移
          const pageOffsets = buildPageOffsets(activePages, measuredPageHeights)
          const total = pageOffsets[pageOffsets.length - 1] ?? 0
          const top = Math.max(0, total - pageOffsets[targetPageIndex + 1])
          root.scrollTo({ top, behavior: behavior === 'smooth' ? 'auto' : behavior })
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
            stickyFollowRef.current = true
            isAtBottomRef.current = true
            onAtBottomChange?.(true)
            scrollRootToBottom(root, instant ? 'auto' : 'smooth')
          },
          scrollToBottomIfAtBottom: () => {
            const root = scrollRef.current
            if (!root) return
            // 跟流意图在就钉；不要用瞬时距离（工具块暴涨时会误判）
            if (!stickyFollowRef.current) return
            pinToBottomIfFollowing()
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
        [onAtBottomChange, pinToBottomIfFollowing, requestScrollToMessage, visibleMessages],
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
            className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar contain-content flex flex-col"
          >
            {/* 正向：顶 = 更老历史；底 = 最新 + 输入区占位 */}
            <div ref={topSentinelRef} className="h-px shrink-0" aria-hidden="true" />
            <div className="mobile-chat-top-spacer shrink-0" />

            {visibleMessages.length > 0 && isLoadingMore && (
              <div className="relative shrink-0 h-0 overflow-visible pointer-events-none" aria-hidden="true">
                <div className="absolute left-0 right-0 top-2 z-10 flex justify-center">
                  <div className="flex items-center gap-2 rounded-full bg-bg-100/90 px-3 py-1.5 text-text-400 text-[length:var(--fs-sm)] shadow-sm">
                    <span className="w-3.5 h-3.5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                    {t('chatArea.loadingHistory')}
                  </div>
                </div>
              </div>
            )}

            {/* 短会话顶上 flex-1，内容沉底 */}
            <div className="flex-1 shrink-0 min-h-0" aria-hidden="true" />

            {/* 消息内容壳：贴底跟流只观察这一层的高度变化 */}
            <div ref={chatContentRef} className="shrink-0 w-full">
              {/* pages[0]=最新：倒序渲染 → 视觉上旧→新 */}
              {[...renderSegments].reverse().map(segment =>
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
                    turnLatestAssistantIds={localTurnLatestAssistantIds}
                    forkTargetIdMap={localForkTargetIdMap}
                    allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                    onMeasuredHeightChange={updateMeasuredPageHeight}
                  />
                ) : (
                  <CollapsedPagesBlock key={segment.key} height={segment.height} />
                ),
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

              {retryStatus && (
                <div className={`w-full ${messageMaxWidthClass} mx-auto ${messagePaddingClass} shrink-0`}>
                  <div className="flex justify-start">
                    <div className="w-full min-w-0">
                      <RetryStatusInline status={retryStatus} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div
              className="shrink-0"
              style={{
                height: bottomPadding > 0 ? `${bottomPadding + 48}px` : '256px',
              }}
            />
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
  turnLatestAssistantIds: Set<string>
  forkTargetIdMap: Map<string, string | undefined>
  allowStreamingLayoutAnimation: boolean
  onMeasuredHeightChange: (pageKey: string, nextHeight: number) => void
}

interface PageDerivedValueProps {
  page: ChatPage
  turnDurationMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  forkTargetIdMap: Map<string, string | undefined>
}

function pageMessageDerivedValuesEqual(previous: PageDerivedValueProps, next: PageDerivedValueProps) {
  return previous.page.messageIds.every(messageId => {
    return (
      previous.turnDurationMap.get(messageId) === next.turnDurationMap.get(messageId) &&
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

function usePageHeightMeasurement(
  pageKey: string,
  onMeasuredHeightChange: (pageKey: string, nextHeight: number) => void,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    const element = wrapperRef.current
    if (!element) return
    onMeasuredHeightChange(pageKey, element.offsetHeight)
  }, [onMeasuredHeightChange, pageKey])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const element = wrapperRef.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

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
  turnLatestAssistantIds,
  forkTargetIdMap,
  allowStreamingLayoutAnimation,
  onMeasuredHeightChange,
}: PageBlockProps) {
  const wrapperRef = usePageHeightMeasurement(page.key, onMeasuredHeightChange)

  return (
    <div ref={wrapperRef} className="shrink-0" data-page-key={page.key}>
      {page.rows.map(row => {
        const isUser = row.messages[0].info.role === 'user'
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
                {row.messages.map(message => (
                  <RenderedMessageItem
                    key={message.info.id}
                    messageId={message.info.id}
                    anchorSourceId={forkTargetIdMap.get(message.info.id) ?? message.info.id}
                    registerMessage={registerMessage}
                  >
                    <MessageRenderer
                      message={message}
                      allowStreamingLayoutAnimation={message.isStreaming ? allowStreamingLayoutAnimation : false}
                      turnDuration={turnDurationMap.get(message.info.id)}
                      isTurnLatestAssistant={
                        message.info.role === 'assistant'
                          ? turnLatestAssistantIds.has(message.info.id)
                          : undefined
                      }
                      onUndo={message.info.role === 'user' ? onUndo : undefined}
                      onFork={onFork}
                      forkMessageId={forkTargetIdMap.get(message.info.id)}
                      canUndo={message.info.role === 'user' ? canUndo : undefined}
                      onEnsureParts={NOOP}
                    />
                  </RenderedMessageItem>
                ))}
              </div>
            </div>
          </div>
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
