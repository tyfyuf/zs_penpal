import { create } from 'zustand'

export type ToastKind = 'info' | 'error' | 'success'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
}

interface ToastStore {
  toasts: Toast[]
  push(message: string, kind?: ToastKind): void
  remove(id: number): void
}

let seq = 0

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push(message, kind = 'info') {
    const id = ++seq
    set({ toasts: [...get().toasts, { id, message, kind }] })
    setTimeout(() => get().remove(id), 4000)
  },
  remove(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))

export const toast = {
  info: (m: string) => useToastStore.getState().push(m, 'info'),
  error: (m: string) => useToastStore.getState().push(m, 'error'),
  success: (m: string) => useToastStore.getState().push(m, 'success')
}
