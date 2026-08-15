import { useState } from 'react'
import { useAppStore } from '../store/app.store'
import { api } from '../lib/api'
import { toast } from '../store/toast.store'
import { useT } from '../i18n'

export default function SetupScreen(): JSX.Element {
  const t = useT()
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
        <h1 className="mb-2 text-2xl font-semibold">{t('setup.title')}</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {t('setup.subtitle')}
        </p>
      </div>
      <button className="btn btn-primary text-base" disabled={busy} onClick={() => void choose()}>
        {busy ? t('setup.busy') : t('setup.choose')}
      </button>
      <p className="max-w-md text-center text-xs" style={{ color: 'var(--muted)' }}>
        {t('setup.hint')}
      </p>
    </div>
  )
}
