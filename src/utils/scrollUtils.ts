/**
 * 把列表项滚动到容器可视区域内，确保完全可见。
 *
 * 比 `element.scrollIntoView({ block: 'nearest' })` 更可靠：
 * 后者在有 padding 的容器上、部分可见时只滚最小距离，
 * 会导致选中项"卡在半边"。这里直接基于 getBoundingClientRect 计算，
 * 确保选中项完全在容器的 padding box（可视内容区）内。
 */
export function scrollItemIntoView(container: HTMLElement, item: HTMLElement): void {
  const cStyle = getComputedStyle(container)
  const paddingTop = parseFloat(cStyle.paddingTop) || 0
  const paddingBottom = parseFloat(cStyle.paddingBottom) || 0

  const cRect = container.getBoundingClientRect()
  // 可视内容区 = border box 内缩 padding
  const contentTop = cRect.top + paddingTop
  const contentBottom = cRect.bottom - paddingBottom

  const iRect = item.getBoundingClientRect()

  const offsetTop = iRect.top - contentTop
  const offsetBottom = iRect.bottom - contentBottom

  if (offsetTop < 0) {
    container.scrollTop += offsetTop
  } else if (offsetBottom > 0) {
    container.scrollTop += offsetBottom
  }
}

/** grid-rows 展开动画 300ms + useDelayedRender 默认 320ms，留一点余量 */
export const DISCLOSURE_SCROLL_LOCK_MS = 400

let activeScrollAnchorLocks = 0

/** 是否有展开/收起滚动锁在跑（ChatArea 页高锚点应让路） */
export function isScrollAnchorLocked(): boolean {
  return activeScrollAnchorLocks > 0
}

/** 仅测试用：清掉残留锁计数 */
export function resetScrollAnchorLocksForTests(): void {
  activeScrollAnchorLocks = 0
}

export function findChatScrollRoot(from: Element | null): HTMLElement | null {
  if (!from) return null
  return from.closest('[data-chat-scroll-root="true"]') as HTMLElement | null
}

/**
 * 展开/收起时把锚点（通常是 steps header）钉在视口原位置。
 *
 * 内容仍按正常文档流向下生长（grid-rows 等），不改 position。
 * 聊天流是 flex-col-reverse，高度变化会默认钉底部，这里只补偿 scrollTop。
 * 用 ResizeObserver 跟着高度变化同步修正；用户手滚则立刻松手。
 */
export function lockScrollAroundAnchor(
  anchor: HTMLElement | null,
  options?: { durationMs?: number; observe?: Element | null },
): () => void {
  if (!anchor) return () => undefined

  const maybeRoot = findChatScrollRoot(anchor)
  if (!maybeRoot) return () => undefined
  // 收窄到确定非 null，避免嵌套闭包里 TS 丢 narrowing
  const root: HTMLElement = maybeRoot

  const measureRootTop = () => root.getBoundingClientRect().top
  const targetTop = anchor.getBoundingClientRect().top - measureRootTop()
  const observeTarget = options?.observe ?? anchor.parentElement ?? anchor
  const durationMs = options?.durationMs ?? DISCLOSURE_SCROLL_LOCK_MS

  let stopped = false
  let applyingRestore = false
  let raf1 = 0
  let raf2 = 0
  let clearApplyingRaf = 0
  let endTimer = 0
  let ro: ResizeObserver | null = null

  activeScrollAnchorLocks += 1

  const restore = () => {
    if (stopped) return
    const nextTop = anchor.getBoundingClientRect().top - measureRootTop()
    const delta = nextTop - targetTop
    if (Math.abs(delta) < 0.5) return
    applyingRestore = true
    root.scrollTop += delta
    if (clearApplyingRaf) cancelAnimationFrame(clearApplyingRaf)
    clearApplyingRaf = requestAnimationFrame(() => {
      clearApplyingRaf = 0
      applyingRestore = false
    })
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    activeScrollAnchorLocks = Math.max(0, activeScrollAnchorLocks - 1)
    ro?.disconnect()
    ro = null
    if (raf1) cancelAnimationFrame(raf1)
    if (raf2) cancelAnimationFrame(raf2)
    if (clearApplyingRaf) cancelAnimationFrame(clearApplyingRaf)
    if (endTimer) window.clearTimeout(endTimer)
    root.removeEventListener('wheel', onUserScrollIntent)
    root.removeEventListener('touchmove', onUserScrollIntent)
  }

  const onUserScrollIntent = () => {
    if (stopped || applyingRestore) return
    stop()
  }

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      restore()
    })
    ro.observe(observeTarget)
  }

  // 首帧布局（React commit 后）立刻补一次，避免动画开始前闪一下
  raf1 = requestAnimationFrame(() => {
    raf1 = 0
    restore()
    raf2 = requestAnimationFrame(() => {
      raf2 = 0
      restore()
    })
  })

  endTimer = window.setTimeout(() => {
    endTimer = 0
    stop()
  }, durationMs)

  root.addEventListener('wheel', onUserScrollIntent, { passive: true })
  root.addEventListener('touchmove', onUserScrollIntent, { passive: true })

  return stop
}
