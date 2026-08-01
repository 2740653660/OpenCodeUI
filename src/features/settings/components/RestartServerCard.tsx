import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { useServerStore } from '../../../hooks'
import { serverStorage } from '../../../utils/perServerStorage'
import { reconnectSSE } from '../../../api/events'
import { SettingField, SettingsSection, settingsFieldClass } from './SettingsUI'
import { detectSystemdActive, runRestartFlow, type RestartPhase, type RestartResult } from '../restartServer'

const RESTART_COMMAND_KEY = 'restart-command'
const RESTART_LOCK_PREFIX = 'restart-lock:'
const RESTART_LOCK_TTL_MS = 60_000

const PHASE_KEYS: Record<RestartPhase, string> = {
  idle: '',
  preflight: 'restart.phase.preflight',
  executing: 'restart.phase.executing',
  waiting: 'restart.phase.waiting',
  recovered: 'restart.success',
  failed: '',
}

function isRestartLocked(serverId: string): boolean {
  try {
    const raw = localStorage.getItem(`${RESTART_LOCK_PREFIX}${serverId}`)
    if (!raw) return false
    const timestamp = Number(raw)
    if (!Number.isFinite(timestamp)) return false
    return Date.now() - timestamp < RESTART_LOCK_TTL_MS
  } catch {
    return false
  }
}

function setRestartLock(serverId: string): void {
  try {
    localStorage.setItem(`${RESTART_LOCK_PREFIX}${serverId}`, String(Date.now()))
  } catch {
    // ignore
  }
}

function clearRestartLock(serverId: string): void {
  try {
    localStorage.removeItem(`${RESTART_LOCK_PREFIX}${serverId}`)
  } catch {
    // ignore
  }
}

// ============================================
// Restart Server Card
// ============================================

