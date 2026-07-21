/**
 * 消息折叠块纵向间距契约
 * - header: 可折叠 header 的垂直 padding
 * - item: 列表项之间只靠 top 间距（根节点不加 pb）
 * - body: header 下方展开内容
 * - finish: steps 与 StepFinish 之间
 * - processBody: 过程折叠块内部列表容器
 * - toolBodyInset: compact/timeline 工具 body 左右缩进 + body 顶距
 */
export const MSG_SPACING = {
  header: 'py-1',
  item: 'pt-1',
  body: 'pt-1',
  finish: 'mt-1',
  processBody: 'flex flex-col gap-2 pt-1',
  toolBodyInset: 'pl-2 pr-2.5 pt-1',
} as const
