import { api } from './api'
import { toast } from '../store/toast.store'
import { chooseOption, confirmDialog } from '../store/dialog.store'
import { useAppStore } from '../store/app.store'

export async function runDistill(projectId: string, resourceId: string): Promise<void> {
  try {
    const type = await chooseOption('选择文件所属类型', [
      { value: 'story', label: '故事' },
      { value: 'other', label: '其他' }
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
    toast.success('蒸馏完成')
    return
  }
  if (res.mismatch) {
    const detected = res.detectedType === 'story' ? '故事' : '其他'
    const reasons = res.reasons?.length ? `\n理由：${res.reasons.join('；')}` : ''
    toast.error(`类型不符：该文件被判定为「${detected}」，请重新选择。${reasons}`)
    return
  }
  if (res.uncertain) {
    const detected = res.detectedType === 'story' ? '故事' : '其他'
    const reasons = res.reasons?.length ? `（${res.reasons.join('；')}）` : ''
    const proceed = await confirmDialog(
      `无法自动判定该文件类型${reasons}，倾向「${detected}」。\n仍按所选类型「${type === 'story' ? '故事' : '其他'}」生成摘要吗？`
    )
    if (proceed) {
      await doDistill(projectId, resourceId, type, true)
    }
    return
  }
  toast.error(res.error ?? '蒸馏失败')
}

export async function runUndistill(projectId: string, resourceId: string): Promise<void> {
  try {
    if (!(await confirmDialog('取消蒸馏？该资源摘要将被移除。'))) return
    await api.invoke('resource:undistill', { projectId, resourceId })
    toast.success('已取消蒸馏')
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
      toast.success(`标题已更新：${res.title}`)
      await refreshWorkspace()
      bumpSummary()
    } else {
      toast.error(res.error ?? '标题生成失败')
    }
  } catch (err) {
    toast.error((err as Error).message)
  } finally {
    setTitleGenerating(chatId, false)
  }
}
