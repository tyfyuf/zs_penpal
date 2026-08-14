import { contextBridge, ipcRenderer } from 'electron'
import type { EventChannel, EventPayloads, IpcChannel, IpcApi, RendererApi } from '@shared/ipc'

const api: RendererApi & { send: (channel: string, payload?: unknown) => void } = {
  invoke<K extends IpcChannel>(channel: K, req: IpcApi[K]['req']): Promise<IpcApi[K]['res']> {
    return ipcRenderer.invoke(channel, req) as Promise<IpcApi[K]['res']>
  },
  on<E extends EventChannel>(channel: E, listener: (payload: EventPayloads[E]) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: EventPayloads[E]): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  send(channel: string, payload?: unknown): void {
    ipcRenderer.send(channel, payload)
  }
}

contextBridge.exposeInMainWorld('api', api)
