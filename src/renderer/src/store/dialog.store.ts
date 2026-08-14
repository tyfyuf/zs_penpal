import { create } from 'zustand'

type DialogKind = 'prompt' | 'confirm'

interface DialogState {
  open: boolean
  kind: DialogKind
  label: string
  defaultValue: string
  resolve: ((value: string | null) => void) | null
}

interface DialogStore {
  state: DialogState
  promptText: (label: string, defaultValue?: string) => Promise<string | null>
  confirm: (label: string) => Promise<boolean>
  resolve: (value: string | null) => void
}

/**
 * 自定义输入/确认对话框（Electron 渲染进程不支持 window.prompt，
 * 统一用模态框实现，避免原生 prompt 抛错）。
 */
export const useDialogStore = create<DialogStore>((set, get) => ({
  state: { open: false, kind: 'prompt', label: '', defaultValue: '', resolve: null },
  promptText(label, defaultValue = '') {
    return new Promise<string | null>((resolve) => {
      set({ state: { open: true, kind: 'prompt', label, defaultValue, resolve } })
    })
  },
  confirm(label) {
    return new Promise<boolean>((resolve) => {
      set({ state: { open: true, kind: 'confirm', label, defaultValue: '', resolve: (v) => resolve(v !== null) } })
    })
  },
  resolve(value) {
    const { resolve } = get().state
    set({ state: { open: false, kind: 'prompt', label: '', defaultValue: '', resolve: null } })
    resolve?.(value)
  }
}))

export function promptText(label: string, defaultValue = ''): Promise<string | null> {
  return useDialogStore.getState().promptText(label, defaultValue)
}

export function confirmDialog(label: string): Promise<boolean> {
  return useDialogStore.getState().confirm(label)
}
