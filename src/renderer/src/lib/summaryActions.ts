import { api } from './api'
import { toast } from '../store/toast.store'
import { chooseOption, confirmDialog } from '../store/dialog.store'
import { useAppStore } from '../store/app.store'
import { tGlobal } from '../i18n'
import type { ResourceDistillType } from '@shared/types'

export async function runDistill(projectId: string, resourceId: string): Promise<void> {
  try {
    const type = await chooseOption(tGlobal('distill.chooseType'), [
      { value: 'story', label: tGlobal('distill.story') },
      { value: 'setting', label: tGlobal('distill.setting') },
      { value: 'other', label: tGlobal('distill.other') }
    ])
    if (!type) return
    await doDistill(projectId, resourceId, type as ResourceDistillType, false)
  } catch (err) {
    toast.error((err as Error).message)
  }
  await useAppStore.getState().refreshWorkspace()
  useAppStore.getState().bumpSummary()
}

function typeLabel(type: ResourceDistillType | undefined): string {
  if (type === 'story') return tGlobal('distill.story')
  if (type === 'setting') return tGlobal('distill.setting')
  return tGlobal('distill.other')
}

async function doDistill(
  projectId: string,
  resourceId: string,
  type: ResourceDistillType,
  force: boolean
): Promise<void> {
  const res = await api.invoke('resource:distill', { projectId, resourceId, type, force })
  if (res.ok) {
    if (res.summary?.generation.state === 'incomplete') toast.error(tGlobal('summary.incomplete'))
    else toast.success(tGlobal('distill.ok'))
    return
  }
  const detected = typeLabel(res.detectedType)
  const chosen = typeLabel(type)
  const reasons = res.reasons?.length ? `（${res.reasons.join('；')}）` : ''
  if (res.mismatch) {
    const proceed = await confirmDialog(tGlobal('distill.mismatch', { type: detected, chosen, reasons }))
    if (proceed) await doDistill(projectId, resourceId, type, true)
    return
  }
  if (res.uncertain) {
    const proceed = await confirmDialog(tGlobal('distill.uncertain', { type: detected, chosen, reasons }))
    if (proceed) await doDistill(projectId, resourceId, type, true)
    return
  }
  toast.error(res.error ?? tGlobal('distill.fail'))
}

export async function runUndistill(projectId: string, resourceId: string): Promise<void> {
  try {
    if (!(await confirmDialog(tGlobal('distill.undistillConfirm')))) return
    await api.invoke('resource:undistill', { projectId, resourceId })
    toast.success(tGlobal('distill.undistillOk'))
  } catch (err) {
    toast.error((err as Error).message)
  }
  await useAppStore.getState().refreshWorkspace()
  useAppStore.getState().bumpSummary()
}

export async function runGenerateTitle(chatId: string): Promise<void> {
  const { setTitleGenerating, refreshWorkspace, bumpSummary } = useAppStore.getState()
  setTitleGenerating(chatId, true)
  try {
    const res = await api.invoke('chat:generateTitle', chatId)
    if (res.ok) {
      toast.success(tGlobal('distill.titleOk', { title: res.title ?? '' }))
      await refreshWorkspace()
      bumpSummary()
    } else {
      toast.error(res.error ?? tGlobal('distill.titleFail'))
    }
  } catch (err) {
    toast.error((err as Error).message)
  } finally {
    setTitleGenerating(chatId, false)
  }
}
