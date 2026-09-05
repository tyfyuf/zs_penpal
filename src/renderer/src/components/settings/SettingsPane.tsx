import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { History, RefreshCw, Search } from 'lucide-react'
import type { DocRollup, DocRollupOverview, GitCommitInfo, UsageSnapshot, VectorIndexStatus } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/dialog.store'
import { tGlobal, useI18nStore, useT, type Locale } from '../../i18n'
import UsageCharts from './UsageCharts'
import Modal from '../common/Modal'


type SettingsSection =
  | 'language'
  | 'work'
  | 'api'
  | 'memory'
  | 'archive'
  | 'trash'
  | 'version'
  | 'usage'

export default function SettingsPane(): JSX.Element {
  const t = useT()
  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const setLocale = useI18nStore((s) => s.setLocale)

  const [apiBaseUrl, setApiBaseUrl] = useState(config?.apiBaseUrl ?? '')
  const [apiProtocol, setApiProtocol] = useState<'chat_completions' | 'responses'>(config?.apiProtocol ?? 'chat_completions')
  const [model, setModel] = useState(config?.model ?? '')
  const [contextLimit, setContextLimit] = useState(config?.contextLimit ?? 256000)
  const [autosave, setAutosave] = useState(Math.round((config?.autosaveIntervalMs ?? 5000) / 1000))
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [historyProject, setHistoryProject] = useState('')
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [testing, setTesting] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [manualModel, setManualModel] = useState(true)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [gitAuthorName, setGitAuthorName] = useState(config?.gitAuthorName ?? '')
  const [gitAuthorEmail, setGitAuthorEmail] = useState(config?.gitAuthorEmail ?? '')
  const [rollups, setRollups] = useState<Record<string, DocRollupOverview>>({})
  const [rollupPreview, setRollupPreview] = useState<{ title: string; text: string } | null>(null)
  const [rollupBusy, setRollupBusy] = useState(false)
  const [vectorStatuses, setVectorStatuses] = useState<Record<string, VectorIndexStatus>>({})
  const [vectorBusy, setVectorBusy] = useState(false)
  const [vectorBusyKey, setVectorBusyKey] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSection>((localStorage.getItem('settings-section') as SettingsSection) ?? 'language')
  const [rollupSearch, setRollupSearch] = useState('')
  const [vectorSearch, setVectorSearch] = useState('')
  const [archiveSearch, setArchiveSearch] = useState('')
  const [trashSearch, setTrashSearch] = useState('')

  useEffect(() => {
    void api.invoke('crypto:hasApiKey', undefined).then(setHasKey)
    void api.invoke('usage:get', undefined).then(setUsage)
    void loadRollups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void loadVectorStatuses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.projects])

  async function loadRollups(): Promise<void> {
    const map: Record<string, DocRollupOverview> = {}
    for (const p of workspace.projects) {
      try {
        map[p.project.id] = await api.invoke('summary:listRollups', p.project.id)
      } catch {
        /* ignore */
      }
    }
    setRollups(map)
  }

  async function loadVectorStatuses(): Promise<void> {
    const map: Record<string, VectorIndexStatus> = {}
    for (const p of workspace.projects.filter((entry) => entry.project.system !== 'feature-guide')) {
      try {
        map[p.project.id] = await api.invoke('vector:status', p.project.id)
      } catch {
        /* ignore; the next refresh/build can recover */
      }
    }
    setVectorStatuses(map)
  }

  async function buildVectors(projectId: string): Promise<void> {
    setVectorBusy(true)
    setVectorBusyKey(projectId)
    try {
      const res = await api.invoke('vector:build', projectId)
      if (res.ok) toast.success(t('settings.vectorIndexBuilt', { n: res.chunkCount ?? 0, model: res.embedModel ?? 'unknown' }))
      else toast.error(res.error ?? t('settings.vectorIndexFailed'))
      await loadVectorStatuses()
    } finally {
      setVectorBusy(false)
      setVectorBusyKey(null)
    }
  }

  async function rebuildVectorFile(projectId: string, file: VectorIndexStatus['files'][number]): Promise<void> {
    const key = `${projectId}:${file.kind}:${file.id}`
    setVectorBusy(true)
    setVectorBusyKey(key)
    try {
      const res = await api.invoke('vector:rebuildSource', { projectId, id: file.id, kind: file.kind })
      if (res.ok) toast.success(t('settings.vectorIndexFileBuilt', { n: res.chunkCount ?? 0 }))
      else toast.error(res.error ?? t('settings.vectorIndexFailed'))
      await loadVectorStatuses()
    } finally {
      setVectorBusy(false)
      setVectorBusyKey(null)
    }
  }

  async function generateRollups(projectId: string): Promise<void> {
    setRollupBusy(true)
    try {
      const res = await api.invoke('summary:generateRollups', projectId)
      if (res.ok) toast.success(t('settings.rollupsGenerated'))
      else toast.error(res.error ?? t('settings.rollupsFail'))
      await loadRollups()
    } finally {
      setRollupBusy(false)
    }
  }

  async function regenRollup(projectId: string, rollupId: string): Promise<void> {
    setRollupBusy(true)
    try {
      const res = await api.invoke('summary:regenerateRollup', { projectId, rollupId })
      if (res.ok) toast.success(t('settings.rollupsGenerated'))
      else toast.error(res.error ?? t('settings.rollupsFail'))
      await loadRollups()
    } finally {
      setRollupBusy(false)
    }
  }

  async function previewRollup(projectId: string, rollupId: string, rangeLabel: string): Promise<void> {
    const r = await api.invoke('summary:getRollup', { projectId, rollupId })
    if (!r) return
    setRollupPreview({ title: `${t('settings.rollups')} · ${rangeLabel}`, text: formatRollup(r) })
  }

  useEffect(() => {
    void api.invoke('crypto:hasApiKey', undefined).then(setHasKey)
    void api.invoke('usage:get', undefined).then(setUsage)
  }, [])

  async function saveApi(): Promise<void> {
    await updateConfig({ apiBaseUrl, apiProtocol, model, contextLimit })
    if (apiKeyInput.trim()) {
      await api.invoke('crypto:setApiKey', apiKeyInput.trim())
      setApiKeyInput('')
      setHasKey(true)
    }
    toast.success(t('settings.saved'))
  }

  async function test(): Promise<void> {
    setTesting(true)
    try {
      const res = await api.invoke('crypto:testConnection', undefined)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    } finally {
      setTesting(false)
    }
  }

  async function migrate(): Promise<void> {
    const dir = await api.invoke('config:choose-workspace', undefined)
    if (!dir) return
    const res = await api.invoke('workspace:migrate', dir)
    if (res.ok) {
      toast.success(t('settings.migrateOk'))
      await refresh()
    } else {
      toast.error(res.error ?? t('editor.exportFail'))
    }
  }

  async function rebuildFeatureGuide(): Promise<void> {
    if (!(await confirmDialog(t('settings.featureGuideRestoreConfirm')))) return
    try {
      const result = await api.invoke('guide:rebuild', undefined)
      if (result.ok) {
        toast.success(t('settings.featureGuideRestored'))
        await refresh()
      } else {
        toast.error(result.error ?? t('settings.featureGuideRestoreFailed'))
      }
    } catch (err) {
      toast.error((err as Error).message || t('settings.featureGuideRestoreFailed'))
    }
  }

  async function toggleGit(enabled: boolean): Promise<void> {
    if (enabled) {
      const check = await api.invoke('git:ensure', { consent: false })
      if (!check.ok) {
        if (!(await confirmDialog(t('settings.gitMissing')))) {
          await updateConfig({ gitEnabled: false })
          return
        }
        const installed = await api.invoke('git:ensure', { consent: true })
        if (!installed.ok) {
          toast.error(installed.reason === 'manual-required' ? t('settings.gitManual') : t('settings.gitInstallFail'))
          await updateConfig({ gitEnabled: false })
          return
        }
      }
      await updateConfig({ gitEnabled: true })
      toast.success(t('settings.gitOn'))
    } else {
      await updateConfig({ gitEnabled: false })
    }
  }

  async function openHistory(): Promise<void> {
    const projects = workspace.projects
    if (projects.length === 0) {
      toast.info(t('settings.noProjects'))
      return
    }
    setHistoryProject(projects[0].project.id)
    setShowHistory(true)
    await loadCommits(projects[0].project.id)
  }

  async function loadCommits(projectId: string): Promise<void> {
    setHistoryProject(projectId)
    try {
      const log = await api.invoke('git:log', projectId)
      setCommits(log)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function rollback(projectId: string, hash: string): Promise<void> {
    if (!(await confirmDialog(t('settings.rollbackConfirm')))) return
    const res = await api.invoke('git:rollback', { projectId, hash })
    if (res.ok) {
      toast.success(t('settings.rollbackOk'))
      setShowHistory(false)
      await refresh()
    } else {
      toast.error(res.error ?? t('editor.exportFail'))
    }
  }

  async function changeLanguage(locale: Locale): Promise<void> {
    setLocale(locale)
    await updateConfig({ language: locale })
  }

  async function commitNow(): Promise<void> {
    const res = await api.invoke('git:commitAll', undefined)
    if (res.errors.length > 0) {
      toast.error(t('settings.commitErrors', { n: res.errors.length, detail: res.errors.join('；') }))
    } else if (res.committed.length > 0) {
      toast.success(t('settings.commitResult', { n: res.committed.length }))
    } else {
      toast.info(t('settings.commitNoChanges'))
    }
  }

  async function fetchModels(): Promise<void> {
    setFetchingModels(true)
    try {
      const res = await api.invoke('api:listModels', { baseURL: apiBaseUrl, apiKey: apiKeyInput.trim() || undefined })
      if (res.ok && res.models && res.models.length > 0) {
        setModels(res.models)
        setManualModel(false)
        toast.success(t('settings.modelsFetched', { n: res.models.length }))
      } else {
        toast.error(res.error ?? t('settings.modelsEmpty'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setFetchingModels(false)
    }
  }

  if (!config) return <div />

  const inj = config.summaryInjection

  function selectSection(section: SettingsSection): void {
    setActiveSection(section)
    localStorage.setItem('settings-section', section)
  }

  function patchInj(group: 'project' | 'doc' | 'context', key: 'basic' | 'dynamic' | 'fullText', value: number | boolean): void {
    void updateConfig({ summaryInjection: { ...inj, [group]: { ...inj[group], [key]: value } } })
  }

  const summaryWarning = useMemo(() => {
    const estimate = (group: { basic: number; dynamic: number }): number => (group.basic + group.dynamic) * 3 * 180
    return Math.max(estimate(inj.project), estimate(inj.doc), estimate(inj.context)) > Math.max(2000, config.contextLimit * 0.2)
  }, [config.contextLimit, inj])

  const searchMatch = (value: string, query: string): boolean => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const archiveQuery = archiveSearch.trim()
  const trashQuery = trashSearch.trim()
  const vectorProjects = workspace.projects.filter((project) => project.project.system !== 'feature-guide')
  const matchingTrashedProjects = workspace.trashedProjects
    .filter((project) => project.system !== 'feature-guide')
    .filter((project) => !trashQuery || searchMatch(project.name, trashQuery))
  const archivedChatGroups = workspace.projects
    .map((project) => ({
      project,
      chats: project.archivedChats.filter((chat) => !archiveQuery || searchMatch(project.project.name, archiveQuery) || searchMatch(chat.title, archiveQuery))
    }))
    .filter(({ chats }) => chats.length > 0)
  const trashDocGroups = workspace.projects
    .map((project) => ({
      project,
      docs: project.trashedDocs.filter((doc) => !trashQuery || searchMatch(project.project.name, trashQuery) || searchMatch(doc.title, trashQuery))
    }))
    .filter(({ docs }) => docs.length > 0)
  const hasArchivedChatMatches = archivedChatGroups.length > 0
  const hasTrashMatches = matchingTrashedProjects.length > 0 || trashDocGroups.length > 0

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className="w-48 shrink-0 border-r p-3"
        style={{
          width: '12rem',
          flex: '0 0 12rem',
          borderColor: 'var(--border)',
          background: 'var(--panel)'
        }}
      >
        <h2 className="mb-3 px-2 text-base font-semibold">{t('settings.title')}</h2>
        <nav className="space-y-1">
          {([
            ['language', t('settings.language')],
            ['work', t('settings.workspace')],
            ['api', t('settings.api')],
            ['memory', t('settings.memory')],
            ['archive', t('settings.archive')],
            ['trash', t('settings.trash')],
            ['version', t('settings.version')],
            ['usage', t('settings.usage')]
          ] as [SettingsSection, string][]).map(([section, label]) => (
            <button key={section} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${activeSection === section ? 'btn-primary' : ''}`} onClick={() => selectSection(section)}>
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="space-y-6">
        {activeSection === 'language' && (        <Section title={t('settings.language')}>
          <div className="flex gap-2">
            <button
              className={`btn ${config.language === 'zh' ? 'btn-primary' : ''}`}
              onClick={() => void changeLanguage('zh')}
            >
              {t('settings.languageZh')}
            </button>
            <button
              className={`btn ${config.language === 'en' ? 'btn-primary' : ''}`}
              onClick={() => void changeLanguage('en')}
            >
              {t('settings.languageEn')}
            </button>
          </div>
        </Section> )}

        {activeSection === 'work' && (        <Section title={t('settings.workspace')}>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {config.workspaceDir || t('settings.workspaceUnset')}
          </div>
          <button className="btn mt-2" onClick={() => void migrate()}>
            {t('settings.migrate')}
          </button>
          <button className="btn mt-2" onClick={() => void rebuildFeatureGuide()}>
            {t('settings.featureGuideRestore')}
          </button>
        </Section> )}

        {activeSection === 'api' && (        <Section title={t('settings.api')}>
          <div className="space-y-3">
            <Field label={t('settings.apiBase')}>
              <input className="input" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label={t('settings.apiProtocol')}>
              <select className="input" value={apiProtocol} onChange={(e) => setApiProtocol(e.target.value as 'chat_completions' | 'responses')}>
                <option value="chat_completions">Chat Completions</option>
                <option value="responses">OpenAI Responses API</option>
              </select>
            </Field>
            <Field label={t('settings.apiKey')}>
              <div className="flex items-center gap-2">
                <input
                  className="input"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={hasKey ? t('settings.apiKeySet') : t('settings.apiKeyEmpty')}
                />
                <span className="whitespace-nowrap text-xs" style={{ color: hasKey ? 'var(--ok)' : 'var(--muted)' }}>
                  {hasKey ? t('settings.configured') : t('settings.apiKeyEmpty')}
                </span>
              </div>
            </Field>
            <Field label={t('settings.model')}>
              {manualModel ? (
                <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
              ) : (
                <select
                  className="input"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value)
                    void updateConfig({ model: e.target.value })
                  }}
                >
                  {model && !models.includes(model) && <option value={model}>{model}</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
              <div className="mt-1.5 flex items-center gap-2">
                <button className="btn !px-2 !py-1 text-xs" disabled={fetchingModels} onClick={() => void fetchModels()}>
                  {fetchingModels ? t('settings.fetchingModels') : t('settings.fetchModels')}
                </button>
                <button className="btn !px-2 !py-1 text-xs" onClick={() => setManualModel((v) => !v)}>
                  {manualModel ? t('settings.pickModel') : t('settings.manualModel')}
                </button>
              </div>
            </Field>
            <Field label={t('settings.contextLimit')}>
              <input className="input" type="number" value={contextLimit} onChange={(e) => setContextLimit(Number(e.target.value) || 256000)} />
            </Field>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => void saveApi()}>
                {t('settings.save')}
              </button>
              <button className="btn" disabled={testing} onClick={() => void test()}>
                {testing ? t('settings.testing') : t('settings.test')}
              </button>
            </div>
          </div>
        </Section> )}

        {activeSection === 'work' && (        <Section title={t('settings.autosave')}>
          <Field label={t('settings.autosaveInterval')}>
            <input className="input !w-40" type="number" min={1} max={120} value={autosave} onChange={(e) => setAutosave(Number(e.target.value) || 5)} />
          </Field>
          <button className="btn mt-2" onClick={() => void updateConfig({ autosaveIntervalMs: autosave * 1000 }).then(() => toast.success(t('settings.saved')))}>
            {t('settings.save')}
          </button>
        </Section> )}

        {activeSection === 'memory' && (        <Section title={t('settings.summary')}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.summaryEnabled}
              onChange={(e) => void updateConfig({ summaryEnabled: e.target.checked })}
            />
            {t('settings.summaryToggle')}
          </label>

          {config.summaryEnabled && (
            <div className="mt-4 space-y-4">
              <LimitGroup title={t('settings.injProject')} basicLabel={t('settings.summaryBasic')} dynamicLabel={t('settings.summaryDynamic')} basic={inj.project.basic} dynamic={inj.project.dynamic} minBasic={5} maxBasic={10} minDynamic={10} maxDynamic={20} onChange={(key, value) => patchInj('project', key, value)} />
              <LimitGroup title={t('settings.injDoc')} basicLabel={t('settings.summaryBasic')} dynamicLabel={t('settings.summaryDynamic')} basic={inj.doc.basic} dynamic={inj.doc.dynamic} minBasic={10} maxBasic={20} minDynamic={10} maxDynamic={20} onChange={(key, value) => patchInj('doc', key, value)} />
              <LimitGroup title={t('settings.injContext')} basicLabel={t('settings.summaryBasic')} dynamicLabel={t('settings.summaryDynamic')} basic={inj.context.basic} dynamic={inj.context.dynamic} minBasic={10} maxBasic={20} minDynamic={10} maxDynamic={20} onChange={(key, value) => patchInj('context', key, value)} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={inj.doc.fullText} onChange={(e) => patchInj('doc', 'fullText', e.target.checked)} />
                {t('settings.injDocFull')}
              </label>
              {summaryWarning && <div className="rounded-lg border px-3 py-2 text-xs" style={{ color: 'var(--warn)', borderColor: 'var(--warn)', background: 'var(--accent-soft)' }}>{t('settings.summaryInjectionWarning')}</div>}
            </div>
          )}
        </Section> )}

        {activeSection === 'memory' && (
          <Section title={t('settings.rollups', { n: 10 })}>
            <div className="space-y-3">
              <SearchBox value={rollupSearch} onChange={setRollupSearch} placeholder={t('settings.searchEntries')} />
              {workspace.projects.length === 0 && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('settings.rollupsEmpty')}</div>
              )}
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {workspace.projects.map((p) => {
                  const ov = rollups[p.project.id]
                  if (rollupSearch.trim() && !searchMatch(p.project.name, rollupSearch) && !(ov?.rollups ?? []).some((r) => searchMatch(r.rangeLabel, rollupSearch))) return null
                  const docs = ov?.totalDocs ?? 0
                  const need = docs >= (ov?.threshold ?? 50)
                  return (
                    <div key={p.project.id} className="rounded border p-2" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{p.project.name}</span>
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>
                          {t('settings.rollupsDocCount', { n: docs })} · {t('settings.rollupsThreshold', { n: ov?.threshold ?? 50, b: ov?.batchSize ?? 10 })}
                        </span>
                        <span className="flex-1" />
                        <button className="btn !py-1 text-xs" disabled={rollupBusy || !need} onClick={() => void generateRollups(p.project.id)}>
                          {t('settings.rollupsGenerate')}
                        </button>
                      </div>
                      {ov && ov.rollups.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {ov.rollups.filter((r) => !rollupSearch.trim() || searchMatch(p.project.name, rollupSearch) || searchMatch(r.rangeLabel, rollupSearch)).map((r) => (
                            <div key={r.id} className="flex items-center gap-2 text-xs">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.stale ? 'var(--warn)' : 'var(--ok)' }} />
                              <span className="w-14">{t('settings.rollupsRange', { n: r.rangeLabel })}</span>
                              <span style={{ color: 'var(--muted)' }}>{t('settings.rollupsDocs', { n: r.docCount })}</span>
                              {r.stale && <span style={{ color: 'var(--warn)' }}>· {t('summary.stale')}</span>}
                              <span className="flex-1" />
                              <button className="btn !py-0.5 text-xs" onClick={() => void previewRollup(p.project.id, r.id, r.rangeLabel)}>{t('summary.preview')}</button>
                              <button className="btn !py-0.5 text-xs" disabled={rollupBusy} onClick={() => void regenRollup(p.project.id, r.id)}><RefreshCw size={12} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </Section>
        )}

        {activeSection === 'memory' && (
          <Section title={t('settings.vectorIndex')}>
            <div className="space-y-3">
              <SearchBox value={vectorSearch} onChange={setVectorSearch} placeholder={t('settings.searchEntries')} />
              {vectorProjects.length === 0 && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('settings.vectorIndexEmpty')}</div>
              )}
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {vectorProjects.map((p) => {
                  const status = vectorStatuses[p.project.id]
                  if (vectorSearch.trim() && !searchMatch(p.project.name, vectorSearch) && !(status?.files ?? []).some((f) => searchMatch(f.title, vectorSearch))) return null
                  return (
                    <div key={p.project.id} className="rounded border p-2" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{p.project.name}</span>
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>
                          {status ? `${t('settings.vectorIndexChunks', { n: status.chunkCount })} · ${status.embedModel ?? t('settings.vectorIndexNotBuilt')}` : t('summary.loading')}
                        </span>
                        <span className="flex-1" />
                        <button className="btn !py-1 text-xs" disabled={vectorBusy} onClick={() => void buildVectors(p.project.id)}>
                          <RefreshCw size={12} />
                          {vectorBusy ? t('settings.vectorIndexBuilding') : t('settings.vectorIndexBuild')}
                        </button>
                      </div>
                      {status?.indexExists && status.updatedAt && (
                        <div className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                          {t('settings.vectorIndexUpdated', { date: new Date(status.updatedAt).toLocaleString() })}
                        </div>
                      )}
                      {status && status.files.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {status.files.filter((file) => !vectorSearch.trim() || searchMatch(p.project.name, vectorSearch) || searchMatch(file.title, vectorSearch)).map((file) => {
                            const color = file.status === 'indexed'
                              ? 'var(--ok)'
                              : file.status === 'stale' || file.status === 'encoding-error'
                                ? 'var(--warn)'
                                : 'var(--muted)'
                            const label = file.status === 'indexed'
                              ? t('settings.vectorIndexIndexed')
                              : file.status === 'stale'
                                ? t('settings.vectorIndexStale')
                                : file.status === 'encoding-error'
                                  ? t('settings.vectorIndexEncodingError')
                                  : t('settings.vectorIndexNotBuilt')
                            const fileKey = `${p.project.id}:${file.kind}:${file.id}`
                            const canRebuild = file.status !== 'encoding-error'
                            const fileAction = file.status === 'indexed'
                              ? t('settings.vectorIndexRebuildFile')
                              : file.status === 'stale'
                                ? t('settings.vectorIndexUpdateFile')
                                : t('settings.vectorIndexBuildFile')
                            return (
                              <div key={`${file.kind}:${file.id}`} className="flex items-center gap-2 text-xs">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                                <span className="min-w-0 flex-1 truncate">{file.title}</span>
                                <span style={{ color }}>{label}</span>
                                <span style={{ color: 'var(--muted)' }}>{t('settings.vectorIndexFileChunks', { n: file.chunkCount })}</span>
                                <button
                                  className="btn !py-0.5 text-[11px]"
                                  disabled={vectorBusy || !canRebuild}
                                  title={file.status === 'encoding-error' ? t('settings.vectorIndexEncodingRepairFirst') : fileAction}
                                  onClick={() => void rebuildVectorFile(p.project.id, file)}
                                >
                                  <RefreshCw size={11} />
                                  {vectorBusyKey === fileKey ? t('settings.vectorIndexBuilding') : fileAction}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      ) : status ? (
                        <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{t('settings.vectorIndexNoFiles')}</div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </Section>
        )}

        {activeSection === 'archive' && (
          <Section title={t('settings.archive')}>
            <div className="space-y-3">
              <SearchBox value={archiveSearch} onChange={setArchiveSearch} placeholder={t('settings.searchEntries')} />
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {archivedChatGroups.map(({ project, chats }) => (
                  <div key={project.project.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>{project.project.name}</div>
                    {chats.map((chat) => (
                      <div key={chat.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { await api.invoke('chat:restore', chat.id); await refresh() }}>{t('settings.restore')}</button>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { if (!(await confirmDialog(t('sidebar.confirmPurgeChat')))) return; await api.invoke('chat:purge', chat.id); await refresh() }}>{t('settings.purge')}</button>
                      </div>
                    ))}
                  </div>
                ))}
                {!hasArchivedChatMatches && (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('settings.archivedChatsEmpty')}</div>
                )}
              </div>
            </div>
          </Section>
        )}

        {activeSection === 'trash' && (
          <Section title={t('settings.trash')}>
            <div className="space-y-3">
              <SearchBox value={trashSearch} onChange={setTrashSearch} placeholder={t('settings.searchEntries')} />
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {matchingTrashedProjects.length > 0 && (
                  <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('settings.projTrash')}</div>
                    {matchingTrashedProjects.map((project) => (
                      <div key={project.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { await api.invoke('project:restore', project.id); await refresh() }}>{t('settings.restore')}</button>
                        <button
                          className="btn !py-0.5 text-xs"
                          onClick={async () => {
                            if (!(await confirmDialog(t('sidebar.confirmPurgeProject')))) return
                            await api.invoke('project:purge', project.id)
                            await refresh()
                          }}
                        >
                          {t('settings.purge')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {trashDocGroups.map(({ project, docs }) => (
                  <div key={project.project.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>{project.project.name}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('settings.trashedDocs')}</div>
                    {docs.map((doc) => (
                      <div key={doc.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { await api.invoke('doc:restore', doc.id); await refresh() }}>{t('settings.restore')}</button>
                        <button className="btn !py-0.5 text-xs" onClick={async () => { if (!(await confirmDialog(t('sidebar.confirmPurgeDoc')))) return; await api.invoke('doc:purge', doc.id); await refresh() }}>{t('settings.purge')}</button>
                      </div>
                    ))}
                  </div>
                ))}
                {!hasTrashMatches && (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{t('settings.trashEmpty')}</div>
                )}
              </div>
            </div>
          </Section>
        )}

        {activeSection === 'version' && (        <Section title={t('settings.version')}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.gitEnabled}
              onChange={(e) => void toggleGit(e.target.checked)}
            />
            {t('settings.versionToggle')}
          </label>
          {config.gitEnabled && (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-2">
                <button className="btn" onClick={() => void openHistory()}>
                  <History size={14} />
                  {t('settings.openHistory')}
                </button>
                <button className="btn" onClick={() => void commitNow()}>
                  {t('settings.commitNow')}
                </button>
              </div>
              <Field label={t('settings.gitAuthorName')}>
                <input
                  className="input"
                  value={gitAuthorName}
                  onChange={(e) => setGitAuthorName(e.target.value)}
                  placeholder="Penpal"
                />
              </Field>
              <Field label={t('settings.gitAuthorEmail')}>
                <input
                  className="input"
                  value={gitAuthorEmail}
                  onChange={(e) => setGitAuthorEmail(e.target.value)}
                  placeholder="penpal@localhost"
                />
              </Field>
              <button
                className="btn"
                onClick={() =>
                  void updateConfig({ gitAuthorName: gitAuthorName.trim(), gitAuthorEmail: gitAuthorEmail.trim() }).then(() =>
                    toast.success(t('settings.saved'))
                  )
                }
              >
                {t('settings.save')}
              </button>
            </div>
          )}
        </Section> )}

        {activeSection === 'usage' && (        <Section title={t('settings.usage')}>
          {usage ? <UsageCharts snapshot={usage} /> : <div className="text-sm" style={{ color: 'var(--muted)' }}>{t('summary.loading')}</div>}
        </Section> )}
        </div>
      </main>

      {showHistory && (
        <Modal
          title={t('settings.historyTitle')}
          onClose={() => setShowHistory(false)}
          footer={
            <button className="btn" onClick={() => setShowHistory(false)}>
              {t('upload.close')}
            </button>
          }
        >
          <select className="input mb-3" value={historyProject} onChange={(e) => void loadCommits(e.target.value)}>
            {workspace.projects.map((p) => (
              <option key={p.project.id} value={p.project.id}>
                {p.project.name}
              </option>
            ))}
          </select>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {commits.length === 0 && (
              <div className="py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
                {t('settings.noCommits')}
              </div>
            )}
            {commits.map((c) => (
              <div key={c.hash} className="rounded-lg border p-2" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                    {c.hash.slice(0, 8)}
                  </span>
                  <button className="btn !px-2 !py-0.5 text-xs" onClick={() => void rollback(historyProject, c.hash)}>
                    <RefreshCw size={11} />
                    {t('settings.rollback')}
                  </button>
                </div>
                <div className="mt-1 text-sm">{c.message}</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  {c.author} · {new Date(c.date).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {rollupPreview && (
        <Modal
          title={rollupPreview.title}
          onClose={() => setRollupPreview(null)}
          footer={
            <button className="btn" onClick={() => setRollupPreview(null)}>
              {t('upload.close')}
            </button>
          }
        >
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">{rollupPreview.text}</pre>
        </Modal>
      )}
    </div>
  )
}


function SearchBox({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}): JSX.Element {
  return (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
      <input
        className="input" style={{ paddingLeft: 32 }}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  )
}

function LimitGroup({
  title,
  basicLabel,
  dynamicLabel,
  basic,
  dynamic,
  minBasic,
  maxBasic,
  minDynamic,
  maxDynamic,
  onChange
}: {
  title: string
  basicLabel: string
  dynamicLabel: string
  basic: number
  dynamic: number
  minBasic: number
  maxBasic: number
  minDynamic: number
  maxDynamic: number
  onChange: (key: 'basic' | 'dynamic', value: number) => void
}): JSX.Element {
  const update = (key: 'basic' | 'dynamic', value: number, min: number, max: number): void => {
    const next = Number.isFinite(value) ? Math.round(value) : min
    onChange(key, Math.max(min, Math.min(max, next)))
  }
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="space-y-3">
        <LimitRow label={basicLabel} value={basic} min={minBasic} max={maxBasic} onChange={(value) => update('basic', value, minBasic, maxBasic)} />
        <LimitRow label={dynamicLabel} value={dynamic} min={minDynamic} max={maxDynamic} onChange={(value) => update('dynamic', value, minDynamic, maxDynamic)} />
      </div>
    </div>
  )
}

function LimitRow({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
      <input
        className="input !py-1 text-center"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label}??`}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function InjGroup({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold" style={{ color: 'var(--muted)' }}>
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function InjCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function formatRollup(r: DocRollup): string {
  const changes = (Array.isArray(r.stateChanges) ? r.stateChanges : []).map((s) => `- ${s}`).join('\n')
  const causal = (Array.isArray(r.causality) ? r.causality : []).map((s) => `- ${s}`).join('\n')
  return `${tGlobal('settings.rollupOverview')}${r.overview || tGlobal('settings.none')}\n\n${tGlobal('settings.rollupStateChanges')}\n${changes || tGlobal('settings.none')}\n\n${tGlobal('settings.rollupCausality')}\n${causal || tGlobal('settings.none')}`
}
