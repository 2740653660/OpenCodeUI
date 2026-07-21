import { COMPOSITOR_GRID_TRANSITION } from '../../hooks/useCompositorExpand'

/**
 * 消息流折叠展开动画契约
 * - grid 300ms，与 useCompositorExpand 桌面路径同一字符串
 * - delayed unmount 略长于动画，避免收起中途卸 DOM
 * - clip 横向放行，防止流光 / 阴影被竖向裁切
 */

export const MSG_EXPAND = {
  durationMs: 300,
  unmountDelayMs: 320,
  /** grid 高度动画（过程壳 / 思考 / 工具 steps 等） */
  panel: COMPOSITOR_GRID_TRANSITION,
  /** 卡片类：高度 + 淡入淡出（Retry / Error / Patch） */
  panelFade: 'transition-[grid-template-rows,opacity] duration-300 ease-out',
  /** chevron 旋转 */
  chevron: 'transition-transform duration-300',
  clipPath: 'inset(0 -100% 0 -100%)' as const,
} as const

export function expandGridClass(
  open: boolean,
  animate = true,
  panelClassName: string = MSG_EXPAND.panel,
): string {
  const rows = open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
  if (!animate) return `grid ${rows}`
  return `grid ${panelClassName} ${rows}`
}

export function expandFadeGridClass(open: boolean): string {
  return `grid ${MSG_EXPAND.panelFade} ${
    open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
  }`
}

export function chevronClass(open: boolean, extra = 'w-4 h-4 text-text-400'): string {
  return `${extra} ${MSG_EXPAND.chevron} ${open ? '' : '-rotate-90'}`
}
