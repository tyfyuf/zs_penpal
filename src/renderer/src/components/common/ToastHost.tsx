import { useToastStore } from '../../store/toast.store'

export default function ToastHost(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border px-4 py-2 text-sm shadow-lg"
          style={{
            background: 'var(--panel2)',
            borderColor: t.kind === 'error' ? 'var(--danger)' : t.kind === 'success' ? 'var(--ok)' : 'var(--border)',
            color: 'var(--text)'
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
