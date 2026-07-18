import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon, CheckIcon, CloseIcon, SettingsIcon, UndoIcon } from '../../../components/Icons'
import { Dialog } from '../../../components/ui/Dialog'
import { getConfig, getGlobalConfig, getProviderConfigs, listAvailableShells, updateGlobalConfig } from '../../../api'
import type { Config } from '../../../types/api/config'
import { useCurrentDirectory, useIsMobile } from '../../../hooks'
import { SettingsSection } from './SettingsUI'
import { validateConfig, validationDrillTargetForError, type ValidationDrillTarget, type ValidationError } from './configEditorValidation'
import { ValidationDrillTargetContext } from './configEditorDrillState'
import { JsonDraftErrorContext } from './configEditorJsonDraft'
import { SECTION_IDS, SECTION_META } from './configEditorMeta'
import { SectionRouter } from './configEditorSections'
import type { Choice, JsonRecord, SectionID } from './configEditorTypes'
import { clone, getObject, isRecord, sameValue, tx } from './configEditorUtils'

function ConfigEditorDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation('settings')
  const lang = i18n.language
  const directory = useCurrentDirectory()
  const isMobile = useIsMobile()
  const [section, setSection] = useState<SectionID>('general')
  const [config, setConfig] = useState<Config>({} as Config)
  const [original, setOriginal] = useState<Config>({} as Config)
  const [effective, setEffective] = useState<Config>({} as Config)
  const [shells, setShells] = useState<Choice[]>([])
  const [models, setModels] = useState<Choice[]>([])
  const [providerCatalog, setProviderCatalog] = useState<JsonRecord>({})
  const [loading, setLoading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [schemaWarning, setSchemaWarning] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([])
  const [validationDrillTarget, setValidationDrillTarget] = useState<ValidationDrillTarget | null>(null)
  const [jsonDraftErrors, setJsonDraftErrors] = useState<Set<string>>(() => new Set())
  const dirty = !sameValue(config, original)

  const reportJsonDraftError = useCallback((id: string, invalid: boolean) => {
    setJsonDraftErrors(prev => {
      const next = new Set(prev)
      if (invalid) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const updateConfig = useCallback((next: Config) => {
    setConfig(next)
    setValidationErrors([])
    setValidationDrillTarget(null)
  }, [])

  const load = useCallback(async () => {
    if (!isOpen) return
    setLoading(true)
    setError(null)
    setSchemaWarning(null)
    setValidationErrors([])
    setValidationDrillTarget(null)
    try {
      const [global, nextEffective, shellList, providers] = await Promise.all([
        getGlobalConfig(),
        getConfig(directory),
        listAvailableShells(directory).catch(() => []),
        getProviderConfigs(directory).catch(() => undefined),
      ])
      const modelChoices: Choice[] = []
      if (isRecord(providers)) {
        for (const [providerID, provider] of Object.entries(providers)) {
          if (!isRecord(provider) || !isRecord(provider.models)) continue
          for (const modelID of Object.keys(provider.models)) {
            modelChoices.push({ value: `${providerID}/${modelID}`, label: `${providerID}/${modelID}` })
          }
        }
      }
      setOriginal(clone(global))
      setConfig(clone(global))
      setJsonDraftErrors(new Set())
      setEffective(nextEffective)
      setProviderCatalog(isRecord(providers) ? providers : {})
      setShells([
        { value: '', label: t('config.shellAuto') },
        ...shellList.map(shell => ({
          value: shell.name === shell.path ? shell.path : shell.name,
          label: shell.name,
          hint: shell.path,
          disabled: !shell.acceptable,
        })),
      ])
      setModels(modelChoices)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [directory, isOpen, t])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setError(null)
    setSchemaWarning(null)
    setValidationErrors([])
    setValidationDrillTarget(null)
    if (jsonDraftErrors.size > 0) {
      setError(tx('Fix invalid JSON editors before saving.', '保存前请先修复无效 JSON 编辑框。', lang))
      return
    }
    setValidating(true)
    let officialResult: { errors: ValidationError[]; unavailable?: string }
    try {
      const { validateAgainstOfficialConfigSchema } = await import('./configOfficialValidator')
      officialResult = await validateAgainstOfficialConfigSchema(config)
    } catch (error) {
      officialResult = { errors: [], unavailable: error instanceof Error ? error.message : String(error) }
    } finally {
      setValidating(false)
    }
    const schemaUnavailableMessage = officialResult.unavailable
      ? tx('Official schema could not be loaded; this save relies on OpenCode server validation.', '无法加载官方 schema；本次保存将依赖 OpenCode 服务端校验。', lang)
      : null
    const nextValidationErrors = [...officialResult.errors, ...validateConfig(config, lang, original)]
    if (nextValidationErrors.length > 0) {
      if (schemaUnavailableMessage) setSchemaWarning(schemaUnavailableMessage)
      setValidationErrors(nextValidationErrors)
      return
    }
    setSaving(true)
    try {
      const saved = await updateGlobalConfig(config)
      setOriginal(clone(saved))
      setConfig(clone(saved))
      setEffective(await getConfig(directory))
      setSchemaWarning(null)
    } catch (err) {
      if (schemaUnavailableMessage) setSchemaWarning(schemaUnavailableMessage)
      setError(err instanceof Error ? err.message : t('config.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const agents = useMemo(() => {
    const names = new Set([
      'build',
      'plan',
      'general',
      'explore',
      ...Object.keys(getObject(config, 'agent')),
      ...Object.keys(getObject(effective, 'agent')),
    ])
    return Array.from(names)
      .sort()
      .map(value => ({ value, label: value }))
  }, [config, effective])

  const openValidationError = (error: ValidationError) => {
    const target = validationDrillTargetForError(error)
    setSection(target.section)
    setValidationDrillTarget({ ...target, key: `${error.path}:${Date.now()}` })
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      rawContent
      width={isMobile ? '100%' : 'min(97vw, 1040px)'}
      className={isMobile ? 'h-full' : undefined}
      showCloseButton={false}
      ariaLabel={t('config.editorTitle')}
    >
      <JsonDraftErrorContext.Provider value={reportJsonDraftError}>
        <ValidationDrillTargetContext.Provider value={validationDrillTarget}>
          <div
            className={`flex min-h-0 flex-col ${isMobile ? 'flex-1' : ''}`}
            style={isMobile ? undefined : { height: 'min(90vh, 820px)' }}
          >
            {isMobile ? (
              <div className="shrink-0">
                <div className="flex items-center justify-center px-4 pt-3 pb-2">
                  <div className="text-center">
                    <div className="truncate text-[length:var(--fs-heading-3)] font-semibold text-text-100">{t('config.editorTitle')}</div>
                    {dirty && <div className="mt-0.5 text-[length:var(--fs-xs)] text-warning-100">{t('config.unsaved')}</div>}
                  </div>
                </div>
                <div className="relative">
                  <div
                    role="tablist"
                    aria-label={t('config.editorTitle')}
                    className="flex items-center gap-1.5 overflow-x-auto px-4 pb-3 scrollbar-none"
                  >
                    {SECTION_IDS.map(id => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={section === id}
                        onClick={() => setSection(id)}
                        className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[length:var(--fs-md)] font-medium transition-colors ${
                          section === id
                            ? 'border-accent-main-100/30 bg-accent-main-100/10 text-accent-main-100'
                            : 'border-transparent text-text-400 active:bg-bg-100/60'
                        }`}
                      >
                        {tx(SECTION_META[id].en, SECTION_META[id].zh, lang)}
                      </button>
                    ))}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 border-b border-border-100/40" />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 border-b border-border-200/50 px-5 xl:px-6 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[length:var(--fs-heading-3)] font-semibold text-text-100">{t('config.editorTitle')}</div>
                  <div className="mt-0.5 truncate text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('config.noDeleteHint')}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  {dirty && <span className="hidden text-[length:var(--fs-xs)] text-warning-100 sm:inline">{t('config.unsaved')}</span>}
                  <button
                    type="button"
                    disabled={!dirty || saving || validating}
                    onClick={() => updateConfig(clone(original))}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-1.5 text-[length:var(--fs-xs)] text-text-300 transition-colors hover:bg-bg-100 disabled:opacity-40"
                  >
                    <UndoIcon size={13} />
                    {t('config.reset')}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving || validating}
                    onClick={save}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent-main-100 px-3 py-1.5 text-[length:var(--fs-xs)] font-medium text-white transition-opacity disabled:opacity-40"
                  >
                    <CheckIcon size={13} />
                    {saving ? t('config.saving') : validating ? tx('Validating…', '校验中…', lang) : t('config.saveAll')}
                  </button>
                  <button type="button" onClick={onClose} aria-label={t('closeSettings')} className="-mr-1 shrink-0 rounded-md p-2 text-text-400 transition-colors hover:bg-bg-100 hover:text-text-200">
                    <CloseIcon size={18} />
                  </button>
                </div>
              </div>
            )}
            {error && <div className="break-words border-b border-error-100/20 bg-error-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-error-100">{error}</div>}
            {schemaWarning && <div className="break-words border-b border-warning-100/20 bg-warning-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-warning-100">{schemaWarning}</div>}
            {validationErrors.length > 0 && (
              <div className="max-h-32 overflow-y-auto border-b border-error-100/20 bg-error-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-error-100 custom-scrollbar">
                <div className="mb-1 font-medium">{t('config.validationFailed', { defaultValue: 'Config validation failed' })}</div>
                <div className="space-y-1">
                  {validationErrors.slice(0, 12).map(error => (
                    <button
                      key={`${error.path}:${error.message}`}
                      type="button"
                      onClick={() => openValidationError(error)}
                      className="block min-w-0 text-left break-words hover:underline"
                    >
                      <span className="break-all font-mono">{error.path}</span>: {error.message}
                    </button>
                  ))}
                  {validationErrors.length > 12 && <div>{tx(`${validationErrors.length - 12} more issue(s)…`, `还有 ${validationErrors.length - 12} 个问题…`, lang)}</div>}
                </div>
              </div>
            )}
            {loading && <div className="border-b border-border-200/50 px-4 py-2 text-[length:var(--fs-xs)] text-text-400">{t('config.loading')}</div>}
            {isMobile ? (
              <>
                <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 custom-scrollbar overscroll-contain">
                  <SectionRouter section={section} config={config} setConfig={updateConfig} lang={lang} shells={shells} models={models} agents={agents} providerCatalog={providerCatalog} />
                </main>
                <div className="relative shrink-0 px-4 py-3">
                  <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-border-200/30" />
                  <div className="flex min-w-0 gap-2">
                    <button
                      type="button"
                      disabled={!dirty || saving || validating}
                      onClick={() => updateConfig(clone(original))}
                      className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-2 text-[length:var(--fs-sm)] font-medium text-text-300 transition-colors hover:bg-bg-100 disabled:opacity-40"
                    >
                      <UndoIcon size={14} />
                      {t('config.reset')}
                    </button>
                    <button
                      type="button"
                      disabled={!dirty || saving || validating}
                      onClick={save}
                      className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent-main-100 px-3 py-2 text-[length:var(--fs-sm)] font-medium text-white transition-opacity disabled:opacity-40"
                    >
                      <CheckIcon size={14} />
                      {saving ? t('config.saving') : validating ? tx('Validating…', '校验中…', lang) : t('config.saveAll')}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="min-w-0 border-r border-border-200/50 p-2">
                  <div className="space-y-0.5">
                    {SECTION_IDS.map(id => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSection(id)}
                        className={`w-full rounded-lg px-3 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${
                          section === id ? 'bg-accent-main-100/12 font-medium text-accent-main-100' : 'text-text-300 hover:bg-bg-100 hover:text-text-100'
                        }`}
                      >
                        {tx(SECTION_META[id].en, SECTION_META[id].zh, lang)}
                      </button>
                    ))}
                  </div>
                </aside>
                <main className="min-h-0 min-w-0 overflow-y-auto p-5 custom-scrollbar xl:px-6">
                  <SectionRouter section={section} config={config} setConfig={updateConfig} lang={lang} shells={shells} models={models} agents={agents} providerCatalog={providerCatalog} />
                </main>
              </div>
            )}
          </div>
        </ValidationDrillTargetContext.Provider>
      </JsonDraftErrorContext.Provider>
    </Dialog>
  )
}

export function ConfigSettings() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <SettingsSection
        title={t('config.sourceTitle')}
        description={t('config.sourceDesc')}
        actions={
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[length:var(--fs-sm)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
          >
            <SettingsIcon size={14} />
            {t('config.openEditor')}
          </button>
        }
      >
        <div className="flex items-start gap-2.5 rounded-lg bg-warning-bg/40 border border-warning-100/20 px-3.5 py-3 text-[length:var(--fs-sm)] text-text-300 leading-relaxed">
          <AlertCircleIcon size={14} className="mt-0.5 shrink-0 text-warning-100" />
          <span>{t('config.sdkOnlyWarning')}</span>
        </div>
      </SettingsSection>
      <ConfigEditorDialog isOpen={open} onClose={() => setOpen(false)} />
    </div>
  )
}
