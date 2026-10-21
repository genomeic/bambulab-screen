import { ref } from 'vue'
import { showToast } from 'vant'
import { i18n } from '../i18n'
import { CLOUD_BASE_URLS, createApiUrl, client } from '../printer'
import { getCurrentDevice } from './device'
import { getCloudUser } from './user'

/**
 * Bumped whenever manual spool data changes so components can re-read the
 * (non-reactive) localStorage values in computed properties.
 */
export const spoolStoreVersion = ref(0)

/**
 * Manual spool bookkeeping, ported from a community build of P1Screen.
 *
 * Each manually-entered spool is stored in localStorage keyed by
 * `${serial}:${slotIndex}` where slotIndex follows the printer's `tray_now`
 * convention (amsId * 4 + trayId, or 254 for the external spool).
 */

export type ManualSpool = {
  /** full spool weight in grams, when known */
  total?: number
  /** remaining filament in grams */
  remaining?: number
  updated: number
}

const STORAGE_KEY = 'ams_manual_spools'
const AUTO_DEDUCT_KEY = 'spool_auto_deduct'
const LAST_DEDUCT_KEY = 'spool_last_deduct'

export const spoolSlotKey = (serial: string, slotIndex: number | string) => `${serial}:${slotIndex}`

/**
 * In-memory mirror of the stored spools.
 *
 * Trays re-read this data whenever the printer pushes an update, which happens
 * dozens of times per second with several printers connected — parsing
 * localStorage synchronously that often was enough to stall the UI. The cache
 * is filled once and kept in sync by the writers below.
 */
let cache: Record<string, ManualSpool> | null = null

const readAll = (): Record<string, ManualSpool> => {
  if (cache) return cache
  let parsed: Record<string, ManualSpool> = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw)
      parsed = value && typeof value === 'object' ? value : {}
    }
  } catch (error) {
    console.warn('[manualSpool] could not read stored spools:', error)
  }
  cache = parsed
  return cache
}

const writeAll = (spools: Record<string, ManualSpool>) => {
  cache = spools
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spools))
  } catch (error) {
    console.warn('[manualSpool] could not persist spools:', error)
  }
}

/**
 * Serial of the printer the spool bookkeeping belongs to.
 *
 * `getCurrentDevice()` re-parses the whole device list from localStorage, far
 * too heavy to run once per tray per render, so its result is memoised briefly.
 */
let cachedSerial: string | null = null
let cachedSerialAt = 0

export const getSpoolSerial = (preferred?: string): string => {
  const fromClient = preferred || client.connectOptions?.serial
  if (fromClient) return fromClient
  const now = Date.now()
  if (cachedSerial !== null && now - cachedSerialAt < 1000) return cachedSerial
  cachedSerial = getCurrentDevice()?.serial ?? ''
  cachedSerialAt = now
  return cachedSerial
}

export const getManualSpool = (serial: string, slotIndex: number | string): ManualSpool | undefined => {
  return readAll()[spoolSlotKey(serial, slotIndex)]
}

export const setManualSpool = (serial: string, slotIndex: number | string, spool: Omit<ManualSpool, 'updated'>) => {
  const spools = readAll()
  const key = spoolSlotKey(serial, slotIndex)
  const cleaned: ManualSpool = { updated: Date.now() }
  if (typeof spool.total === 'number' && spool.total > 0) cleaned.total = spool.total
  if (typeof spool.remaining === 'number' && spool.remaining >= 0) cleaned.remaining = spool.remaining
  spools[key] = cleaned
  writeAll(spools)
  spoolStoreVersion.value++
}

export const clearManualSpool = (serial: string, slotIndex: number | string) => {
  const spools = readAll()
  delete spools[spoolSlotKey(serial, slotIndex)]
  writeAll(spools)
  spoolStoreVersion.value++
}

