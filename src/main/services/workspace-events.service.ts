import { EVENTS, type WorkspaceChangedPayload, type WorkspaceChangeEntity, type WorkspaceChangeReason } from '@shared/ipc'
import { broadcast } from '../window'

let revision = 0

/** Notify renderer windows that persisted workspace state has changed. */
export function notifyWorkspaceChanged(input: {
  projectId?: string
  entityType?: WorkspaceChangeEntity
  entityId?: string
  reason: WorkspaceChangeReason
}): void {
  const payload: WorkspaceChangedPayload = {
    ...input,
    revision: ++revision,
    timestamp: new Date().toISOString()
  }
  broadcast(EVENTS.workspaceChanged, payload)
}
