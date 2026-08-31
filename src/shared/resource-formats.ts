export const RESOURCE_FILE_EXTENSIONS = ['.txt', '.md', '.csv', '.doc', '.docx'] as const

export type ResourceFileExtension = (typeof RESOURCE_FILE_EXTENSIONS)[number]
export type ResourceSourceFormat = 'txt' | 'md' | 'csv' | 'doc' | 'docx'
export type ResourceContentFormat = 'plain_text' | 'markdown'

export function getResourceFileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function isSupportedResourceFile(name: string): boolean {
  return RESOURCE_FILE_EXTENSIONS.includes(getResourceFileExtension(name) as ResourceFileExtension)
}

export function getResourceSourceFormat(name: string): ResourceSourceFormat | null {
  const ext = getResourceFileExtension(name)
  return RESOURCE_FILE_EXTENSIONS.includes(ext as ResourceFileExtension)
    ? (ext.slice(1) as ResourceSourceFormat)
    : null
}

export const RESOURCE_FILE_ACCEPT = RESOURCE_FILE_EXTENSIONS.join(',')
