import { api } from './api'
import { toast } from '../store/toast.store'
import { chooseOption, confirmDialog } from '../store/dialog.store'
import { useAppStore } from '../store/app.store'
import { tGlobal } from '../i18n'

export async function runDistill(projectId: string, resourceId: string): Promise<void> {
  try {
    const type = await chooseOption(tGlobal('distill.chooseType'), [
      { value: 'story', label: tGlobal('distill.story') },
      { value: 'other', label: tGlobal('distill.other') }
    ])
    if (!type) return
    await doDistill(projectId, resourceId, type as 'story' | 'other', false)
  } catch (err) {
    toast.error((err as Error).message)
  }
  await useAppStore.getState().refreshWorkspace()
  useAppStore.getState().bumpSummary()
}

async function doDistill(
  projectId: string,
  resourceId: string,
  type: 'story' | 'other',
  force: boolean
): Promise<void> {
  const res = await api.invoke('resource:distill', { projectId, resourceId, type, force })
  if (res.ok) {
    toast.success(tGlobal('distill.ok'))
    return
  }
  if (res.mismatch) {
    const detected = res.detectedType === 'story' ? tGlobal('distill.story') : tGlobal('distill.other')
    const reasons = res.reasons?.length ? `\n${res.reasons.join('；')}` : ''
    toast.error(tGlobal('distill.mismatch', { type: detected, reasons }))
    return
  }
  if (res.uncertain) {
    const detected = res.detectedType === 'story' ? tGlobal('distill.story') : tGlobal('distill.other')
    const chosen = type === 'story' ? tGlobal('distill.story') : tGlobal('distill.other')
    const reasons = res.reasons?.length ? `（${res.reasons.join('；')}）` : ''
    const proceed = await confirmDialog(tGlobal('distill.uncertain', { type: detected, chosen, reasons }))
    if (proceed) {
      await doDistill(projectId, resourceId, type, true)
    }
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
