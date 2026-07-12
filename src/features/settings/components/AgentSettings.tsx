import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { autoApproveStore } from '../../../store'
import type { AlwaysAllowMode } from '../../../store/autoApproveStore'
import { themeStore, type ProcessCollapseStyle, type ToolCardStyle } from '../../../store/themeStore'
import { Toggle, SegmentedControl, SettingRow, SettingsSection } from './SettingsUI'

export function AgentSettings() {
  const { t } = useTranslation(['settings'])
  const [alwaysAllowMode, setAlwaysAllowMode] = useState<AlwaysAllowMode>(autoApproveStore.alwaysAllowMode)
  const [approvePendingOnFullAuto, setApprovePendingOnFullAuto] = useState(autoApproveStore.approvePendingOnFullAuto)
  const [queueFollowupMessages, setQueueFollowupMessages] = useState(themeStore.queueFollowupMessages)
  const [descriptiveToolSteps, setDescriptiveToolSteps] = useState(themeStore.descriptiveToolSteps)
  const [inlineToolRequests, setInlineToolRequests] = useState(themeStore.inlineToolRequests)
  const [toolCardStyle, setToolCardStyle] = useState(themeStore.toolCardStyle)
  const [immersiveMode, setImmersiveMode] = useState(themeStore.immersiveMode)
  const [compactInlinePermission, setCompactInlinePermission] = useState(themeStore.compactInlinePermission)
  const [processCollapseEnabled, setProcessCollapseEnabled] = useState(themeStore.processCollapseEnabled)
  const [processCollapseStyle, setProcessCollapseStyle] = useState(themeStore.processCollapseStyle)

  const handleAlwaysAllowModeChange = (mode: AlwaysAllowMode) => {
    setAlwaysAllowMode(mode)
    autoApproveStore.setAlwaysAllowMode(mode)
    if (mode === 'backend') autoApproveStore.clearAllRules()
  }

  const handleApprovePendingOnFullAutoToggle = () => {
    const next = !approvePendingOnFullAuto
    setApprovePendingOnFullAuto(next)
    autoApproveStore.setApprovePendingOnFullAuto(next)
  }

  const handleQueueFollowupMessagesToggle = () => {
    const next = !queueFollowupMessages
    setQueueFollowupMessages(next)
    themeStore.setQueueFollowupMessages(next)
  }

  const handleDescriptiveToolStepsToggle = () => {
    const next = !descriptiveToolSteps
    setDescriptiveToolSteps(next)
    themeStore.setDescriptiveToolSteps(next)
  }

  const handleInlineToolRequestsToggle = () => {
    const next = !inlineToolRequests
    setInlineToolRequests(next)
    themeStore.setInlineToolRequests(next)
  }

  const handleCompactInlinePermissionToggle = () => {
    const next = !compactInlinePermission
    setCompactInlinePermission(next)
    themeStore.setCompactInlinePermission(next)
  }

  const handleToolCardStyleChange = (style: ToolCardStyle) => {
    setToolCardStyle(style)
    themeStore.setToolCardStyle(style)
  }

  const handleImmersiveModeToggle = () => {
    const next = !immersiveMode
    setImmersiveMode(next)
    themeStore.setImmersiveMode(next)
    setInlineToolRequests(next)
    setDescriptiveToolSteps(next)
    setToolCardStyle(next ? 'compact' : 'classic')
    setCompactInlinePermission(next)
  }

  const handleProcessCollapseToggle = () => {
    const next = !processCollapseEnabled
    setProcessCollapseEnabled(next)
    themeStore.setProcessCollapseEnabled(next)
    if (next) setDescriptiveToolSteps(true)
  }

  return (
    <div>
      <SettingsSection title={t('agent.behavior')}>
        <p className="text-[length:var(--fs-sm)] text-text-400">{t('agent.behaviorDesc')}</p>

        <div>
          <p className="text-[length:var(--fs-md)] text-text-100 mb-1.5">{t('chat.alwaysAllowMode')}</p>
          <p className="text-[length:var(--fs-sm)] text-text-400 mb-3">{t('chat.alwaysAllowModeDesc')}</p>
          <SegmentedControl
            value={alwaysAllowMode}
            options={[
              { value: 'backend', label: t('chat.alwaysAllowBackend') },
              { value: 'frontend', label: t('chat.alwaysAllowFrontend') },
            ]}
            onChange={v => handleAlwaysAllowModeChange(v as AlwaysAllowMode)}
          />
        </div>

        <SettingRow
          label={t('chat.approvePendingOnFullAuto')}
          description={t('chat.approvePendingOnFullAutoDesc')}
          onClick={handleApprovePendingOnFullAutoToggle}
        >
          <Toggle enabled={approvePendingOnFullAuto} onChange={handleApprovePendingOnFullAutoToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.queueFollowupMessages')}
          description={t('chat.queueFollowupMessagesDesc')}
          onClick={handleQueueFollowupMessagesToggle}
        >
          <Toggle enabled={queueFollowupMessages} onChange={handleQueueFollowupMessagesToggle} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('agent.toolInteraction')}>
        <p className="text-[length:var(--fs-sm)] text-text-400">{t('agent.toolInteractionDesc')}</p>

        <SettingRow
          label={t('chat.immersiveMode')}
          description={t('chat.immersiveModeDesc')}
          onClick={handleImmersiveModeToggle}
        >
          <Toggle enabled={immersiveMode} onChange={handleImmersiveModeToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.processCollapse')}
          description={t('chat.processCollapseDesc')}
          onClick={handleProcessCollapseToggle}
        >
          <Toggle enabled={processCollapseEnabled} onChange={handleProcessCollapseToggle} />
        </SettingRow>

        {processCollapseEnabled && (
          <div>
            <p className="text-[length:var(--fs-md)] text-text-100 mb-1.5">{t('chat.processCollapseStyle')}</p>
            <p className="text-[length:var(--fs-sm)] text-text-400 mb-3">{t('chat.processCollapseStyleDesc')}</p>
            <SegmentedControl
              value={processCollapseStyle}
              options={[{ value: 'processed', label: t('chat.processCollapseStyleProcessed') }]}
              onChange={v => {
                const style = v as ProcessCollapseStyle
                setProcessCollapseStyle(style)
                themeStore.setProcessCollapseStyle(style)
              }}
            />
          </div>
        )}

        <SettingRow
          label={t('chat.inlineToolRequests')}
          description={t('chat.inlineToolRequestsDesc')}
          onClick={handleInlineToolRequestsToggle}
        >
          <Toggle enabled={inlineToolRequests} onChange={handleInlineToolRequestsToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.descriptiveToolSteps')}
          description={t('chat.descriptiveToolStepsDesc')}
          onClick={handleDescriptiveToolStepsToggle}
        >
          <Toggle enabled={descriptiveToolSteps} onChange={handleDescriptiveToolStepsToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.compactInlinePermission')}
          description={t('chat.compactInlinePermissionDesc')}
          onClick={handleCompactInlinePermissionToggle}
        >
          <Toggle enabled={compactInlinePermission} onChange={handleCompactInlinePermissionToggle} />
        </SettingRow>

        <div>
          <p className="text-[length:var(--fs-md)] text-text-100 mb-1.5">{t('chat.toolCardStyle')}</p>
          <p className="text-[length:var(--fs-sm)] text-text-400 mb-3">{t('chat.toolCardStyleDesc')}</p>
          <SegmentedControl
            value={toolCardStyle}
            options={[
              { value: 'classic', label: t('chat.toolCardClassic') },
              { value: 'compact', label: t('chat.toolCardCompact') },
            ]}
            onChange={v => handleToolCardStyleChange(v as ToolCardStyle)}
          />
        </div>
      </SettingsSection>
    </div>
  )
}