/** Remaining percentage for a slot with a fully-entered manual spool, else null. */
export const getManualRemainPercent = (serial: string, slotIndex: number | string): number | null => {
  const spool = getManualSpool(serial, slotIndex)
  if (!spool || !spool.total || spool.remaining === undefined) return null
  if (spool.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((spool.remaining / spool.total) * 100)))
}

export const isAutoDeductEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(AUTO_DEDUCT_KEY)
    return raw === null ? true : raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

export const setAutoDeductEnabled = (enabled: boolean) => {
  try {
    localStorage.setItem(AUTO_DEDUCT_KEY, enabled ? '1' : '0')
  } catch {
    // ignore
  }
}

type LastDeduct = { [serial: string]: string }

const getLastDeductedTaskId = (serial: string): string => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_DEDUCT_KEY) ?? '{}')
    return parsed?.[serial] ?? ''
  } catch {
    return ''
  }
}

const setLastDeductedTaskId = (serial: string, taskId: string) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_DEDUCT_KEY) ?? '{}')
    parsed[serial] = taskId
    localStorage.setItem(LAST_DEDUCT_KEY, JSON.stringify(parsed))
  } catch {
    // ignore
  }
}

type TaskHit = {
  id: number | string
  deviceId: string
  status: number
  weight: number
  endTime?: string
}

/**
 * Weight (grams) of the most recent completed cloud task for the device.
 * Returns null when the cloud is unreachable or the user is not signed in.
 */
const fetchLastTaskWeight = async (serial: string): Promise<number | null> => {
  const user = getCloudUser()
  if (!user) return null
  const host = CLOUD_BASE_URLS[user.region]
  const res = await fetch(`${createApiUrl(host)}/v1/user-service/my/tasks?limit=20&offset=0`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const hits: TaskHit[] = Array.isArray(data?.hits) ? data.hits : []
  // status 4 = completed (same mapping the files page uses)
  const done = hits.filter(hit => hit.deviceId === serial && Number(hit.status) === 4)
  if (!done.length) return null
  done.sort((a, b) => String(b.endTime ?? '').localeCompare(String(a.endTime ?? '')))
  const weight = Number(done[0].weight)
  return Number.isFinite(weight) && weight > 0 ? weight : null
}

const translate = (key: string, params?: Record<string, unknown>) =>
  i18n.global.t(key, params ?? {}) as string

/**
 * Called when the active print leaves RUNNING (finish/fail). Deducts this
 * print's material usage from the spool that was loaded at print time, but
 * only for slots with a manually-entered remaining amount.
 */
export const maybeAutoDeduct = async (serial: string, device: {
  gcode_state?: string
  task_id?: number | string
  ams?: { tray_now?: number | string }
}) => {
  if (!isAutoDeductEnabled()) return

  const slotIndex = Number(device.ams?.tray_now ?? -1)
  const spool = slotIndex >= 0 && slotIndex !== 255 ? getManualSpool(serial, slotIndex) : undefined
  if (!spool || spool.remaining === undefined) return // not a tracked spool — stay silent

  const taskId = String(device.task_id ?? '')
  if (taskId && getLastDeductedTaskId(serial) === taskId) return // already deducted

  let used: number | null = null
  try {
    used = await fetchLastTaskWeight(serial)
  } catch (error) {
    console.warn('[spoolDeduct] fetch task weight failed:', error)
  }
  if (used === null) {
    showToast({ message: translate('auto_deduct_no_usage'), position: 'bottom' })
    return
  }

  const remaining = Math.max(0, Math.round(spool.remaining - used))
  setManualSpool(serial, slotIndex, { total: spool.total, remaining })
  if (taskId) setLastDeductedTaskId(serial, taskId)
  spoolStoreVersion.value++

  const percent = spool.total && spool.total > 0
    ? Math.max(0, Math.min(100, Math.round((remaining / spool.total) * 100)))
    : null
  showToast({
    message: percent !== null
      ? translate('auto_deduct_done', { used, left: remaining, percent })
      : translate('auto_deduct_done_simple', { used, left: remaining }),
    position: 'bottom',
  })
}
