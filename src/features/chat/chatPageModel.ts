import type { Message } from '../../types/message'

export const PAGE_MESSAGE_COUNT = 20
export const PAGE_EXTREME_RENDER_WEIGHT = 700
export const PAGE_OVERSCAN_VIEWPORTS = 2
export const PAGE_ADJACENT_OVERSCAN = 1
/** 过程折叠时按 row 数（折叠块数）分页，一个折叠块算一条 */
export const PAGE_ROW_COUNT_FOR_COLLAPSE = 25
/** 过程折叠时 collapsed 占位按收起状态估算高度，让滑动窗口展开发生在视口外 */
export const COLLAPSE_HEADER_HEIGHT_PX = 32

export interface MessageGroupRow {
  key: string
  messages: Message[]
  messageIds: string[]
  estimatedHeight: number
  renderWeight?: number
  continuesFromPrevious?: boolean
  continuesToNext?: boolean
}

export interface ChatPage {
  key: string
  rows: MessageGroupRow[]
  messageIds: string[]
  estimatedHeight: number
  renderWeight?: number
}

export interface StableChatPage extends ChatPage {
  key: string
}

export interface PageRange {
  startIndex: number
  endIndex: number
}

export type PageRenderSegment =
  | {
      kind: 'expanded'
      key: string
      page: StableChatPage
      measuredHeight: number
    }
  | {
      kind: 'collapsed'
      key: string
      height: number
    }

export type ExpandedPageSelection = Set<number>

const messageRenderWeightCache = new WeakMap<Message, number>()

export function computeAnchorRestoreScrollDelta(previousTopOffset: number, nextTopOffset: number): number {
  return nextTopOffset - previousTopOffset
}