export function RestartServerCard() {
  const { t } = useTranslation(['settings', 'common'])
  const { activeServer } = useServerStore()
  const serverId = activeServer?.id

  const [command, setCommand] = useState(() => serverStorage.get(RESTART_COMMAND_KEY) ?? '')
  const [phase, setPhase] = useState<RestartPhase>('idle')
  const [output, setOutput] = useState('')
  const [result, setResult] = useState<RestartResult | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [errorKey, setErrorKey] = useState('')
  const [pendingCommand, setPendingCommand] = useState('')

  const cancelRequestedRef = useRef(false)
  const runningRef = useRef(false)

  const running = phase === 'preflight' || phase === 'executing' || phase === 'waiting'
  runningRef.current = running

  // 切换服务器时重新读取该服务器的重启命令
  useEffect(() => {
    if (runningRef.current) return
    setCommand(serverStorage.get(RESTART_COMMAND_KEY) ?? '')
    setPhase('idle')
    setOutput('')
    setResult(null)
    setErrorKey('')
  }, [serverId])

  const handleCommandChange = (value: string) => {
    setCommand(value)
    serverStorage.set(RESTART_COMMAND_KEY, value)
    setErrorKey('')
  }

  const handleRestartClick = async () => {
    if (!activeServer) return
    if (running || detecting) return
    if (isRestartLocked(activeServer.id)) {
      setErrorKey('restart.locked')
      return
    }

    let cmd = command.trim()
    if (!cmd) {
      // 命令为空 → 自动识别 systemd 服务
      setDetecting(true)
      try {
        const detected = await detectSystemdActive(activeServer)
        if (detected) {
          cmd = 'systemctl restart opencode.service'
          setCommand(cmd)
          serverStorage.set(RESTART_COMMAND_KEY, cmd)
        } else {
          setErrorKey('restart.emptyCommand')
          return
        }
      } finally {
        setDetecting(false)
      }
    }

    setErrorKey('')
    setPendingCommand(cmd)
    setConfirmOpen(true)
  }

  const handleConfirm = async () => {
    if (!activeServer || !pendingCommand) return
    setConfirmOpen(false)

    const server = {
      id: activeServer.id,
      name: activeServer.name,
      url: activeServer.url,
      auth: activeServer.auth,
    }
    cancelRequestedRef.current = false
    setRestartLock(server.id)
    setPhase('preflight')
    setOutput('')
    setResult(null)
    setErrorKey('')

    const res = await runRestartFlow({
      server,
      command: pendingCommand,
      onPhase: p => setPhase(p),
      onOutput: text => setOutput(prev => prev + text),
      isCancelled: () => cancelRequestedRef.current,
    })

    clearRestartLock(server.id)
    setResult(res)
    setPhase(res.phase)
    setOutput(res.output)
    if (res.ok) {
      // 服务已恢复，主动重连事件流（无订阅者时为空操作）
      reconnectSSE()
    }
  }

  const failureText = (res: RestartResult): string => {
    switch (res.reason) {
      case 'command-failed':
        return t('restart.commandFailed', { code: res.doneCode ?? '?' })
      case 'offline':
        return t('restart.offline')
      case 'unconfirmed':
        return t('restart.unconfirmed')
      case 'not-recovered':
        return t('restart.notRecovered')
      case 'timeout':
        return t('restart.timeout')
      case 'unauthorized':
        return t('restart.unauthorized')
      case 'cancelled':
        return t('restart.cancelled')
      case 'exec-error':
        return t('restart.execError')
      default:
        return t('restart.timeout')
    }
  }

  return (
    <SettingsSection title={t('restart.title')} description={t('restart.desc')}>
      <div className="space-y-3">
        <SettingField label={t('restart.commandLabel')} description={t('restart.commandHelp')}>
          <input
            type="text"
            value={command}
            onChange={e => handleCommandChange(e.target.value)}
            placeholder={t('restart.commandPlaceholder')}
            disabled={running}
            className={`${settingsFieldClass} font-mono`}
            spellCheck={false}
            autoComplete="off"
          />
        </SettingField>

        <div className="flex items-center gap-2">
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleRestartClick()}
            isLoading={detecting || running}
            disabled={!activeServer}
          >
            {t('restart.button')}
          </Button>
          {running && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                cancelRequestedRef.current = true
              }}
            >
              {t('restart.cancel')}
            </Button>
          )}
        </div>

        {running && PHASE_KEYS[phase] && (
          <p className="text-[length:var(--fs-xs)] text-text-300">{t(PHASE_KEYS[phase])}</p>
        )}

        {errorKey && <p className="text-[length:var(--fs-xs)] text-danger-100">{t(errorKey)}</p>}

        {result && result.ok && <p className="text-[length:var(--fs-xs)] text-success-100">{t('restart.success')}</p>}

        {result && !result.ok && (
          <div className="rounded-md border border-danger-100/30 bg-danger-100/5 px-2.5 py-2 space-y-1.5">
            <p className="text-[length:var(--fs-xs)] text-danger-100 leading-relaxed">{failureText(result)}</p>
            {output && (
              <>
                <p className="text-[length:var(--fs-xs)] text-text-400">{t('restart.outputLabel')}</p>
                <pre className="max-h-48 overflow-auto text-[length:var(--fs-xs)] font-mono text-text-200 whitespace-pre-wrap break-all leading-relaxed custom-scrollbar">
                  {output}
                </pre>
              </>
            )}
          </div>
        )}

        {running && output && (
          <pre className="max-h-48 overflow-auto text-[length:var(--fs-xs)] font-mono text-text-200 whitespace-pre-wrap break-all leading-relaxed custom-scrollbar">
            {output}
          </pre>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => {
          if (!running) setConfirmOpen(false)
        }}
        onConfirm={() => void handleConfirm()}
        title={t('restart.confirmTitle')}
        description={
          <div className="space-y-2.5">
            <p>{t('restart.confirmDesc', { name: activeServer?.name, url: activeServer?.url })}</p>
            <pre className="rounded-md border border-border-200 bg-bg-100 px-2.5 py-2 text-[length:var(--fs-xs)] font-mono text-text-100 whitespace-pre-wrap break-all leading-relaxed">
              {pendingCommand}
            </pre>
            <p className="text-[length:var(--fs-xs)] text-warning-100 leading-relaxed">{t('restart.warning')}</p>
          </div>
        }
        confirmText={t('restart.confirmText')}
        cancelText={t('restart.cancelText')}
        variant="danger"
      />
    </SettingsSection>
  )
}
