import { useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import type { GitCommitInfo, UsageSnapshot } from '@shared/types'
import { useAppStore } from '../../store/app.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/dialog.store'
import UsageCharts from './UsageCharts'
import Modal from '../common/Modal'

export default function SettingsPane(): JSX.Element {
  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const refresh = useAppStore((s) => s.refreshWorkspace)

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
    toast.success('API 配置已保存')
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
      toast.success('工作目录迁移完成')
      await refresh()
    } else {
      toast.error(res.error ?? '迁移失败')
    }
  }

  async function toggleGit(enabled: boolean): Promise<void> {
    if (enabled) {
      const check = await api.invoke('git:ensure', { consent: false })
      if (!check.ok) {
        if (!(await confirmDialog('系统未检测到 Git，是否自动安装？（可能需要一段时间）'))) {
          await updateConfig({ gitEnabled: false })
          return
        }
        const installed = await api.invoke('git:ensure', { consent: true })
        if (!installed.ok) {
          toast.error(installed.reason === 'manual-required' ? '安装失败，请手动安装 Git 后重试' : 'Git 安装失败')
          await updateConfig({ gitEnabled: false })
          return
        }
      }
      await updateConfig({ gitEnabled: true })
      toast.success('版本管理已开启')
    } else {
      await updateConfig({ gitEnabled: false })
    }
  }

  async function openHistory(): Promise<void> {
    const projects = workspace.projects
    if (projects.length === 0) {
      toast.info('暂无项目')
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
    if (!(await confirmDialog('回滚项目到该提交？已打开的相关标签页将关闭，请确认未提交改动已处理。'))) return
    const res = await api.invoke('git:rollback', { projectId, hash })
    if (res.ok) {
      toast.success('回滚完成')
      setShowHistory(false)
      await refresh()
    } else {
      toast.error(res.error ?? '回滚失败')
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
      <h2 className="mb-4 text-lg font-semibold">设置</h2>

      <div className="space-y-6">
        <Section title="工作目录">
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {config.workspaceDir || '未设置'}
          </div>
          <button className="btn mt-2" onClick={() => void migrate()}>
            修改工作目录（迁移项目数据）
          </button>
        </Section>

        <Section title="API 配置">
          <div className="space-y-3">
            <Field label="API Base URL">
              <input className="input" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="API Key">
              <div className="flex items-center gap-2">
                <input
                  className="input"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={hasKey ? '••••••••（已配置，输入以更新）' : '未配置'}
                />
                <span className="whitespace-nowrap text-xs" style={{ color: hasKey ? 'var(--ok)' : 'var(--muted)' }}>
                  {hasKey ? '已配置' : '未配置'}
                </span>
              </div>
            </Field>
            <Field label="模型名称">
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
            </Field>
            <Field label="模型上下文上限（token）">
              <input className="input" type="number" value={contextLimit} onChange={(e) => setContextLimit(Number(e.target.value) || 256000)} />
            </Field>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => void saveApi()}>
                保存
              </button>
              <button className="btn" disabled={testing} onClick={() => void test()}>
                {testing ? '测试中…' : '联通测试'}
              </button>
            </div>
          </div>
        </Section>

        <Section title="自动保存">
          <Field label="自动保存间隔（秒，对所有编辑器标签页生效）">
            <input className="input !w-40" type="number" min={1} max={120} value={autosave} onChange={(e) => setAutosave(Number(e.target.value) || 5)} />
          </Field>
          <button className="btn mt-2" onClick={() => void updateConfig({ autosaveIntervalMs: autosave * 1000 }).then(() => toast.success('已保存'))}>
            保存
          </button>
        </Section>

        <Section title="摘要功能">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.summaryEnabled}
              onChange={(e) => void updateConfig({ summaryEnabled: e.target.checked })}
            />
            启用自动摘要（文档摘要 + 对话摘要 + 资源摘要）
          </label>

          {config.summaryEnabled && (
            <div className="mt-4 space-y-4">
              <InjGroup title="项目级对话">
                <InjCheck label="项目内所有文档摘要" checked={inj.project.docSummaries} onChange={(v) => patchInj('project', 'docSummaries', v)} />
                <InjCheck label="项目内所有对话摘要" checked={inj.project.chatSummaries} onChange={(v) => patchInj('project', 'chatSummaries', v)} />
                <InjCheck label="项目内所有资源摘要" checked={inj.project.resourceSummaries} onChange={(v) => patchInj('project', 'resourceSummaries', v)} />
              </InjGroup>

              <InjGroup title="文档级对话（无滑块）">
                <InjCheck label="关联文档全文" checked={inj.doc.fullText} onChange={(v) => patchInj('doc', 'fullText', v)} />
                <InjCheck label="该文档其他对话摘要" checked={inj.doc.docChatSummaries} onChange={(v) => patchInj('doc', 'docChatSummaries', v)} />
                <InjCheck label="项目内其他文档摘要" checked={inj.doc.otherDocSummaries} onChange={(v) => patchInj('doc', 'otherDocSummaries', v)} />
                <InjCheck label="资源摘要" checked={inj.doc.resourceSummaries} onChange={(v) => patchInj('doc', 'resourceSummaries', v)} />
              </InjGroup>

              <InjGroup title="文档级对话（有滑块）">
                <InjCheck label="项目内所有文档摘要（含该文档）" checked={inj.context.docSummaries} onChange={(v) => patchInj('context', 'docSummaries', v)} />
                <InjCheck label="该文档其他对话摘要" checked={inj.context.docChatSummaries} onChange={(v) => patchInj('context', 'docChatSummaries', v)} />
                <InjCheck label="资源摘要" checked={inj.context.resourceSummaries} onChange={(v) => patchInj('context', 'resourceSummaries', v)} />
              </InjGroup>
            </div>
          )}
        </Section>

        <Section title="版本管理">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.gitEnabled}
              onChange={(e) => void toggleGit(e.target.checked)}
            />
            启用 Git 版本管理（每项目一个仓库，关闭时保留仓库但停止自动提交）
          </label>
          {config.gitEnabled && (
            <button className="btn mt-2" onClick={() => void openHistory()}>
              <History size={14} />
              打开版本历史
            </button>
          )}
        </Section>

        <Section title="用量统计">
          {usage ? <UsageCharts snapshot={usage} /> : <div className="text-sm" style={{ color: 'var(--muted)' }}>加载中…</div>}
        </Section>
      </div>

      {showHistory && (
        <Modal
          title="版本历史"
          onClose={() => setShowHistory(false)}
          footer={
            <button className="btn" onClick={() => setShowHistory(false)}>
              关闭
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
                暂无提交记录
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
                    回滚到此
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
