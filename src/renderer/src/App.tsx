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

export default function App(): JSX.Element {
  const initialized = useAppStore((s) => s.initialized)
  const config = useAppStore((s) => s.config)
  const init = useAppStore((s) => s.init)
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  // 异常退出恢复检测（PRD 1.6 / 9.23）
  useEffect(() => {
    if (!initialized) return
    void api.invoke('recovery:check', undefined).then((r) => {
      if (r) setRecovery(r)
    })
  }, [initialized])

  // 单实例文件传递（PRD 1.5 / 9.15）
  useEffect(() => {
    const off = api.on('open-external-file', (path) => {
      void handleExternalFile(path)
    })
    return off
  }, [])

  // 退出前落盘未保存的编辑器内容（主进程 flush 握手）
  useEffect(() => {
    const off = api.on('app:flush', () => {
      void flushAll().then(() => api.send('app:flushed'))
    })
    return off
  }, [])

  async function handleExternalFile(path: string): Promise<void> {
    const res = await api.invoke('file:openExternal', path)
    const { refreshWorkspace, openResource } = useAppStore.getState()
    await refreshWorkspace()
    if (!res.ok) {
      toast.error(res.error ?? '无法打开文件')
      return
    }
    if (res.created) toast.success(`已创建项目并导入资源：${res.name}`)
    else toast.info(`已在项目中打开资源：${res.name}`)
    if (res.projectId && res.resourceId && res.name) {
      openResource(res.projectId, res.resourceId, res.name)
    }
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
    return <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>加载中…</div>
  }

  return (
    <>
      {!config?.workspaceDir ? <SetupScreen /> : <AppLayout />}
      {recovery && (
        <Modal
          title="恢复上次会话"
          footer={
            <>
              <button className="btn" onClick={() => void confirmRecovery(false)}>
                不恢复
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRecovery(true)}>
                恢复上次打开的内容
              </button>
            </>
          }
        >
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            上次应用异常退出，是否恢复上次打开的内容？
          </p>
        </Modal>
      )}
      <ToastHost />
      <DialogHost />
    </>
  )
}