const TEXT_RENDER_FEATURE_PATTERN = /\n|^[ \t]*```([^\r\n]*)|!\[[^\]]*\]\([^)]*\)/gm

function estimateTextRenderWeight(text: string): number {
  if (!text) return 0
  if (!text.trim()) return 0

  let lineCount = 1
  let fenceCount = 0
  let mermaidBlocks = 0
  let images = 0
  TEXT_RENDER_FEATURE_PATTERN.lastIndex = 0
  for (let match = TEXT_RENDER_FEATURE_PATTERN.exec(text); match; match = TEXT_RENDER_FEATURE_PATTERN.exec(text)) {
    if (match[0] === '\n') {
      lineCount += 1
    } else if (match[0].startsWith('!')) {
      images += 1
    } else {
      fenceCount += 1
      if (match[1]?.trim().toLowerCase() === 'mermaid') mermaidBlocks += 1
    }
  }
  const fencedBlocks = Math.ceil(fenceCount / 2)

  return Math.max(
    1,
    1 + Math.floor(text.length / 1400) + Math.floor(lineCount / 40) + fencedBlocks * 2 + mermaidBlocks * 4 + images * 2,
  )
}

export function estimateMessageRenderWeight(message: Message): number {
  const cached = messageRenderWeightCache.get(message)
  if (cached != null) return cached

  let weight = message.info.role === 'user' ? 1 : 2

  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
        weight += part.synthetic ? 1 : estimateTextRenderWeight(part.text)
        break
      case 'reasoning':
        weight += 1 + estimateTextRenderWeight(part.text)
        break
      case 'tool': {
        const outputLength = part.state.output?.length ?? part.state.error?.length ?? 0
        weight += 4 + Math.min(8, Math.floor(outputLength / 4000))
        break
      }
      case 'file':
        weight += 2
        break
      case 'subtask':
        weight += 3
        break
      case 'step-finish':
      case 'retry':
        weight += 2
        break
      case 'agent':
      case 'compaction':
        weight += 1
        break
      default:
        break
    }
  }

  const result = Math.max(1, weight)
  messageRenderWeightCache.set(message, result)
  return result
}

function estimateMessageHeight(message: Message, collapsed: boolean = false): number {
  if (message.info.role === 'user') {
    return Math.max(72, message.parts.length * 40)
  }
  if (collapsed) {
    // 过程折叠收起后：header + final text（只算非 synthetic 的 text part）
    let height = COLLAPSE_HEADER_HEIGHT_PX
    for (const part of message.parts) {
      if (part.type === 'text' && !(part as { synthetic?: boolean }).synthetic) {
        const text = (part as { text: string }).text
        height += Math.max(40, Math.ceil(text.length / 100) * 20)
      }
    }
    return height
  }
  return Math.max(160, message.parts.length * 80)
}

function estimateGroupHeight(messages: Message[], collapsed: boolean = false): number {
  let total = 24
  for (let index = 0; index < messages.length; index++) {
    if (index > 0) total += 8
    total += estimateMessageHeight(messages[index], collapsed)
  }
  return total
}

function estimateRowHeight(
  messages: Message[],
  options?: { continuesFromPrevious?: boolean; continuesToNext?: boolean; collapsed?: boolean },
) {
  const paddingReduction = (options?.continuesFromPrevious ? 4 : 0) + (options?.continuesToNext ? 12 : 0)
  return estimateGroupHeight(messages, options?.collapsed) - paddingReduction
}

function estimateGroupRenderWeight(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageRenderWeight(message), 0)
}

function buildMessageGroupRow(
  group: Message[],
  options?: { continuesFromPrevious?: boolean; continuesToNext?: boolean; collapsed?: boolean },
): MessageGroupRow {
  const firstId = group[0]?.info.id ?? 'empty'
  return {
    key: `row:${firstId}`,
    messages: group,
    messageIds: group.map(message => message.info.id),
    estimatedHeight: estimateRowHeight(group, options),
    renderWeight: estimateGroupRenderWeight(group),
    continuesFromPrevious: options?.continuesFromPrevious,
    continuesToNext: options?.continuesToNext,
  }
}

function buildMessageGroups(messages: Message[], collapsed: boolean = false): MessageGroupRow[] {
  const groups: Message[][] = []
  for (const message of messages) {
    const previous = groups[groups.length - 1]
    if (previous && message.info.role === 'assistant' && previous[0].info.role === 'assistant') {
      previous.push(message)
    } else {
      groups.push([message])
    }
  }

  return groups.map(group => buildMessageGroupRow(group, { collapsed }))
}

function splitOversizedMessageGroups(
  rows: MessageGroupRow[],
  pageMessageCount: number,
  maxRenderWeight: number,
): MessageGroupRow[] {
  return rows.flatMap(row => {
    if (row.messages.length <= pageMessageCount && (row.renderWeight ?? 0) <= maxRenderWeight) return row

    const chunks: Message[][] = []
    let currentChunk: Message[] = []
    let currentWeight = 0
    for (const message of row.messages) {
      const messageWeight = estimateMessageRenderWeight(message)
      if (
        currentChunk.length > 0 &&
        (currentChunk.length >= pageMessageCount || currentWeight + messageWeight > maxRenderWeight)
      ) {
        chunks.push(currentChunk)
        currentChunk = []
        currentWeight = 0
      }
      currentChunk.push(message)
      currentWeight += messageWeight
    }
    if (currentChunk.length > 0) chunks.push(currentChunk)

    return chunks.map((chunk, index) =>
      buildMessageGroupRow(chunk, {
        continuesFromPrevious: index > 0,
        continuesToNext: index < chunks.length - 1,
      }),
    )
  })
}

export function buildChatPages(
  messages: Message[],
  pageMessageCount = PAGE_MESSAGE_COUNT,
  maxRenderWeight = PAGE_EXTREME_RENDER_WEIGHT,
  rowCountLimit = pageMessageCount,
  collapsed: boolean = false,
): ChatPage[] {
  const rows = splitOversizedMessageGroups(buildMessageGroups(messages, collapsed), pageMessageCount, maxRenderWeight)
  const renderPages: ChatPage[] = []

  let currentRows: MessageGroupRow[] = []
  let currentMessageCount = 0
  let currentRenderWeight = 0
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
    const row = rows[rowIndex]
    const rowRenderWeight = row.renderWeight ?? estimateGroupRenderWeight(row.messages)
    // 切页条件：当前页非空 + 超限。但 continuesFromPrevious 的 row 不能开始新页——
    // 它是上一 row 的续接（同一回合被 splitOversizedMessageGroups 切开），
    // 分到不同 page 会导致过程折叠块跨页。
    // rowCountLimit 默认等于 pageMessageCount；过程折叠时可传 PAGE_ROW_COUNT_FOR_COLLAPSE
    // 让分页按折叠块数（row 数）而非物理消息数计算。
    const wouldExceedLimit =
      currentRows.length + 1 > rowCountLimit ||
      currentMessageCount + row.messages.length > pageMessageCount ||
      currentRenderWeight + rowRenderWeight > maxRenderWeight
    if (currentRows.length > 0 && wouldExceedLimit && !row.continuesFromPrevious) {
      renderPages.push(buildChatPage(currentRows))
      currentRows = []
      currentMessageCount = 0
      currentRenderWeight = 0
    }
    currentRows.unshift(row)
    currentMessageCount += row.messages.length
    currentRenderWeight += rowRenderWeight
  }

  if (currentRows.length > 0) {
    renderPages.push(buildChatPage(currentRows))
  }

  return renderPages
}

function buildChatPage(rows: MessageGroupRow[]): ChatPage {
  const messageIds = rows.flatMap(row => row.messageIds)
  const newestId = messageIds[messageIds.length - 1] ?? 'empty'
  const oldestId = messageIds[0] ?? newestId
  return {
    key: `${newestId}:${oldestId}:${messageIds.length}`,
    rows,
    messageIds,
    estimatedHeight: rows.reduce((sum, row) => sum + row.estimatedHeight, 0),
    renderWeight: rows.reduce((sum, row) => sum + (row.renderWeight ?? estimateGroupRenderWeight(row.messages)), 0),
  }
}

function connectAssistantPageBoundary(
  olderPage: StableChatPage,
  newerPage: StableChatPage,
): { olderPage: StableChatPage; newerPage: StableChatPage } | null {
  const olderBoundaryRow = olderPage.rows.at(-1)
  const newerBoundaryRow = newerPage.rows[0]
  if (
    olderBoundaryRow?.messages[0]?.info.role !== 'assistant' ||
    newerBoundaryRow?.messages[0]?.info.role !== 'assistant'
  ) {
    return null
  }

  const olderRows = olderPage.rows.slice()
  olderRows[olderRows.length - 1] = buildMessageGroupRow(olderBoundaryRow.messages, {
    continuesFromPrevious: olderBoundaryRow.continuesFromPrevious,
    continuesToNext: true,
  })
  const newerRows = newerPage.rows.slice()
  newerRows[0] = buildMessageGroupRow(newerBoundaryRow.messages, {
    continuesFromPrevious: true,
    continuesToNext: newerBoundaryRow.continuesToNext,
  })

  return {
    olderPage: { ...buildChatPage(olderRows), key: olderPage.key },
    newerPage: { ...buildChatPage(newerRows), key: newerPage.key },
  }
}

export function buildStableChatPages(
  messages: Message[],
  allocateKey: (page: ChatPage) => string,
  pageMessageCount = PAGE_MESSAGE_COUNT,
  maxRenderWeight = PAGE_EXTREME_RENDER_WEIGHT,
  rowCountLimit = pageMessageCount,
  collapsed: boolean = false,
): StableChatPage[] {
  return buildChatPages(messages, pageMessageCount, maxRenderWeight, rowCountLimit, collapsed).map(page => ({ ...page, key: allocateKey(page) }))
}

export function buildContentKeyedChatPages(
  messages: Message[],
  pageMessageCount = PAGE_MESSAGE_COUNT,
  maxRenderWeight = PAGE_EXTREME_RENDER_WEIGHT,
  rowCountLimit = pageMessageCount,
  collapsed: boolean = false,
): StableChatPage[] {
  return buildChatPages(messages, pageMessageCount, maxRenderWeight, rowCountLimit, collapsed)
}

function flattenPageMessagesChronological(page: ChatPage): Message[] {
  return page.rows.flatMap(row => row.messages)
}

function flattenPagesMessageIdsChronological(pages: ChatPage[]): string[] {
  return pages
    .slice()
    .reverse()
    .flatMap(page => page.messageIds)
}

export function findMessageSequenceOffset(nextIds: string[], previousIds: string[]): number {
  if (previousIds.length === 0) return 0
  if (previousIds.length > nextIds.length) return -1

  const firstId = previousIds[0]
  for (let startIndex = 0; startIndex <= nextIds.length - previousIds.length; startIndex++) {
    if (nextIds[startIndex] !== firstId) continue

    let matches = true
    for (let index = 1; index < previousIds.length; index++) {
      if (nextIds[startIndex + index] !== previousIds[index]) {
        matches = false
        break
      }
    }
    if (matches) return startIndex
  }

  return -1
}

function rebuildPageWithFreshMessages(page: StableChatPage, nextById: Map<string, Message>): StableChatPage {
  let pageChanged = false
  const rows = page.rows.map(row => {
    const messages = row.messages.map(message => nextById.get(message.info.id) ?? message)
    if (messages.every((message, index) => message === row.messages[index])) return row
    pageChanged = true
    return {
      key: row.key,
      messages,
      messageIds: messages.map(message => message.info.id),
      estimatedHeight: estimateRowHeight(messages, row),
      renderWeight: estimateGroupRenderWeight(messages),
      continuesFromPrevious: row.continuesFromPrevious,
      continuesToNext: row.continuesToNext,
    }
  })

  if (!pageChanged) return page

  return {
    key: page.key,
    rows,
    messageIds: rows.flatMap(row => row.messageIds),
    estimatedHeight: rows.reduce((sum, row) => sum + row.estimatedHeight, 0),
    renderWeight: rows.reduce((sum, row) => sum + (row.renderWeight ?? estimateGroupRenderWeight(row.messages)), 0),
  }
}

export function reconcileStableChatPages(options: {
  currentPages: ChatPage[]
  nextMessages: Message[]
  allocateKey: (page: ChatPage) => string
  pageMessageCount?: number
  maxRenderWeight?: number
  rowCountLimit?: number
  collapsed?: boolean
}): StableChatPage[] {
  const { currentPages, nextMessages, allocateKey } = options
  const pageMessageCount = options.pageMessageCount ?? PAGE_MESSAGE_COUNT
  const maxRenderWeight = options.maxRenderWeight ?? PAGE_EXTREME_RENDER_WEIGHT
  const rowCountLimit = options.rowCountLimit ?? pageMessageCount
  const collapsed = options.collapsed ?? false
  if (nextMessages.length === 0) return []
  if (currentPages.length === 0) {
    return buildStableChatPages(nextMessages, allocateKey, pageMessageCount, maxRenderWeight, rowCountLimit, collapsed)
  }

  const previousIds = flattenPagesMessageIdsChronological(currentPages)
  const nextIds = nextMessages.map(message => message.info.id)
  const offset = findMessageSequenceOffset(nextIds, previousIds)
  if (offset === -1) {
    return buildStableChatPages(nextMessages, allocateKey, pageMessageCount, maxRenderWeight, rowCountLimit, collapsed)
  }

  const nextById = new Map(nextMessages.map(message => [message.info.id, message]))
  const refreshedPages = currentPages.map(page => rebuildPageWithFreshMessages(page as StableChatPage, nextById))
  const prefixMessages = nextMessages.slice(0, offset)
  const suffixMessages = nextMessages.slice(offset + previousIds.length)

  let nextPages = refreshedPages
  if (suffixMessages.length > 0) {
    const newestPage = refreshedPages[0]
    const newestMessages = newestPage ? flattenPageMessagesChronological(newestPage) : []
    const suffixWeight = suffixMessages.reduce((sum, message) => sum + estimateMessageRenderWeight(message), 0)
    const newestWeight = newestPage?.renderWeight ?? 0

    if (
      newestPage &&
      newestPage.messageIds.length + suffixMessages.length <= pageMessageCount &&
      newestWeight + suffixWeight <= maxRenderWeight
    ) {
      const combinedRows = buildMessageGroups([...newestMessages, ...suffixMessages])
      const previousFirstRow = newestPage.rows[0]
      if (
        previousFirstRow?.continuesFromPrevious &&
        combinedRows[0]?.messageIds[0] === previousFirstRow.messageIds[0]
      ) {
        combinedRows[0] = buildMessageGroupRow(combinedRows[0].messages, { continuesFromPrevious: true })
      }
      const combinedPage = buildChatPage(combinedRows)
      nextPages = [{ ...combinedPage, key: newestPage.key }, ...refreshedPages.slice(1)]
    } else {
      let appendedPages = buildStableChatPages(suffixMessages, allocateKey, pageMessageCount, maxRenderWeight, rowCountLimit, collapsed)
      let continuedNewestPage = newestPage
      const boundaryPage = appendedPages.at(-1)
      const connection = newestPage && boundaryPage ? connectAssistantPageBoundary(newestPage, boundaryPage) : null
      if (connection) {
        continuedNewestPage = connection.olderPage
        appendedPages = appendedPages.slice()
        appendedPages[appendedPages.length - 1] = connection.newerPage
      }
      nextPages = [...appendedPages, ...(continuedNewestPage ? [continuedNewestPage] : []), ...refreshedPages.slice(1)]
    }
  }

  if (prefixMessages.length > 0) {
    let prependedOlderPages = buildStableChatPages(prefixMessages, allocateKey, pageMessageCount, maxRenderWeight)
    const currentOldestPage = nextPages.at(-1)
    const prefixBoundaryPage = prependedOlderPages[0]
    const connection =
      prefixBoundaryPage && currentOldestPage
        ? connectAssistantPageBoundary(prefixBoundaryPage, currentOldestPage)
        : null
    if (connection) {
      nextPages = [...nextPages.slice(0, -1), connection.newerPage]
      prependedOlderPages = [connection.olderPage, ...prependedOlderPages.slice(1)]
    }
    nextPages = [...nextPages, ...prependedOlderPages]
  }

  return nextPages
}

export function buildPageOffsets(pages: ChatPage[], measuredPageHeights: Record<string, number>): number[] {
  const offsets = new Array<number>(pages.length + 1)
  offsets[0] = 0
  for (let index = 0; index < pages.length; index++) {
    offsets[index + 1] = offsets[index] + (measuredPageHeights[pages[index].key] ?? pages[index].estimatedHeight)
  }
  return offsets
}

export function seedMeasuredPageHeightsFromPreviousPages(options: {
  pages: ChatPage[]
  previousPages: ChatPage[]
  measuredPageHeights: Record<string, number>
}): Record<string, number> {
  const { pages, previousPages, measuredPageHeights } = options
  if (pages.length === 0 || previousPages.length === 0) return measuredPageHeights

  let nextHeights = measuredPageHeights
  for (const page of pages) {
    if (nextHeights[page.key] != null) continue

    const seedHeight = findMeasuredPageHeightSeed(page, previousPages, measuredPageHeights)
    if (seedHeight == null) continue

    if (nextHeights === measuredPageHeights) nextHeights = { ...measuredPageHeights }
    nextHeights[page.key] = seedHeight
  }

  return nextHeights
}

function findMeasuredPageHeightSeed(
  page: ChatPage,
  previousPages: ChatPage[],
  measuredPageHeights: Record<string, number>,
): number | null {
  let best: { messageCount: number; height: number } | null = null

  for (const previousPage of previousPages) {
    const measuredHeight = measuredPageHeights[previousPage.key]
    if (measuredHeight == null || measuredHeight <= 0) continue
    if (previousPage.messageIds.length === 0 || previousPage.messageIds.length > page.messageIds.length) continue
    if (findMessageSequenceOffset(page.messageIds, previousPage.messageIds) === -1) continue

    const estimatedAddedHeight = Math.max(0, page.estimatedHeight - previousPage.estimatedHeight)
    const height = Math.max(1, Math.ceil(measuredHeight + estimatedAddedHeight))
    if (!best || previousPage.messageIds.length > best.messageCount) {
      best = { messageCount: previousPage.messageIds.length, height }
    }
  }

  return best?.height ?? null
}

function findPageIndexAtOffset(offsets: number[], offset: number): number {
  let low = 0
  let high = offsets.length - 2
  let result = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (offsets[mid] <= offset && offsets[mid + 1] > offset) return mid
    if (offsets[mid] > offset) {
      high = mid - 1
    } else {
      result = mid
      low = mid + 1
    }
  }

  return Math.max(0, Math.min(result, offsets.length - 2))
}

export function computeExpandedPageRange(options: {
  pages: ChatPage[]
  measuredPageHeights: Record<string, number>
  scrollOffsetFromBottom: number
  viewportHeight: number
  overscanPx?: number
  adjacentPageCount?: number
  adjacentPageMaxSourceHeight?: number
}): PageRange {
  const { pages, measuredPageHeights, scrollOffsetFromBottom, viewportHeight } = options
  if (pages.length === 0) return { startIndex: 0, endIndex: -1 }

  const offsets = buildPageOffsets(pages, measuredPageHeights)
  const viewportSpan = Math.max(1, viewportHeight)
  const overscanPx = Math.max(0, options.overscanPx ?? viewportSpan * PAGE_OVERSCAN_VIEWPORTS)
  const viewportStart = Math.max(0, scrollOffsetFromBottom - overscanPx)
  const viewportEnd = scrollOffsetFromBottom + viewportSpan + overscanPx
  const firstVisiblePageIndex = findPageIndexAtOffset(offsets, viewportStart)
  const lastVisiblePageIndex = findPageIndexAtOffset(offsets, Math.max(viewportStart, viewportEnd - 1))
  const adjacentPageCount = Math.max(0, Math.floor(options.adjacentPageCount ?? 0))
  const maxSourceHeight = options.adjacentPageMaxSourceHeight
  const canExpandFrom = (pageIndex: number) => {
    if (maxSourceHeight == null) return true
    // 未测量页面用 estimatedHeight 判断，允许预展开
    const page = pages[pageIndex]
    const height = measuredPageHeights[page.key] ?? page.estimatedHeight
    return height <= maxSourceHeight
  }

  return {
    startIndex: canExpandFrom(firstVisiblePageIndex)
      ? Math.max(0, firstVisiblePageIndex - adjacentPageCount)
      : firstVisiblePageIndex,
    endIndex: canExpandFrom(lastVisiblePageIndex)
      ? Math.min(pages.length - 1, lastVisiblePageIndex + adjacentPageCount)
      : lastVisiblePageIndex,
  }
}

export function buildExpandedPageSelection(
  range: PageRange,
  forcedPageIndex?: number | readonly number[] | null,
): ExpandedPageSelection {
  const selection = new Set<number>()
  if (range.endIndex >= range.startIndex) {
    for (let index = range.startIndex; index <= range.endIndex; index++) selection.add(index)
  }
  if (typeof forcedPageIndex === 'number') {
    if (forcedPageIndex >= 0) selection.add(forcedPageIndex)
  } else if (forcedPageIndex) {
    for (const index of forcedPageIndex) {
      if (index >= 0) selection.add(index)
    }
  }
  return selection
}

export function expandSelectionWithPageKeys(options: {
  pages: ChatPage[]
  expandedPageSelection: ExpandedPageSelection
  pageKeys: ReadonlySet<string>
}): ExpandedPageSelection {
  const { pages, expandedPageSelection, pageKeys } = options
  if (pages.length === 0 || pageKeys.size === 0) return expandedPageSelection

  let nextSelection = expandedPageSelection
  for (let index = 0; index < pages.length; index += 1) {
    if (!pageKeys.has(pages[index].key) || nextSelection.has(index)) continue
    if (nextSelection === expandedPageSelection) nextSelection = new Set(expandedPageSelection)
    nextSelection.add(index)
  }

  return nextSelection
}

export function buildPageRenderSegments(options: {
  pages: StableChatPage[]
  expandedPageSelection: ExpandedPageSelection
  measuredPageHeights: Record<string, number>
}): PageRenderSegment[] {
  const { pages, expandedPageSelection, measuredPageHeights } = options
  if (pages.length === 0) return []

  const segments: PageRenderSegment[] = []
  const appendCollapsedSegment = (startPageIndex: number, endPageIndex: number) => {
    if (startPageIndex > endPageIndex) return

    let height = 0
    for (let index = startPageIndex; index <= endPageIndex; index++) {
      height += measuredPageHeights[pages[index].key] ?? pages[index].estimatedHeight
    }

    segments.push({
      kind: 'collapsed',
      key: `collapsed:${pages[startPageIndex].key}:${pages[endPageIndex].key}`,
      height,
    })
  }

  let collapsedStartIndex: number | null = null
  for (let index = 0; index < pages.length; index++) {
    if (!expandedPageSelection.has(index)) {
      if (collapsedStartIndex === null) collapsedStartIndex = index
      continue
    }

    if (collapsedStartIndex !== null) {
      appendCollapsedSegment(collapsedStartIndex, index - 1)
      collapsedStartIndex = null
    }

    const page = pages[index]
    segments.push({
      kind: 'expanded',
      key: page.key,
      page,
      measuredHeight: measuredPageHeights[page.key] ?? page.estimatedHeight,
    })
  }

  if (collapsedStartIndex !== null) appendCollapsedSegment(collapsedStartIndex, pages.length - 1)
  return segments
}

export function buildTurnDurationMap(messages: Message[], visibleMessages: Message[]): Map<string, number> {
  const map = new Map<string, number>()
  const visibleAssistantIds = new Set(
    visibleMessages.filter(message => message.info.role === 'assistant').map(message => message.info.id),
  )

  let currentUserCreated: number | null = null
  let currentVisibleAssistantId: string | null = null
  let currentLastCompleted: number | null = null

  const commitTurn = () => {
    if (currentUserCreated == null || currentVisibleAssistantId == null || currentLastCompleted == null) return
    map.set(currentVisibleAssistantId, currentLastCompleted - currentUserCreated)
  }

  for (const message of messages) {
    if (message.info.role === 'user') {
      commitTurn()
      currentUserCreated = message.info.time.created
      currentVisibleAssistantId = null
      currentLastCompleted = null
      continue
    }

    if (currentUserCreated == null || message.info.role !== 'assistant') continue

    if (visibleAssistantIds.has(message.info.id)) {
      currentVisibleAssistantId = message.info.id
    }
    if (message.info.time.completed != null) {
      currentLastCompleted = message.info.time.completed
    }
  }

  commitTurn()

  return map
}

/**
 * 每个可见 assistant 消息所属回合的用户消息发送时间。
 * 过程折叠前端实时计时的起点；完成后用 buildTurnDurationMap 校正。
 */
export function buildTurnUserStartMap(messages: Message[], visibleMessages: Message[]): Map<string, number> {
  const map = new Map<string, number>()
  const visibleAssistantIds = new Set(
    visibleMessages.filter(message => message.info.role === 'assistant').map(message => message.info.id),
  )

  let currentUserCreated: number | null = null

  for (const message of messages) {
    if (message.info.role === 'user') {
      currentUserCreated = message.info.time.created
      continue
    }
    if (currentUserCreated == null || message.info.role !== 'assistant') continue
    if (visibleAssistantIds.has(message.info.id)) {
      map.set(message.info.id, currentUserCreated)
    }
  }

  return map
}

/**
 * 每个用户回合里，最后一条可见 assistant 消息的 id 集合。
 * 用于「仅最新 Step」：中间 assistant 消息不显示 step 完成信息。
 */
export function buildTurnLatestAssistantIdSet(visibleMessages: Message[]): Set<string> {
  const latestIds = new Set<string>()
  let currentLatestAssistantId: string | null = null

  const commitTurn = () => {
    if (currentLatestAssistantId) latestIds.add(currentLatestAssistantId)
  }

  for (const message of visibleMessages) {
    if (message.info.role === 'user') {
      commitTurn()
      currentLatestAssistantId = null
      continue
    }
    if (message.info.role === 'assistant') {
      currentLatestAssistantId = message.info.id
    }
  }

  commitTurn()
  return latestIds
}
