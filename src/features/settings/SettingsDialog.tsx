import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import {
  SunIcon,
  GlobeIcon,
  AgentIcon,
  CpuIcon,
  KeyboardIcon,
  CloseIcon,
  BellIcon,
  PlugIcon,
  MessageSquareIcon,
  LayersIcon,
  QuestionIcon,
  CogIcon,
} from '../../components/Icons'
import { useIsMobile } from '../../hooks'
import { isTauri } from '../../utils/tauri'
import { KeybindingsSection } from './KeybindingsSection'
import { AgentSettings } from './components/AgentSettings'
import { AppearanceSettings } from './components/AppearanceSettings'
import { AboutSettings } from './components/AboutSettings'
import { ChatSettings } from './components/ChatSettings'
import { ModelsSettings } from './components/ModelsSettings'
import { NotificationSettings } from './components/NotificationSettings'
import { ServiceSettings } from './components/ServiceSettings'
import { ServersSettings } from './components/ServersSettings'
import { WorkspaceSettings } from './components/WorkspaceSettings'
import { ConfigSettings } from './components/ConfigSettings'

// ============================================
// Types
// ============================================

export type SettingsTab =
  | 'agent'
  | 'appearance'
  | 'chat'
  | 'models'
  | 'notifications'
  | 'service'
  | 'config'
  | 'servers'
  | 'keybindings'
  | 'workspace'
  | 'about'

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  initialTab?: SettingsTab | 'general'
}

// ============================================
// Nav Tabs
// ============================================

const TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  servers: <GlobeIcon size={15} />,
  agent: <AgentIcon size={15} />,
  chat: <MessageSquareIcon size={15} />,
  models: <CpuIcon size={15} />,
  appearance: <SunIcon size={15} />,
  workspace: <LayersIcon size={15} />,
  notifications: <BellIcon size={15} />,
  service: <PlugIcon size={15} />,
  config: <CogIcon size={15} />,
  keybindings: <KeyboardIcon size={15} />,
  about: <QuestionIcon size={15} />,
}

const TAB_IDS: SettingsTab[] = [
  'servers',
  'models',
  'agent',
  'chat',
  'workspace',
  'appearance',
  'notifications',
  'service',
  'config',
  'keybindings',
  'about',
]

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  servers: 'tabs.servers',
  agent: 'tabs.agent',
  chat: 'tabs.chat',
  models: 'tabs.models',
  appearance: 'tabs.appearance',
  workspace: 'tabs.workspace',
  notifications: 'tabs.notifications',
  service: 'tabs.service',
  config: 'tabs.config',
  keybindings: 'tabs.shortcuts',
  about: 'tabs.about',
}

const TAB_DESC_KEYS: Record<SettingsTab, string> = {
  servers: 'tabs.serversDesc',
  agent: 'tabs.agentDesc',
  chat: 'tabs.chatDesc',
  models: 'tabs.modelsDesc',
  appearance: 'tabs.appearanceDesc',
  workspace: 'tabs.workspaceDesc',
  notifications: 'tabs.notificationsDesc',
  service: 'tabs.serviceDesc',
  config: 'tabs.configDesc',
  keybindings: 'tabs.shortcutsDesc',
  about: 'tabs.aboutDesc',
}

const GROUP_DEFS: { labelKey: string; tabs: SettingsTab[] }[] = [
  { labelKey: 'groups.core', tabs: ['servers', 'models', 'agent', 'chat', 'workspace', 'appearance', 'notifications'] },
  { labelKey: 'groups.advanced', tabs: ['service', 'config', 'keybindings', 'about'] },
]

// ============================================
// Tab Content Router
// ============================================

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'agent':
      return <AgentSettings />
    case 'appearance':
      return <AppearanceSettings />
    case 'chat':
      return <ChatSettings />
    case 'models':
      return <ModelsSettings />
    case 'notifications':
      return <NotificationSettings />
    case 'service':
      return <ServiceSettings />
    case 'config':
      return <ConfigSettings />
    case 'servers':
      return <ServersSettings />
    case 'keybindings':
      return <KeybindingsSection />
    case 'workspace':
      return <WorkspaceSettings />
    case 'about':
      return <AboutSettings />
    default:
      return null
  }
}

// ============================================
// Main Settings Dialog
// ============================================

