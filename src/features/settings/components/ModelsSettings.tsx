import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, CheckIcon, SearchIcon } from '../../../components/Icons'
import { useModels } from '../../../hooks'
import { modelVisibilityStore, useHiddenModelKeys } from '../../../store'
import { groupModelsByProvider, getModelKey } from '../../../utils/modelUtils'
import type { ModelInfo } from '../../../types/ui'
import { SettingsSection, Toggle } from './SettingsUI'

function formatContext(limit: number): string {
  if (!limit) return ''
  const k = Math.round(limit / 1000)
  if (k >= 1000) return `${(k / 1000).toFixed(0)}M`
  return `${k}k`
}

function isModClick(e: React.MouseEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

export function ModelsSettings() {
  const { t } = useTranslation('settings')
  const { models, isLoading } = useModels()
  const hiddenModelKeys = useHiddenModelKeys()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // 范围选择锚点：上一次单击的模型 key
  const anchorKeyRef = useRef<string | null>(null)
  const hiddenModelKeySet = useMemo(() => new Set(hiddenModelKeys), [hiddenModelKeys])

  const visibleCount = useMemo(
    () => models.reduce((count, model) => (hiddenModelKeySet.has(getModelKey(model)) ? count : count + 1), 0),
    [models, hiddenModelKeySet],
  )

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return models

    const normalize = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '')
    return models.filter(
      model =>
        normalize(model.name).includes(normalizedQuery) ||
        normalize(model.id).includes(normalizedQuery) ||
        normalize(model.family).includes(normalizedQuery) ||
        normalize(model.providerName).includes(normalizedQuery),
    )
  }, [models, query])

  const groups = useMemo(() => groupModelsByProvider(filteredModels), [filteredModels])

  // 当前可见列表的扁平顺序（折叠的 provider 不参与 shift 范围）
  const flatVisibleModels = useMemo(() => {
    const list: ModelInfo[] = []
    for (const group of groups) {
      const isCollapsed = collapsed.has(group.providerName) && !query
      if (isCollapsed) continue
      list.push(...group.models)
    }
    return list
  }, [groups, collapsed, query])

  const flatKeyIndex = useMemo(() => {
    const map = new Map<string, number>()
    flatVisibleModels.forEach((model, index) => {
      map.set(getModelKey(model), index)
    })
    return map
  }, [flatVisibleModels])

  const toggleCollapse = (provider: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  /**
   * 切换模型可见性。
   * - 普通点击：切换当前项，并设为锚点
   * - Shift+点击：从锚点到当前项整段统一设为「当前项即将变成的状态」
   * - Ctrl/Cmd+点击：只切换当前项（不打断锚点，方便接着 Shift 扩选）
   */
  const handleModelActivate = useCallback(
    (model: ModelInfo, e: React.MouseEvent | React.KeyboardEvent) => {
      const key = getModelKey(model)
      const currentlyEnabled = !hiddenModelKeySet.has(key)
      const nextVisible = !currentlyEnabled

      // 至少保留一个可见
      if (currentlyEnabled && visibleCount <= 1 && !e.shiftKey) return

      const isShift = e.shiftKey && !isModClick(e)
      const isMod = isModClick(e)

      if (isShift && anchorKeyRef.current) {
        const from = flatKeyIndex.get(anchorKeyRef.current)
        const to = flatKeyIndex.get(key)
        if (from !== undefined && to !== undefined) {
          const start = Math.min(from, to)
          const end = Math.max(from, to)
          const range = flatVisibleModels.slice(start, end + 1)

          // 批量关掉时：不能把全部模型都关掉
          if (!nextVisible) {
            const remainingVisible = models.reduce((count, m) => {
              const k = getModelKey(m)
              const inRange = range.some(rm => getModelKey(rm) === k)
              if (inRange) return count // 范围里的都会被关
              return hiddenModelKeySet.has(k) ? count : count + 1
            }, 0)
            if (remainingVisible <= 0) {
              // 保底：只关范围里除第一个可见外的
              const keepOne = range.find(m => !hiddenModelKeySet.has(getModelKey(m)))
              const toHide = keepOne ? range.filter(m => getModelKey(m) !== getModelKey(keepOne)) : []
              if (toHide.length > 0) modelVisibilityStore.setManyVisible(toHide, false)
              return
            }
          }

          modelVisibilityStore.setManyVisible(range, nextVisible)
          return
        }
      }

      // 普通 / Ctrl·Cmd：单点切换
      if (currentlyEnabled && visibleCount <= 1) return
      modelVisibilityStore.setVisible(model, nextVisible)

      // Ctrl/Cmd 保持锚点；普通点击更新锚点
      if (!isMod) {
        anchorKeyRef.current = key
      } else if (!anchorKeyRef.current) {
        anchorKeyRef.current = key
      }
    },
    [flatKeyIndex, flatVisibleModels, hiddenModelKeySet, models, visibleCount],
  )

  return (
    <SettingsSection title={t('models.visibility')} description={t('models.visibilityDesc')}>
      <div className="relative group">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          spellCheck={false}
          autoCorrect="off"
          autoComplete="off"
          autoCapitalize="off"
          className="w-full h-9 bg-bg-200/70 hover:bg-bg-200 border border-border-200/50 rounded-lg pl-9 pr-9 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400/70 focus:outline-none transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-100/80 transition-colors"
            aria-label={t('models.clearSearch')}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">{t('models.loading')}</div>
      ) : groups.length === 0 ? (
        <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">
          {query ? t('models.noResults') : t('models.empty')}
        </div>
      ) : (
        <div className="space-y-1">
          {groups.map(group => {
            const providerModels = models.filter(model => model.providerName === group.providerName)
            const providerVisibleCount = providerModels.filter(
              model => !hiddenModelKeySet.has(getModelKey(model)),
            ).length
            const providerVisible = providerVisibleCount > 0
            const isCollapsed = collapsed.has(group.providerName) && !query

            return (
              <div key={group.providerName} className="rounded-lg overflow-hidden">
                <div
                  onClick={() => toggleCollapse(group.providerName)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-bg-100/60 transition-colors cursor-pointer select-none"
                >
                  <span className="text-text-400 shrink-0">
                    {isCollapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                  </span>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-[length:var(--fs-md)] font-semibold text-text-100 truncate">
                      {group.providerName}
                    </span>
                    <span className="text-[length:var(--fs-xs)] text-text-500 shrink-0">
                      {providerVisibleCount}/{providerModels.length}
                    </span>
                  </div>
                  <div onClick={e => e.stopPropagation()}>
                    <Toggle
                      enabled={providerVisible}
                      ariaLabel={`${t('models.visibility')}: ${group.providerName}`}
                      onChange={() => {
                        const nextVisible = !providerVisible
                        if (!nextVisible && providerVisibleCount >= visibleCount) return
                        modelVisibilityStore.setManyVisible(providerModels, nextVisible)
                        // provider 整组切换后，锚点落在该组第一个模型，方便接着 Shift
                        if (providerModels[0]) {
                          anchorKeyRef.current = getModelKey(providerModels[0])
                        }
                      }}
                    />
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="mt-0.5">
                    {group.models.map(model => {
                      const key = getModelKey(model)
                      const enabled = !hiddenModelKeySet.has(key)
                      const context = formatContext(model.contextLimit)
                      const disabled = enabled && visibleCount <= 1
                      const showId = model.id && model.id !== model.name

                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={e => {
                            // 最后一个可见项：普通点击禁止关掉，Shift/Mod 由 handler 守卫
                            if (disabled && !e.shiftKey && !isModClick(e)) return
                            handleModelActivate(model, e)
                          }}
                          onKeyDown={e => {
                            if (e.key !== ' ' && e.key !== 'Enter') return
                            e.preventDefault()
                            if (disabled && !e.shiftKey && !isModClick(e)) return
                            handleModelActivate(model, e)
                          }}
                          className={`group w-full flex items-center gap-2.5 pl-9 pr-3 py-[7px] rounded-md transition-colors text-left select-none
                            ${
                              disabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-bg-100/50'
                            }`}
                        >
                          {/* 轻量勾选：细边框空框 / 淡 accent 底 + 勾，避免厚重色块 */}
                          <span
                            className={`shrink-0 w-[15px] h-[15px] rounded-[4px] flex items-center justify-center transition-colors
                              ${
                                enabled
                                  ? 'bg-accent-main-100/15 text-accent-main-100 ring-1 ring-accent-main-100/45'
                                  : 'bg-transparent text-transparent ring-1 ring-border-200 group-hover:ring-border-300'
                              }`}
                            aria-hidden
                          >
                            <CheckIcon size={11} className={enabled ? 'opacity-100' : 'opacity-0'} />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 min-w-0">
                              <span
                                className={`truncate text-[length:var(--fs-md)] leading-snug ${
                                  enabled ? 'text-text-100' : 'text-text-400'
                                }`}
                              >
                                {model.name}
                              </span>
                              {showId && (
                                <span className="truncate text-[length:var(--fs-xs)] text-text-500 font-mono min-w-0">
                                  {model.id}
                                </span>
                              )}
                            </div>
                          </div>
                          {context && (
                            <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500 font-mono tabular-nums">
                              {context}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[length:var(--fs-xs)] text-text-400">
        {t('models.keepOneEnabled')}
        <span className="text-text-500"> · {t('models.multiSelectHint')}</span>
      </p>
    </SettingsSection>
  )
}
