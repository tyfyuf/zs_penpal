import { useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import type { GitCommitInfo, UsageSnapshot } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/dialog.store'
import { useI18nStore, useT, type Locale } from '../../i18n'
import UsageCharts from './UsageCharts'
import Modal from '../common/Modal'

export default function SettingsPane(): JSX.Element {
  const t = useT()
  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const refresh = useAppStore((s) => s.refreshWorkspace)
  const setLocale = useI18nStore((s) => s.setLocale)

  const [apiBaseUrl, setApiBaseUrl] = useState(config?.apiBaseUrl ?? '')
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

  useEffect(() => {
    void api.invoke('crypto:hasApiKey', undefined).then(setHasKey)
    void api.invoke('usage:get', undefined).then(setUsage)
  }, [])

  async function saveApi(): Promise<void> {
    await updateConfig({ apiBaseUrl, model, contextLimit })
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

  function patchInj(group: 'project' | 'doc' | 'context', key: string, value: boolean): void {
    void updateConfig({
      summaryInjection: {
        ...inj,
        [group]: { ...inj[group], [key]: value }
      }
    })
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">{t('settings.title')}</h2>

      <div className="space-y-6">
        <Section title={t('settings.language')}>
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
        </Section>

        <Section title={t('settings.workspace')}>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {config.workspaceDir || t('settings.workspaceUnset')}
          </div>
          <button className="btn mt-2" onClick={() => void migrate()}>
            {t('settings.migrate')}
          </button>
        </Section>

        <Section title={t('settings.api')}>
          <div className="space-y-3">
            <Field label={t('settings.apiBase')}>
              <input className="input" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
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
        </Section>

        <Section title={t('settings.autosave')}>
          <Field label={t('settings.autosaveInterval')}>
            <input className="input !w-40" type="number" min={1} max={120} value={autosave} onChange={(e) => setAutosave(Number(e.target.value) || 5)} />
          </Field>
          <button className="btn mt-2" onClick={() => void updateConfig({ autosaveIntervalMs: autosave * 1000 }).then(() => toast.success(t('settings.saved')))}>
            {t('settings.save')}
          </button>
        </Section>

        <Section title={t('settings.summary')}>
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
              <InjGroup title={t('settings.injProject')}>
                <InjCheck label={t('settings.injProjDocs')} checked={inj.project.docSummaries} onChange={(v) => patchInj('project', 'docSummaries', v)} />
                <InjCheck label={t('settings.injProjChats')} checked={inj.project.chatSummaries} onChange={(v) => patchInj('project', 'chatSummaries', v)} />
                <InjCheck label={t('settings.injProjRes')} checked={inj.project.resourceSummaries} onChange={(v) => patchInj('project', 'resourceSummaries', v)} />
              </InjGroup>

              <InjGroup title={t('settings.injDoc')}>
                <InjCheck label={t('settings.injDocFull')} checked={inj.doc.fullText} onChange={(v) => patchInj('doc', 'fullText', v)} />
                <InjCheck label={t('settings.injDocChats')} checked={inj.doc.docChatSummaries} onChange={(v) => patchInj('doc', 'docChatSummaries', v)} />
                <InjCheck label={t('settings.injDocOthers')} checked={inj.doc.otherDocSummaries} onChange={(v) => patchInj('doc', 'otherDocSummaries', v)} />
                <InjCheck label={t('settings.injDocRes')} checked={inj.doc.resourceSummaries} onChange={(v) => patchInj('doc', 'resourceSummaries', v)} />
              </InjGroup>

              <InjGroup title={t('settings.injContext')}>
                <InjCheck label={t('settings.injCtxDocs')} checked={inj.context.docSummaries} onChange={(v) => patchInj('context', 'docSummaries', v)} />
                <InjCheck label={t('settings.injCtxChats')} checked={inj.context.docChatSummaries} onChange={(v) => patchInj('context', 'docChatSummaries', v)} />
                <InjCheck label={t('settings.injCtxRes')} checked={inj.context.resourceSummaries} onChange={(v) => patchInj('context', 'resourceSummaries', v)} />
              </InjGroup>
            </div>
          )}
        </Section>

        <Section title={t('settings.version')}>
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
                  placeholder="VibeWrite"
                />
              </Field>
              <Field label={t('settings.gitAuthorEmail')}>
                <input
                  className="input"
                  value={gitAuthorEmail}
                  onChange={(e) => setGitAuthorEmail(e.target.value)}
                  placeholder="vibewrite@localhost"
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
        </Section>

        <Section title={t('settings.usage')}>
          {usage ? <UsageCharts snapshot={usage} /> : <div className="text-sm" style={{ color: 'var(--muted)' }}>{t('summary.loading')}</div>}
        </Section>
      </div>

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
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function InjGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
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
