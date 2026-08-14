import { useEffect, useState } from 'react'
import { useDialogStore } from '../../store/dialog.store'
import Modal from './Modal'

export default function DialogHost(): JSX.Element | null {
  const state = useDialogStore((s) => s.state)
  const resolve = useDialogStore((s) => s.resolve)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (state.open && state.kind === 'prompt') setValue(state.defaultValue)
  }, [state.open, state.kind, state.defaultValue])

  if (!state.open) return null

  const isPrompt = state.kind === 'prompt'
  const isChoice = state.kind === 'choice'

  return (
    <Modal
      title={isPrompt ? '输入' : isChoice ? '选择' : '确认'}
      onClose={() => resolve(null)}
      footer={
        isChoice ? (
          <>
            <button className="btn" onClick={() => resolve(null)}>
              取消
            </button>
            {state.options.map((o) => (
              <button key={o.value} className="btn btn-primary" onClick={() => resolve(o.value)}>
                {o.label}
              </button>
            ))}
          </>
        ) : (
          <>
            <button className="btn" onClick={() => resolve(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => resolve(isPrompt ? value.trim() || null : 'ok')}
            >
              确定
            </button>
          </>
        )
      }
    >
      {isPrompt ? (
        <div>
          <div className="mb-2 text-sm">{state.label}</div>
          <input
            className="input"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') resolve(value.trim() || null)
              if (e.key === 'Escape') resolve(null)
            }}
          />
        </div>
      ) : (
        <div className="text-sm leading-relaxed">{state.label}</div>
      )}
    </Modal>
  )
}
