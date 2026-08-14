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
    const res = await api.invoke('resource:distill', { projectId, resourceId, type: type as 'story' | 'other' })
    if (res.ok) {
      toast.success('蒸馏完成')
    } else if (res.mismatch) {
      toast.error(`类型不符：该文件被判定为「${res.detectedType === 'story' ? '故事' : '其他'}」，请重新选择`)
    } else {
      toast.error(res.error ?? '蒸馏失败')
    }
  } catch (err) {
    toast.error((err as Error).message)
  }
  await useAppStore.getState().refreshWorkspace()
  useAppStore.getState().bumpSummary()
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
