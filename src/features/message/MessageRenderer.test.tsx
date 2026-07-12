import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageRenderer, splitImmersiveRenderItems } from './MessageRenderer'
import type { Message, Part, StepFinishPart, TextPart, ToolPart } from '../../types/message'

let mockRenderUserMarkdown = false
let mockCollapseUserMessages = false

vi.mock('motion/mini', () => ({
  animate: () => Promise.resolve(),
}))

vi.mock('../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
}))

vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false, canHover: true, hasCoarsePointer: false, hasTouch: false }),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    collapseUserMessages: mockCollapseUserMessages,
    renderUserMarkdown: mockRenderUserMarkdown,
    stepFinishDisplay: { latestOnly: true, turnDuration: false, tokens: true, cache: true, cost: true, duration: true, agent: false, model: false, completedAt: false },
    actionsOnLatestAssistantOnly: true,
    processCollapseEnabled: false,
    processCollapseStyle: 'processed',
    descriptiveToolSteps: false,
    inlineToolRequests: false,
    immersiveMode: false,
  }),
}))

vi.mock('../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="user-markdown">{content}</div>,
}))

vi.mock('../../components/ui', () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button">copy:{text}</button>,
  SmoothHeight: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./parts', () => ({
  TextPartView: ({ part }: { part: { text: string } }) => <div>{part.text}</div>,
  ReasoningPartView: () => null,
  ToolPartView: () => null,
  FilePartView: () => null,
  AgentPartView: () => null,
  SyntheticTextPartView: () => null,
  StepFinishPartView: () => null,
  SubtaskPartView: () => null,
  RetryPartView: () => null,
  CompactionPartView: () => <div>History compacted</div>,
  MessageErrorView: () => null,
}))

function createAssistantMessage(): Message {
  return {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      parentID: 'user-1',
      modelID: 'model-1',
      providerID: 'provider-1',
      mode: 'chat',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1 },
    },
    parts: [
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'assistant reply',
      },
    ],
    isStreaming: false,
  }
}

function createUserMessage(): Message {
  return {
    info: {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { modelID: 'model-1', providerID: 'provider-1' },
    },
    parts: [],
    isStreaming: false,
  }
}

function createUserTextMessage(text: string): Message {
  const message = createUserMessage()
  message.parts = [
    {
      id: 'text-user-1',
      sessionID: 'session-1',
      messageID: 'user-1',
      type: 'text',
      text,
    },
  ]
  return message
}

describe('MessageRenderer assistant fork', () => {
  beforeEach(() => {
    mockRenderUserMarkdown = false
    mockCollapseUserMessages = false
  })

  it('passes the explicit fork target id when forking an assistant message', async () => {
    const onFork = vi.fn()
    const message = createAssistantMessage()

    render(<MessageRenderer message={message} onFork={onFork} forkMessageId="assistant-2" />)

    fireEvent.click(screen.getByRole('button', { name: /fork|分叉/i }))

    await waitFor(() => {
      expect(onFork).toHaveBeenCalledWith(message, 'assistant-2')
    })
  })

  it('hides fork when the assistant message has no copyable text', () => {
    const onFork = vi.fn()
    const message = createAssistantMessage()
    message.parts = [
      {
        id: 'text-blank',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: '   ',
      },
    ]

    render(<MessageRenderer message={message} onFork={onFork} forkMessageId="assistant-2" />)

    expect(screen.queryByRole('button', { name: /fork|分叉/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('renders compaction parts inside user messages', () => {
    const message = createUserMessage()
    message.parts = [
      {
        id: 'compaction-1',
        sessionID: 'session-1',
        messageID: 'user-1',
        type: 'compaction',
        auto: true,
      },
    ]

    render(<MessageRenderer message={message} />)

    expect(screen.getByText('History compacted')).toBeInTheDocument()
  })

  it('keeps user text plain by default', () => {
    render(<MessageRenderer message={createUserTextMessage('Use **bold** text')} />)

    expect(screen.queryByTestId('user-markdown')).toBeNull()
    expect(screen.getByText('Use **bold** text')).toBeInTheDocument()
  })

  it('renders user text through markdown when enabled', () => {
    mockRenderUserMarkdown = true

    render(<MessageRenderer message={createUserTextMessage('Use **bold** text')} />)

    expect(screen.getByTestId('user-markdown')).toHaveTextContent('Use **bold** text')
  })

  it('does not crop an interactive user HTML artifact to the collapsed preview height', () => {
    mockRenderUserMarkdown = true
    mockCollapseUserMessages = true
    const message = createUserTextMessage(
      '<section><style>section{height:380px}</style><canvas></canvas><script>requestAnimationFrame(()=>{})</script></section>',
    )

    render(<MessageRenderer message={message} />)

    expect(screen.getByTestId('user-markdown').parentElement).not.toHaveStyle({ maxHeight: '8lh' })
    expect(screen.getByTestId('user-markdown').closest('.bg-bg-300')).toHaveClass('w-full', 'max-w-2xl')
    expect(screen.getByTestId('user-markdown').closest('.group')).toHaveClass('w-full')
    expect(screen.getByTestId('user-markdown').closest('[data-user-html-artifact]')).toBeInTheDocument()
  })
})

describe('splitImmersiveRenderItems', () => {
  it('keeps trailing final text outside process even when step-finish follows', () => {
    const toolPart = {
      id: 'tool-1',
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'completed', input: {}, output: 'ok', title: 'bash', time: { start: 1, end: 2 } },
    } as ToolPart
    const textPart = {
      id: 'text-1',
      type: 'text',
      text: '最终回答正文',
    } as TextPart
    const stepFinish = {
      id: 'sf-1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as StepFinishPart

    // 模拟 groupPartsForRender 输出：tool-group + 尾部 text + 独立 step-finish
    const items = [
      { type: 'tool-group' as const, parts: [toolPart] },
      { type: 'single' as const, part: textPart as Part },
      { type: 'single' as const, part: stepFinish as Part },
    ]

    const split = splitImmersiveRenderItems(items)

    expect(split.hasProcess).toBe(true)
    expect(split.hasFinal).toBe(true)
    expect(split.processItems).toHaveLength(1)
    expect(split.processItems[0].type).toBe('tool-group')
    expect(split.finalItems.some(it => it.type === 'single' && it.part.type === 'text')).toBe(true)
    expect(split.finalItems.some(it => it.type === 'single' && it.part.type === 'step-finish')).toBe(true)
  })
})
