// ============================================
// ChatArea - 聊天消息显示区域
// ============================================
//
// 这版使用页块级虚拟化：
// - 消息以 10 个渲染单元为主分块，渲染重量只限制极端页面
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
import { ImmersiveProcessBlock, MessageRenderer, messageHasImmersiveFinal } from '../message'
import { MessageErrorView } from '../message/parts'
import { messageStore } from '../../store'
import { useTheme } from '../../hooks/useTheme'
import type { Message, MessageError } from '../../types/message'
import { RetryStatusInline, type RetryStatusInlineData } from './RetryStatusInline'
import {
  buildVisibleMessageEntries,
  findActiveTurnAssistantId,
  getVisibleMessageForkTargetId,
} from './chatAreaVisibility'
import { AT_BOTTOM_THRESHOLD_PX } from '../../constants'
import { useChatViewport } from './chatViewport'
import {
  buildContentKeyedChatPages,
  buildPageOffsets,
  buildHistoryPrefetchAttemptKey,
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  buildTurnUserStartMap,
  PAGE_EXTREME_RENDER_WEIGHT,
  PAGE_MESSAGE_COUNT,
  seedMeasuredPageHeightsFromPreviousPages,
  shouldPrefetchHistory,
  type ChatPage,
  type StableChatPage,
} from './chatPageModel'

