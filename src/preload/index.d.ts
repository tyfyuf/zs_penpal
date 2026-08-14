import type { RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi & { send: (channel: string, payload?: unknown) => void }
  }
}

export {}
