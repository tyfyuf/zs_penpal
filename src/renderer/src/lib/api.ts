import type { RendererApi } from '@shared/ipc'

export const api: RendererApi & { send: (channel: string, payload?: unknown) => void } = window.api
