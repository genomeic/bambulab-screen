const THUMBNAIL_URLS_STORAGE_KEY = 'thumbnail_urls'

/**
 * Only `data:` URLs are safe to cache. Cloud cover URLs are pre-signed OSS
 * links (X-Amz-Expires=1800, 30 minutes) that turn into 403/broken images
 * once expired, so they must never be persisted — refetch the task list
 * instead, which produces a freshly signed URL.
 */
const isCacheable = (url: string) => url.startsWith('data:')

const readCache = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(THUMBNAIL_URLS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cache = parsed as Record<string, string>
    // drop entries persisted by older builds (e.g. expired signed URLs)
    return Object.fromEntries(Object.entries(cache).filter(([, url]) => isCacheable(url)))
  } catch {
    return {}
  }
}

export const getCachedThumbnailUrl = (key: string) => {
  const url = readCache()[key] ?? ''
  return isCacheable(url) ? url : ''
}

export const setCachedThumbnailUrl = (key: string, url: string) => {
  if (!isCacheable(url)) return
  try {
    const cache = readCache()
    cache[key] = url
    localStorage.setItem(THUMBNAIL_URLS_STORAGE_KEY, JSON.stringify(cache))
  } catch (error) {
    console.warn(`[thumbnail] failed to persist cache: ${error}`)
  }
}
