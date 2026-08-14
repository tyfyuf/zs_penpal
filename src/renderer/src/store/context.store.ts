import { create } from 'zustand'

export interface ContextHighlight {
  docId: string
  before: number
  after: number
  anchor: number
  selectionFrom?: number
  selectionTo?: number
}

interface ContextStore {
  highlight: ContextHighlight | null
  setHighlight(h: ContextHighlight | null): void
}

/** 上下文面板 → 编辑器的高亮桥接（PRD 6.4） */
export const useContextStore = create<ContextStore>((set) => ({
  highlight: null,
  setHighlight(h) {
    set({ highlight: h })
  }
}))