const LOAD_MORE_ROOT_MARGIN = '240px 0px 0px 0px'
const LOAD_MORE_WHEEL_COOLDOWN_MS = 90
const LOAD_MORE_DEFER_MS = 100
const PENDING_SCROLL_TARGET_KEEPALIVE_MS = 900
const PAGE_WINDOW_ROOT_MARGIN_VIEWPORTS = 3
const PREFETCH_PAGE_RESERVE = 2
const INITIAL_EXPANDED_PAGE_COUNT = 1

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
        isStreaming = false,
        allowStreamingLayoutAnimation = true,
        loadState = 'idle',
        loadError,
        connectionError,
        onOpenSettings,
        onLoadMore,
        onUndo,
        onFork,
        canUndo,
        hasMoreHistory = false,
        registerMessage,
        retryStatus = null,
        bottomPadding = 0,
        onVisibleMessageIdsChange,
        onAtBottomChange,
      },
      ref,
    ) => {
      const { t } = useTranslation('chat')
      const { processCollapseEnabled } = useTheme()
      const scrollRef = useRef<HTMLDivElement>(null)
      const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
      const topSentinelRef = useRef<HTMLDivElement>(null)
      const isAtBottomRef = useRef(true)
      const loadMoreRef = useRef(onLoadMore)
      const isLoadingRef = useRef(false)
      const [isLoadingMore, setIsLoadingMore] = useState(false)
      const [hasLeftBottom, setHasLeftBottom] = useState(false)
      const [viewportHeight, setViewportHeight] = useState(0)
      const [measuredPageHeights, setMeasuredPageHeights] = useState<Record<string, number>>({})
      const [observedPageKeys, setObservedPageKeys] = useState<Set<string>>(new Set())
      const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null)
      const pendingLoadMoreTimerRef = useRef<number | null>(null)
      const pendingScrollClearTimerRef = useRef<number | null>(null)
      const pendingSessionResetRafRef = useRef<number | null>(null)
      const lastScrollRootSizeRef = useRef({ width: 0, height: 0 })
      const previousActivePagesRef = useRef<{
        sessionId?: string | null
        processCollapseEnabled: boolean
        pages: StableChatPage[]
      }>({ processCollapseEnabled, pages: [] })
      const settlingScrollMessageIdRef = useRef<string | null>(null)
      const loadMoreRequestIdRef = useRef(0)
      const isMountedRef = useRef(true)
      const topSentinelVisibleRef = useRef(false)
      const prefetchAttemptKeyRef = useRef<string | null>(null)
      const pageSlotElementsRef = useRef<Map<string, HTMLDivElement>>(new Map())
      const premeasureCommitRafRef = useRef<number | null>(null)
      const pendingPremeasureRef = useRef<{ pageKey: string; height: number } | null>(null)
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
      const pages = useMemo<StableChatPage[]>(() => {
        if (shouldUseExternalViewModel) return []
        const modeKey = processCollapseEnabled ? 'collapsed' : 'standard'
        return buildContentKeyedChatPages(
          visibleMessages,
          PAGE_MESSAGE_COUNT,
          PAGE_EXTREME_RENDER_WEIGHT,
          PAGE_MESSAGE_COUNT,
          processCollapseEnabled,
        ).map(page => ({ ...page, key: `${modeKey}:${page.key}` }))
      }, [shouldUseExternalViewModel, visibleMessages, processCollapseEnabled])
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
      const activeTurnAssistantId = useMemo(
        () => findActiveTurnAssistantId(visibleMessages, isStreaming),
        [isStreaming, visibleMessages],
      )

      const activePages = pageRecords ?? pages

      useLayoutEffect(() => {
        const previous = previousActivePagesRef.current
        previousActivePagesRef.current = { sessionId, processCollapseEnabled, pages: activePages }
        if (
          previous.sessionId !== sessionId ||
          previous.processCollapseEnabled !== processCollapseEnabled ||
          previous.pages.length === 0 ||
          activePages.length === 0
        ) {
          return
        }

        setMeasuredPageHeights(current => {
          const seeded = seedMeasuredPageHeightsFromPreviousPages({
            pages: activePages,
            previousPages: previous.pages,
            measuredPageHeights: current,
          })
          if (seeded === current) return current
          return seeded
        })
      }, [activePages, processCollapseEnabled, sessionId])

      const pendingTargetPageIndex = useMemo(
        () =>
          pendingScrollMessageId == null
            ? -1
            : activePages.findIndex(page => page.messageIds.includes(pendingScrollMessageId)),
        [activePages, pendingScrollMessageId],
      )

      const streamingPageKeys = useMemo(() => {
        const keys = new Set<string>()
        for (const page of activePages) {
          if (pageHasStreamingMessage(page)) keys.add(page.key)
        }
        return keys
      }, [activePages])

      const registerPageSlot = useCallback((pageKey: string, node: HTMLDivElement | null) => {
        if (node) pageSlotElementsRef.current.set(pageKey, node)
        else pageSlotElementsRef.current.delete(pageKey)
      }, [])

      const pageKeySignature = useMemo(() => activePages.map(page => page.key).join('\u0000'), [activePages])
      useEffect(() => {
        const root = scrollRoot
        if (!root || typeof IntersectionObserver === 'undefined') return

        const activePageKeys = new Set(pageKeySignature ? pageKeySignature.split('\u0000') : [])
        const rootMargin = Math.max(1, viewportHeight || root.clientHeight) * PAGE_WINDOW_ROOT_MARGIN_VIEWPORTS
        const pageDistances = new Map<string, number>()
        const observer = new IntersectionObserver(
          entries => {
            for (const entry of entries) {
              const pageKey = (entry.target as HTMLElement).dataset.pageKey
              if (!pageKey) continue
              if (!entry.isIntersecting) {
                pageDistances.delete(pageKey)
                continue
              }
              const rootBounds = entry.rootBounds
              const distance = !rootBounds
                ? 0
                : entry.boundingClientRect.bottom < rootBounds.top
                  ? rootBounds.top - entry.boundingClientRect.bottom
                  : entry.boundingClientRect.top > rootBounds.bottom
                    ? entry.boundingClientRect.top - rootBounds.bottom
                    : 0
              pageDistances.set(pageKey, distance)
            }

            setObservedPageKeys(previous => {
              const next = new Set(
                [...pageDistances.entries()]
                  .filter(([key]) => activePageKeys.has(key))
                  .sort((a, b) => a[1] - b[1])
                  .map(([key]) => key),
              )
              if (next.size === previous.size && [...next].every(key => previous.has(key))) return previous
              return next
            })
          },
          { root, rootMargin: `${rootMargin}px 0px ${rootMargin}px 0px` },
        )

        for (const element of pageSlotElementsRef.current.values()) observer.observe(element)
        return () => observer.disconnect()
      }, [pageKeySignature, scrollRoot, viewportHeight])

      const expandedPageKeys = useMemo(() => {
        const activeKeys = new Set(activePages.map(page => page.key))
        const keys = new Set<string>()
        for (let index = 0; index < Math.min(INITIAL_EXPANDED_PAGE_COUNT, activePages.length); index += 1) {
          keys.add(activePages[index].key)
        }
        for (const key of observedPageKeys) {
          if (activeKeys.has(key) && measuredPageHeights[key] != null) keys.add(key)
        }
        for (const key of streamingPageKeys) keys.add(key)
        if (
          pendingTargetPageIndex >= 0 &&
          measuredPageHeights[activePages[pendingTargetPageIndex].key] != null
        ) {
          keys.add(activePages[pendingTargetPageIndex].key)
        }
        return keys
      }, [
        activePages,
        measuredPageHeights,
        observedPageKeys,
        pendingTargetPageIndex,
        streamingPageKeys,
      ])

      const premeasurePage = useMemo(() => {
        const pendingTargetPage = pendingTargetPageIndex >= 0 ? activePages[pendingTargetPageIndex] : null
        if (pendingTargetPage && measuredPageHeights[pendingTargetPage.key] == null) return pendingTargetPage
        for (const pageKey of observedPageKeys) {
          if (measuredPageHeights[pageKey] != null || streamingPageKeys.has(pageKey)) continue
          const page = activePages.find(candidate => candidate.key === pageKey)
          if (page) return page
        }
        return null
      }, [activePages, measuredPageHeights, observedPageKeys, pendingTargetPageIndex, streamingPageKeys])

      const expandedPageRange = useMemo(() => {
        let startIndex = Number.POSITIVE_INFINITY
        let endIndex = -1
        for (let index = 0; index < activePages.length; index += 1) {
          const pageKey = activePages[index].key
          if (!expandedPageKeys.has(pageKey) && !observedPageKeys.has(pageKey)) continue
          startIndex = Math.min(startIndex, index)
          endIndex = index
        }
        return {
          startIndex: Number.isFinite(startIndex) ? startIndex : 0,
          endIndex,
        }
      }, [activePages, expandedPageKeys, observedPageKeys])

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

      const resetSessionViewState = useCallback(() => {
        if (pendingSessionResetRafRef.current !== null) cancelAnimationFrame(pendingSessionResetRafRef.current)
        pendingSessionResetRafRef.current = requestAnimationFrame(() => {
          pendingSessionResetRafRef.current = null
          setIsLoadingMore(false)
          setMeasuredPageHeights({})
          setObservedPageKeys(new Set())
          setHasLeftBottom(false)
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
          if (pendingSessionResetRafRef.current !== null) cancelAnimationFrame(pendingSessionResetRafRef.current)
        }
      }, [clearPendingLoadMoreTimer, clearPendingScrollTimer])

      const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
        scrollRef.current = node
        setScrollRoot(prev => (prev === node ? prev : node))
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
          const atBottom = !hasOverflow || distFromBottom <= atBottomThreshold
          const previous = isAtBottomRef.current
          isAtBottomRef.current = atBottom
          if (previous !== atBottom) onAtBottomChange?.(atBottom)
          if (previous && !atBottom) setHasLeftBottom(true)
        }

        const onOlderScrollIntent = () => {
          lastWheelInputAtRef.current = Date.now()
          loadMoreBlockedRef.current = false
          tryLoadMoreRef.current()
        }

        const onWheel = (event: WheelEvent) => {
          if (event.deltaY < 0) onOlderScrollIntent()
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
        }

        root.addEventListener('scroll', onScroll, { passive: true })
        root.addEventListener('wheel', onWheel, { passive: true })
        root.addEventListener('touchstart', onTouchStart, { passive: true })
        root.addEventListener('touchend', onTouchEnd, { passive: true })
        root.addEventListener('pointerdown', onPointerDown, { passive: true })
        window.addEventListener('pointerup', onPointerUp, { passive: true })
        window.addEventListener('keydown', onKeyDown)
        return () => {
          root.removeEventListener('scroll', onScroll)
          root.removeEventListener('wheel', onWheel)
          root.removeEventListener('touchstart', onTouchStart)
          root.removeEventListener('touchend', onTouchEnd)
          root.removeEventListener('pointerdown', onPointerDown)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('keydown', onKeyDown)
        }
      }, [atBottomThreshold, onAtBottomChange])

      const prevSessionIdRef = useRef(sessionId)
      useEffect(() => {
        if (sessionId === prevSessionIdRef.current) return
        prevSessionIdRef.current = sessionId
        isAtBottomRef.current = true
        loadMoreBlockedRef.current = true
        previousActivePagesRef.current = { sessionId, processCollapseEnabled, pages: [] }
        topSentinelVisibleRef.current = false
        loadMoreRequestIdRef.current += 1
        prefetchAttemptKeyRef.current = null
        setObservedPageKeys(new Set())
        isLoadingRef.current = false
        clearPendingLoadMoreTimer()
        settlingScrollMessageIdRef.current = null
        clearPendingScrollTimer()
        resetSessionViewState()
        onAtBottomChange?.(true)
        onVisibleMessageIdsChange?.([])

        requestAnimationFrame(() => {
          const root = scrollRef.current
          if (!root) return
          root.scrollTop = 0
          animate(root, { opacity: [0, 1] }, { duration: 0.2, ease: 'easeOut' })
        })
      }, [
        clearPendingLoadMoreTimer,
        clearPendingScrollTimer,
        onAtBottomChange,
        onVisibleMessageIdsChange,
        processCollapseEnabled,
        resetSessionViewState,
        sessionId,
        visibleMessages,
      ])

      useEffect(() => {
        if (loadState !== 'loaded') return
        requestAnimationFrame(() => {
          const root = scrollRef.current
          if (root && isAtBottomRef.current) {
            root.scrollTop = 0
          }
        })
      }, [loadState])

      const tryLoadMore = useCallback(() => {
        if (isLoadingRef.current) return
        if (!topSentinelVisibleRef.current) return
        if (loadMoreBlockedRef.current) return

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

        loadMoreBlockedRef.current = true
        const requestId = ++loadMoreRequestIdRef.current
        const requestSessionId = sid
        isLoadingRef.current = true
        setIsLoadingMore(true)
        Promise.resolve(fn())
          .catch(() => undefined)
          .finally(() => {
            if (!isMountedRef.current || loadMoreRequestIdRef.current !== requestId || sessionId !== requestSessionId) {
              return
            }
            isLoadingRef.current = false
            setIsLoadingMore(false)
          })
      }, [clearPendingLoadMoreTimer, sessionId])

      useEffect(() => {
        tryLoadMoreRef.current = tryLoadMore
      }, [tryLoadMore])

      const prefetchLoadMore = useCallback(async () => {
        if (isLoadingRef.current) return
        const fn = loadMoreRef.current
        const sid = sessionId
        if (!sid || !fn) return
        const hasMore = messageStore.getSessionState(sid)?.hasMoreHistory ?? false
        if (!hasMore) return
        isLoadingRef.current = true
        setIsLoadingMore(true)
        const requestId = ++loadMoreRequestIdRef.current
        const requestSessionId = sid
        try {
          await fn()
        } catch {
          // The page-version guard prevents retries until pages or scroll range change.
        } finally {
          if (isMountedRef.current && loadMoreRequestIdRef.current === requestId && sessionId === requestSessionId) {
            isLoadingRef.current = false
            setIsLoadingMore(false)
          }
        }
      }, [sessionId])

      useEffect(() => {
        if (!hasMoreHistory || loadState !== 'loaded' || isLoadingMore) return
        if (!hasLeftBottom) return
        if (!shouldPrefetchHistory(activePages.length, expandedPageRange.endIndex, PREFETCH_PAGE_RESERVE)) return

        const attemptKey = buildHistoryPrefetchAttemptKey(sessionId, activePages)
        if (prefetchAttemptKeyRef.current === attemptKey) return
        prefetchAttemptKeyRef.current = attemptKey
        void prefetchLoadMore()
      }, [
        activePages,
        expandedPageRange.endIndex,
        hasMoreHistory,
        isLoadingMore,
        loadState,
        prefetchLoadMore,
        hasLeftBottom,
        sessionId,
      ])

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
          if (current !== null && Math.abs(current - nextHeight) < PAGE_HEIGHT_MEASURE_MIN_DELTA_PX) {
            return previous
          }
          return { ...previous, [pageKey]: nextHeight }
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
          settlingScrollMessageIdRef.current = null
          clearPendingScrollTimer()
          setPendingScrollMessageId(messageId)
        },
        [activePages, clearPendingScrollTimer, measuredPageHeights],
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
            className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar contain-content flex flex-col-reverse"
            // Keep the visible history anchored while streaming content grows below it.
            style={{ overflowAnchor: 'auto' }}
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

            {activePages.map(page => (
              <PageBlock
                  key={page.key}
                  page={page}
                  expanded={expandedPageKeys.has(page.key)}
                  collapsedHeight={measuredPageHeights[page.key] ?? page.estimatedHeight}
                  registerPageSlot={registerPageSlot}
                  processCollapseEnabled={processCollapseEnabled}
                  messageMaxWidthClass={messageMaxWidthClass}
                  messagePaddingClass={messagePaddingClass}
                  registerMessage={registerMessage}
                  onUndo={onUndo}
                  onFork={onFork}
                  canUndo={canUndo}
                  turnDurationMap={localTurnDurationMap}
                  turnUserStartMap={localTurnUserStartMap}
                  turnLatestAssistantIds={localTurnLatestAssistantIds}
                  activeTurnAssistantId={activeTurnAssistantId}
                  forkTargetIdMap={localForkTargetIdMap}
                  allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                  onMeasuredHeightChange={updateMeasuredPageHeight}
                />
            ))}

            {visibleMessages.length > 0 && isLoadingMore && (
              <div className="flex justify-center py-3 shrink-0" style={{ overflowAnchor: 'none' }}>
                <div className="flex items-center gap-2 text-text-400 text-[length:var(--fs-sm)]">
                  <span className="w-3.5 h-3.5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                  {t('chatArea.loadingHistory')}
                </div>
              </div>
            )}

            <div className="mobile-chat-top-spacer shrink-0" style={{ overflowAnchor: 'none' }} />
            <div
              ref={topSentinelRef}
              className="h-px shrink-0"
              style={{ overflowAnchor: 'none' }}
              aria-hidden="true"
            />
          </div>
        </div>
      )
    },
  ),
)