export function SettingsDialog({ isOpen, onClose, initialTab = 'servers' }: SettingsDialogProps) {
  const { t } = useTranslation(['settings'])
  const isMobile = useIsMobile()
  const isTauriDesktop = isTauri() && !isMobile
  const scrollRef = useRef<HTMLDivElement>(null)
  const normalizeTab = useCallback((next: SettingsDialogProps['initialTab']): SettingsTab => {
    if (!next || next === 'general') return 'servers'
    return next
  }, [])
  const [tab, setTab] = useState<SettingsTab>(normalizeTab(initialTab))

  const visibleTabIds = useMemo(
    () => (isTauriDesktop ? TAB_IDS : TAB_IDS.filter(id => id !== 'service')),
    [isTauriDesktop],
  )

  const visibleTabs = useMemo(
    () =>
      visibleTabIds.map(id => ({
        id,
        label: t(TAB_LABEL_KEYS[id]),
        description: t(TAB_DESC_KEYS[id]),
        icon: TAB_ICONS[id],
      })),
    [visibleTabIds, t],
  )

  const groupedTabs = useMemo(
    () =>
      GROUP_DEFS.map(group => ({
        label: t(group.labelKey),
        tabs: group.tabs
          .map(id => visibleTabs.find(vt => vt.id === id))
          .filter((vt): vt is (typeof visibleTabs)[number] => !!vt),
      })).filter(group => group.tabs.length > 0),
    [visibleTabs, t],
  )

  useEffect(() => {
    if (!isOpen) return

    const frameId = requestAnimationFrame(() => {
      setTab(normalizeTab(initialTab))
    })

    return () => cancelAnimationFrame(frameId)
  }, [isOpen, initialTab, normalizeTab])

  useEffect(() => {
    if (visibleTabs.some(t => t.id === tab)) return

    const frameId = requestAnimationFrame(() => {
      setTab(visibleTabs[0]?.id || 'servers')
    })

    return () => cancelAnimationFrame(frameId)
  }, [tab, visibleTabs])

  // 切换 tab 时重置滚动位置
  const switchTab = useCallback((nextTab: SettingsTab) => {
    setTab(nextTab)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
    })
  }, [])

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
        const ids = visibleTabs.map(t => t.id)
        if (ids.length === 0) return
        const next = (ids.indexOf(tab) + dir + ids.length) % ids.length
        switchTab(ids[next])
        requestAnimationFrame(() => {
          document.getElementById(`settings-tab-${ids[next]}`)?.focus()
        })
      }
    },
    [tab, visibleTabs, switchTab],
  )

  const activePanelId = `settings-panel-${tab}`

  // 移动端：全屏体验，顶部 sticky tab
  if (isMobile) {
    return (
      <Dialog
        isOpen={isOpen}
        onClose={onClose}
        title=""
        ariaLabel={t('title')}
        width="100%"
        className="h-full"
        showCloseButton={false}
        rawContent
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Sticky Tabs — 无标题、无线条，与桌面端设计语言一致 */}
          <div className="shrink-0 pt-2">
            <div
              role="tablist"
              aria-label={t('title')}
              onKeyDown={handleTabKeyDown}
              className="flex items-center gap-1 px-3 pb-2 overflow-x-auto scrollbar-none"
            >
              {visibleTabs.map(vt => (
                <button
                  key={vt.id}
                  id={`settings-tab-${vt.id}`}
                  type="button"
                  role="tab"
                  aria-selected={vt.id === tab}
                  aria-controls={`settings-panel-${vt.id}`}
                  tabIndex={vt.id === tab ? 0 : -1}
                  onClick={() => switchTab(vt.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[length:var(--fs-md)] font-medium transition-colors whitespace-nowrap shrink-0
                    ${
                      vt.id === tab
                        ? 'bg-bg-100/80 text-text-100'
                        : 'text-text-400 active:bg-bg-100/40'
                    }`}
                >
                  {vt.icon}
                  {vt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div
            id={activePanelId}
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab}`}
            ref={scrollRef}
            className="flex-1 min-h-0 py-3 px-4 overflow-y-auto custom-scrollbar overscroll-contain"
          >
            <TabContent tab={tab} />
          </div>
        </div>
      </Dialog>
    )
  }

  // 桌面端：左侧导航 + 右侧内容
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title=""
      ariaLabel={t('title')}
      width="min(97vw, 1040px)"
      showCloseButton={false}
      rawContent
    >
      <div className="relative flex h-[min(90vh,820px)]">
        {/* 关闭按钮 — 绝对定位右上角，悬浮于内容之上，不占布局 */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 hidden md:flex items-center justify-center w-7 h-7 rounded-md text-text-400/60 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
          aria-label={t('closeSettings')}
          title={t('closeSettings')}
        >
          <CloseIcon size={16} />
        </button>

        {/* Left Nav — 与内容共享同一表面，仅靠留白和 active 胶囊区分 */}
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label={t('title')}
          className="w-[204px] xl:w-[228px] shrink-0 pt-10 pr-3 pl-6 xl:pl-7 pb-3 flex flex-col min-h-0"
          onKeyDown={handleTabKeyDown}
        >
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-3.5 pb-2">
            {groupedTabs.map(group => (
              <div key={group.label}>
                <div className="mb-1.5 px-2.5 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-400/75">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.tabs.map(vt => {
                    const active = vt.id === tab
                    return (
                      <button
                        key={vt.id}
                        id={`settings-tab-${vt.id}`}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls={`settings-panel-${vt.id}`}
                        onClick={() => switchTab(vt.id)}
                        tabIndex={active ? 0 : -1}
                        className={`w-full min-h-8 flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[length:var(--fs-md)] font-medium transition-colors
                          ${
                            active
                              ? 'bg-bg-200/70 text-text-100'
                              : 'text-text-400 hover:text-text-200 hover:bg-bg-100/50'
                          }`}
                      >
                        <span className={active ? 'text-accent-main-100' : 'text-text-400'}>{vt.icon}</span>
                        <span className="truncate">{vt.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* 版本号与菜单图标左边缘对齐，弱化为辅助信息 */}
          <div className="shrink-0 mt-2 px-2.5">
            <div
              className="text-[length:var(--fs-xxs)] font-mono tabular-nums text-text-500/75 leading-snug truncate"
              title={t('version', { version: __APP_VERSION__ })}
            >
              v{__APP_VERSION__}
            </div>
          </div>
        </nav>

        {/* Right Content — 与 nav 同一表面，仅靠左侧留白分隔 */}
        <div
          id={activePanelId}
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          ref={scrollRef}
          className="flex-1 min-w-0 min-h-0 overflow-y-auto custom-scrollbar pt-10 pb-6 pl-8 xl:pl-9 pr-9 xl:pr-11"
        >
          <TabContent tab={tab} />
        </div>
      </div>
    </Dialog>
  )
}
