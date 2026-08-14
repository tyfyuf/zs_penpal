import { useState } from 'react'
import { useAppStore } from '../store/app.store'
import { api } from '../lib/api'
import { toast } from '../store/toast.store'

export default function SetupScreen(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const init = useAppStore((s) => s.init)

  async function choose(): Promise<void> {
    setBusy(true)
    try {
      const dir = await api.invoke('config:choose-workspace', undefined)
      if (dir) {
        await api.invoke('config:set', { workspaceDir: dir })
        await init()
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="mb-2 text-2xl font-semibold">WritingAgent</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          写作专精辅助 Agent —— 辅助创作者决策，不替代创作者完成写作成果
        </p>
      </div>
      <button className="btn btn-primary text-base" disabled={busy} onClick={() => void choose()}>
        {busy ? '处理中…' : '选择工作目录'}
      </button>
      <p className="max-w-md text-center text-xs" style={{ color: 'var(--muted)' }}>
        首次使用需要指定一个本地文件夹作为工作目录。所有项目、文档、对话与资源都将以文件形式保存在该目录中。
      </p>
    </div>
  )
}
