import { useEffect, useState } from 'react'
import type { RecoveryState } from '@shared/types'
import { useAppStore } from './store/app.store'
import { api } from './lib/api'
import { flushAll } from './lib/editorRegistry'
import { toast } from './store/toast.store'
import AppLayout from './components/layout/AppLayout'
import SetupScreen from './components/SetupScreen'
import ToastHost from './components/common/ToastHost'
import DialogHost from './components/common/DialogHost'
import Modal from './components/common/Modal'
import SettingsPane from './components/settings/SettingsPane'
import { useT } from './i18n'

export default function App(): JSX.Element {
  const t = useT()
  const initialized = useAppStore((s) => s.initialized)
  const config = useAppStore((s) => s.config)
  const init = useAppStore((s) => s.init)
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)
  const isSettingsWindow = window.location.hash === '#settings'

  // 窗口标题跟随语言
  useEffect(() => {
    document.title = isSettingsWindow ? t('settings.title') : t('app.title')
  }, [isSettingsWindow, t])

  useEffect(() => {
    void init()
  }, [init])

  // 异常退出恢复检测（PRD 1.6 / 9.23）
  useEffect(() => {
    if (!initialized || isSettingsWindow) return
    void api.invoke('recovery:check', undefined).then((r) => {
      if (r) setRecovery(r)
    })
  }, [initialized])

  // 单实例文件传递（PRD 1.5 / 9.15）
  useEffect(() => {
    if (isSettingsWindow) return undefined
    const off = api.on('open-external-file', (path) => {
      void handleExternalFile(path)
    })
    return off
  }, [])

  // 退出前落盘未保存的编辑器内容（主进程 flush 握手）
  useEffect(() => {
    if (isSettingsWindow) return undefined
    const off = api.on('app:flush', () => {
      void flushAll().then(() => api.send('app:flushed'))
    })
    return off
  }, [])

  async function handleExternalFile(path: string): Promise<void> {
    const res = await api.invoke('file:openExternal', path)
    if (!res.ok) {
      toast.error(res.error ?? '无法打开文件')
      return
    }
    useAppStore.getState().openExternalResource(res)
    toast.info(`已临时打开外部文件：${res.name}`)
  }

  async function confirmRecovery(restore: boolean): Promise<void> {
    if (restore && recovery) {
      const { openDoc, openChat, refreshWorkspace } = useAppStore.getState()
      await refreshWorkspace()
      if (recovery.docId) {
        const ws = useAppStore.getState().workspace
        const doc = ws.projects.flatMap((p) => p.docs).find((d) => d.id === recovery.docId)
        if (doc) openDoc(doc)
      }
      if (recovery.chatId) {
        const ws = useAppStore.getState().workspace
        const chat = ws.projects.flatMap((p) => p.chats).find((c) => c.id === recovery.chatId)
        if (chat) openChat(chat)
      }
    }
    await api.invoke('recovery:clear', undefined)
    setRecovery(null)
  }

  if (!initialized) {
    return <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>{t('app.loading')}</div>
  }

  if (isSettingsWindow) {
    return (
      <>
        <div className="h-full" style={{ background: 'var(--bg)' }}>
          <SettingsPane />
        </div>
        <ToastHost />
        <DialogHost />
      </>
    )
  }

  return (
    <>
      {!config?.workspaceDir ? <SetupScreen /> : <AppLayout />}
      {recovery && (
        <Modal
          title={t('app.recoveryTitle')}
          footer={
            <>
              <button className="btn" onClick={() => void confirmRecovery(false)}>
                {t('app.recoveryNo')}
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRecovery(true)}>
                {t('app.recoveryYes')}
              </button>
            </>
          }
        >
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {t('app.recoveryText')}
          </p>
        </Modal>
      )}
      <ToastHost />
      <DialogHost />
    </>
  )
}