interface PageBlockProps {
  page: ChatPage
  expanded: boolean
  collapsedHeight: number
  registerPageSlot: (pageKey: string, node: HTMLDivElement | null) => void
  processCollapseEnabled: boolean
  messageMaxWidthClass: string
  messagePaddingClass: string
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  turnDurationMap: Map<string, number>
  turnUserStartMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  activeTurnAssistantId: string | null
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
  if (previous.expanded !== next.expanded) return false
  if (previous.registerPageSlot !== next.registerPageSlot) return false
  if (!next.expanded) return previous.collapsedHeight === next.collapsedHeight
  if (previous.processCollapseEnabled !== next.processCollapseEnabled) return false
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
  if (
    previous.activeTurnAssistantId !== next.activeTurnAssistantId &&
    ((previous.activeTurnAssistantId != null && previous.page.messageIds.includes(previous.activeTurnAssistantId)) ||
      (next.activeTurnAssistantId != null && next.page.messageIds.includes(next.activeTurnAssistantId)))
  ) {
    return false
  }
  return pageMessageDerivedValuesEqual(previous, next)
}

/** 展开/流式时高度连续变，过密测量会拖着 ChatArea setState 发颤 */
const PAGE_HEIGHT_MEASURE_MIN_DELTA_PX = 4

