import { useMemo, useRef } from 'react'
import { getMessageText, type Message } from '../../types/message'
import { buildOutlineSourceEntries, type OutlineSourceEntry } from '../../components/outlineIndexModel'
import {
  buildVisibleMessageEntries,
  getVisibleMessageForkTargetId,
  type VisibleMessageEntry,
} from './chatAreaVisibility'
import {
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  buildTurnUserStartMap,
  PAGE_MESSAGE_COUNT,
  reconcileStableChatPages,
  type MessageGroupRow,
  type StableChatPage,
} from './chatPageModel'

export interface ChatPageViewModel {
  paginationKey: string
  visibleMessageEntries: VisibleMessageEntry[]
  visibleMessages: Message[]
  pageRecords: StableChatPage[]
  outlineSourceEntries: OutlineSourceEntry[]
  outlineOwnerByMessageId: Map<string, string>
  forkTargetIdMap: Map<string, string | undefined>
  turnDurationMap: Map<string, number>
  turnUserStartMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
}

interface StableOutlineModel {
  signature: string
  entries: OutlineSourceEntry[]
  ownerByMessageId: Map<string, string>
}

const OUTLINE_MODEL_CACHE_LIMIT = 16
const outlineModelCache = new Map<string, StableOutlineModel>()

function buildOutlineSignature(messages: Message[]): string {
  let signature = ''
  for (const message of messages) {
    signature += `${message.info.id}:${message.info.role}|`
    if (message.info.role === 'user') {
      signature += `${message.info.summary?.title ?? getMessageText(message)}|`
    }
  }
  return signature
}

function buildOutlineOwnerByMessageId(messages: Message[]): Map<string, string> {
  const ownerByMessageId = new Map<string, string>()
  let lastUserMessageId: string | null = null

  for (const message of messages) {
    if (message.info.role === 'user') lastUserMessageId = message.info.id
    if (lastUserMessageId) ownerByMessageId.set(message.info.id, lastUserMessageId)
  }

  return ownerByMessageId
}

function getStableOutlineModel(messages: Message[]): StableOutlineModel {
  const signature = buildOutlineSignature(messages)
  const cached = outlineModelCache.get(signature)
  if (cached) {
    outlineModelCache.delete(signature)
    outlineModelCache.set(signature, cached)
    return cached
  }

  const next: StableOutlineModel = {
    signature,
    entries: buildOutlineSourceEntries(messages),
    ownerByMessageId: buildOutlineOwnerByMessageId(messages),
  }
  outlineModelCache.set(signature, next)
  if (outlineModelCache.size > OUTLINE_MODEL_CACHE_LIMIT) {
    const oldestKey = outlineModelCache.keys().next().value
    if (oldestKey) outlineModelCache.delete(oldestKey)
  }
  return next
}

function sameStringList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameParts(a: Message['parts'], b: Message['parts']) {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

function sameVisibleEntry(a: VisibleMessageEntry, b: VisibleMessageEntry) {
  return (
    sameStringList(a.sourceIds, b.sourceIds) &&
    a.message.info === b.message.info &&
    a.message.isStreaming === b.message.isStreaming &&
    sameParts(a.message.parts, b.message.parts)
  )
}

function reuseVisibleMessageEntries(
  previous: VisibleMessageEntry[] | undefined,
  next: VisibleMessageEntry[],
): VisibleMessageEntry[] {
  if (!previous || previous.length !== next.length) return next
  let changed = false
  const entries = next.map((entry, index) => {
    const previousEntry = previous[index]
    if (sameVisibleEntry(previousEntry, entry)) return previousEntry
    changed = true
    return entry
  })
  return changed ? entries : previous
}

function visibleMessagesFromEntries(previous: Message[] | undefined, entries: VisibleMessageEntry[]) {
  const messages = entries.map(entry => entry.message)
  if (
    previous &&
    previous.length === messages.length &&
    previous.every((message, index) => message === messages[index])
  ) {
    return previous
  }
  return messages
}

function sameRow(a: MessageGroupRow, b: MessageGroupRow) {
  return (
    a.key === b.key &&
    a.estimatedHeight === b.estimatedHeight &&
    a.collapsed === b.collapsed &&
    a.continuesFromPrevious === b.continuesFromPrevious &&
    a.continuesToNext === b.continuesToNext &&
    sameStringList(a.messageIds, b.messageIds) &&
    a.messages.every((message, index) => message === b.messages[index])
  )
}

function reusePageRecords(previous: StableChatPage[] | undefined, next: StableChatPage[]): StableChatPage[] {
  if (!previous) return next
  const previousByKey = new Map(previous.map(page => [page.key, page]))
  let changed = previous.length !== next.length
  const pages = next.map((page, index) => {
    const previousPage = previousByKey.get(page.key)
    if (
      previousPage &&
      previousPage.key === page.key &&
      previousPage.estimatedHeight === page.estimatedHeight &&
      sameStringList(previousPage.messageIds, page.messageIds) &&
      previousPage.rows.length === page.rows.length &&
      previousPage.rows.every((row, rowIndex) => sameRow(row, page.rows[rowIndex]))
    ) {
      if (previous[index] !== previousPage) changed = true
      return previousPage
    }
    changed = true
    return page
  })
  return !changed && previous.length === pages.length ? previous : pages
}

function buildForkTargetIdMap(entries: VisibleMessageEntry[]) {
  return new Map(entries.map(entry => [entry.message.info.id, getVisibleMessageForkTargetId(entry)]))
}

function reuseMap<K, V>(previous: Map<K, V> | undefined, next: Map<K, V>) {
  if (!previous || previous.size !== next.size) return next
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return next
  }
  return previous
}