function usePageHeightMeasurement(
  pageKey: string,
  onMeasuredHeightChange: (pageKey: string, nextHeight: number) => void,
  enabled: boolean,
  registerPageSlot: (pageKey: string, node: HTMLDivElement | null) => void,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const lastReportedHeightRef = useRef(0)
  const measureRafRef = useRef<number | null>(null)

  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node
      registerPageSlot(pageKey, node)
    },
    [pageKey, registerPageSlot],
  )

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
    if (!enabled) return
    // 布局变化后立刻量一次（不节流阈值，保证虚拟化高度不过期）
    const element = wrapperRef.current
    if (!element) return
    const nextHeight = element.offsetHeight
    if (nextHeight <= 0) return
    lastReportedHeightRef.current = nextHeight
    onMeasuredHeightChange(pageKey, nextHeight)
  }, [enabled, onMeasuredHeightChange, pageKey])

  useEffect(() => {
    const element = wrapperRef.current
    if (!enabled || !element || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current)
        measureRafRef.current = null
      }
    }
  }, [enabled, scheduleMeasure])

  return setWrapperRef
}

const PageBlock = memo(function PageBlock({
  page,
  expanded,
  collapsedHeight,
  registerPageSlot,
  processCollapseEnabled,
  messageMaxWidthClass,
  messagePaddingClass,
  registerMessage,
  onUndo,
  onFork,
  canUndo,
  turnDurationMap,
  turnUserStartMap,
  turnLatestAssistantIds,
  activeTurnAssistantId,
  forkTargetIdMap,
  allowStreamingLayoutAnimation,
  onMeasuredHeightChange,
}: PageBlockProps) {
  const wrapperRef = usePageHeightMeasurement(
    page.key,
    onMeasuredHeightChange,
    expanded,
    registerPageSlot,
  )
  if (!expanded) {
    return (
      <div
        ref={wrapperRef}
        className="shrink-0"
        data-page-key={page.key}
        style={{ height: `${collapsedHeight}px`, overflowAnchor: 'none' }}
        aria-hidden="true"
      />
    )
  }

  const renderMessage = (message: Message, immersiveContentScope?: 'all' | 'process' | 'final' | 'inline') => (
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
          immersiveContentScope === 'final'
            ? true
            : message.info.role === 'assistant'
              ? turnLatestAssistantIds.has(message.info.id)
              : undefined
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
    rowKey: string,
    isUser: boolean,
    content: ReactNode,
    options?: { continuesFromPrevious?: boolean; continuesToNext?: boolean },
  ) => {
    const continuesFromPrevious = options?.continuesFromPrevious ?? false
    const continuesToNext = options?.continuesToNext ?? false
    const verticalPaddingClass = continuesFromPrevious
      ? continuesToNext
        ? 'pt-2 pb-0'
        : 'pt-2 pb-3'
      : continuesToNext
        ? 'pt-3 pb-0'
        : 'py-3'
    return (
      <div
        key={rowKey}
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

  // 过程折叠：按 row 建折叠块（row 已合并连续 assistant）。
  // 只用 page.rows，不跨页 — 每页独立处理，不会出现空页白屏。
  if (processCollapseEnabled) {
    return (
      <div ref={wrapperRef} className="shrink-0" data-page-key={page.key}>
        {page.rows.map(row => {
          const isUserRow = row.messages[0].info.role === 'user'
          if (isUserRow) {
            return renderRowShell(
              row.key,
              true,
              row.messages.map(message => renderMessage(message)),
              { continuesFromPrevious: row.continuesFromPrevious, continuesToNext: row.continuesToNext },
            )
          }

          // assistant row：所有 assistant 合并到一个过程折叠块
          const assistants = row.messages
          const finalAssistant = assistants[assistants.length - 1]
          const finalAssistantId = finalAssistant.info.id

          // 活跃判断：只看本 row 内消息实际状态（不依赖 sessionIsStreaming，避免旧回合闪 working）
          // 必须先查 isStreaming：buildVisibleMessageEntries 合并连续 assistant 后，
          // info.time.completed 是第一条的，但 isStreaming 是 anyStreaming。
          // 若只查 completed==null，合并消息 completed!=null 会被误判为已结束。
          const rowIsActive =
            finalAssistantId === activeTurnAssistantId ||
            assistants.some(m => {
              if (m.isStreaming) return true
              if (m.info.time.completed == null) return true
              return m.parts.some(
                p => p.type === 'tool' && (p.state.status === 'running' || p.state.status === 'pending'),
              )
            })

          const finalHasAnswer = messageHasImmersiveFinal(finalAssistant)

          // 计时起点：优先 turnUserStartMap，否则取 row 首条 assistant 的 created
          const userStart = turnUserStartMap.get(finalAssistantId) ?? assistants[0]?.info.time.created

          // 结束后的校正时长
          let settledDurationMs: number | undefined
          if (!rowIsActive && userStart != null) {
            for (const m of [...assistants].reverse()) {
              const mapped = turnDurationMap.get(m.info.id)
              if (mapped != null && mapped > 0) {
                settledDurationMs = mapped
                break
              }
            }
            if (settledDurationMs == null) {
              let latestEnd: number | undefined
              for (const m of assistants) {
                const completed = m.info.time.completed
                if (completed != null && (latestEnd == null || completed > latestEnd)) latestEnd = completed
                for (const p of m.parts) {
                  if (p.type !== 'tool') continue
                  const toolEnd = p.state.time?.end
                  if (toolEnd != null && (latestEnd == null || toolEnd > latestEnd)) latestEnd = toolEnd
                }
              }
              if (latestEnd != null && latestEnd > userStart) settledDurationMs = latestEnd - userStart
            }
          }

          const processStateKey = (() => {
            // Session + userStart identify one turn without leaking disclosure state across chats.
            const sessionKey = finalAssistant.info.sessionID
            if (userStart != null) return `turn-process:${sessionKey}:userstart:${userStart}`
            return `turn-process:${sessionKey}:row:${row.key}`
          })()
          // 流式活跃时全部进壳；结束后末条 assistant 拆出 final 正文
          const showFinalOutside = !rowIsActive && finalHasAnswer

          return renderRowShell(
            row.key,
            false,
            <>
              <ImmersiveProcessBlock
                stateKey={processStateKey}
                startedAt={userStart}
                durationMs={settledDurationMs}
                isActive={rowIsActive}
              >
                {assistants.map(message =>
                  renderMessage(message, message.info.id === finalAssistantId && !rowIsActive ? 'process' : 'inline'),
                )}
              </ImmersiveProcessBlock>
              {showFinalOutside && renderMessage(finalAssistant, 'final')}
            </>,
            { continuesFromPrevious: row.continuesFromPrevious, continuesToNext: row.continuesToNext },
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
          row.key,
          isUser,
          row.messages.map(message => renderMessage(message)),
          {
            continuesFromPrevious: row.continuesFromPrevious,
            continuesToNext: row.continuesToNext,
          },
        )
      })}
    </div>
  )
}, arePageBlockPropsEqual)

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