function reuseSet<T>(previous: Set<T> | undefined, next: Set<T>) {
  if (!previous || previous.size !== next.size) return next
  for (const value of next) {
    if (!previous.has(value)) return next
  }
  return previous
}

export function buildChatPageViewModel(
  messages: Message[],
  previous?: ChatPageViewModel,
  rowCountLimit?: number,
  collapsed: boolean = false,
): ChatPageViewModel {
  const paginationKey = `${collapsed ? 'collapsed' : 'standard'}:${rowCountLimit ?? PAGE_MESSAGE_COUNT}`
  const reusablePrevious = previous?.paginationKey === paginationKey ? previous : undefined
  const visibleMessageEntries = reuseVisibleMessageEntries(
    reusablePrevious?.visibleMessageEntries,
    buildVisibleMessageEntries(messages),
  )
  const visibleMessages = visibleMessagesFromEntries(reusablePrevious?.visibleMessages, visibleMessageEntries)
  const pageRecords = reusePageRecords(
    reusablePrevious?.pageRecords,
    reconcileStableChatPages({
      currentPages: reusablePrevious?.pageRecords ?? [],
      nextMessages: visibleMessages,
      allocateKey: page => `${paginationKey}:${page.key}`,
      rowCountLimit,
      collapsed,
    }),
  )
  const forkTargetIdMap = reuseMap(reusablePrevious?.forkTargetIdMap, buildForkTargetIdMap(visibleMessageEntries))
  const outlineModel = getStableOutlineModel(visibleMessages)
  const turnDurationMap = reuseMap(reusablePrevious?.turnDurationMap, buildTurnDurationMap(messages, visibleMessages))
  const turnUserStartMap = reuseMap(
    reusablePrevious?.turnUserStartMap,
    buildTurnUserStartMap(messages, visibleMessages),
  )
  const turnLatestAssistantIds = reuseSet(
    reusablePrevious?.turnLatestAssistantIds,
    buildTurnLatestAssistantIdSet(visibleMessages),
  )

  return {
    paginationKey,
    visibleMessageEntries,
    visibleMessages,
    pageRecords,
    outlineSourceEntries: outlineModel.entries,
    outlineOwnerByMessageId: outlineModel.ownerByMessageId,
    forkTargetIdMap,
    turnDurationMap,
    turnUserStartMap,
    turnLatestAssistantIds,
  }
}

export function useChatPageViewModel(
  messages: Message[],
  rowCountLimit?: number,
  collapsed?: boolean,
): ChatPageViewModel {
  const previousRef = useRef<ChatPageViewModel | undefined>(undefined)
  return useMemo(() => {
    const viewModel = buildChatPageViewModel(messages, previousRef.current, rowCountLimit, collapsed)
    previousRef.current = viewModel
    return viewModel
  }, [messages, rowCountLimit, collapsed])
}
