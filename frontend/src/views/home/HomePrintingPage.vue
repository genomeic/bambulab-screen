<template>
  <div class="homepage homepage-running">
    <div ref="taskCardRef" class="card task-card" :style="{ width: `${taskCardWidth}px` }">
      <!-- <span v-if="isRecording" class="recording"><i-material-symbols-circle />REC</span> -->
      <div v-if="amsList.length" class="task-ams" @click="router.replace({ name: ROUTE_NAME.FILAMENT })">
        <template v-for="ams in amsList" :key="ams.id">
          <span class="ams-label">AMS-{{ amsPrefix(ams.id) }}</span>
          <AMSIndicator :ams="ams" />
        </template>
      </div>
      <span class="files" @click="router.push({ name: ROUTE_NAME.HOME_FILES })">{{ t('file_link') }}</span>
      <img v-if="taskThumbnail" class="task-thumbnail" :src="taskThumbnail" />
      <img v-else class="task-thumbnail task-loading-thumbnail" :src="loadingThumbnail" />
      <span class="task-name">{{ taskName }}</span>
    </div>

    <div class="card printer-card">
      <div class="printer-content">
        <img :src="printerImage" />
        <span class="heatbed-temp" :style="{ color: nozzleIsHeating ? 'orange' : undefined }">
          <img class="temp-icon" :src="bedOffIcon" />
          {{ heatbedTemp }}
          <span class="temp-unit">°C</span>
        </span>
        <span class="wifi-signal"><img :src="wifiIcon" /></span>
        <DeviceListPopup v-model:show="showDeviceListPopup" />
      </div>

      <div class="nozzle-content">
        <img :src="nozzleThumbnail" />
        <span class="nozzle-temp" :style="{ color: nozzleIsHeating ? 'orange' : undefined }">
          <img class="temp-icon" :src="nozzleOffIcon" />
          {{ nozzleTemp }}
          <span class="temp-unit">°C</span>
        </span>
      </div>
    </div>

    <div class="card progress-card">
      <div class="progress-card-left">
        <div class="progress-labels">
          <span>{{ printPercent }}%</span>
          <span>{{ printInfo }}</span>
        </div>
        <van-progress :percentage="printPercent" :show-pivot="false" />
        <span class="progress-status">{{ printStateLabel }}</span>
      </div>

      <div class="progress-card-buttons">
        <ControlButton :icon="skipIcon" :label="t('action_skip')" font-size="10px" :disabled="!showPrintActions" @click="handleSkip" />
        <ControlButton
          v-if="!isPaused"
          :icon="pauseIcon"
          :label="t('action_pause')"
          font-size="10px"
          :disabled="!showPrintActions"
          @click="handlePause"
        />
        <ControlButton
          v-else
          :icon="resumeIcon"
          :label="t('action_resume')"
          font-size="10px"
          :disabled="!showPrintActions"
          @click="handleResume"
        />
        <ControlButton :icon="stopIcon" :label="t('action_stop')" font-size="10px" :disabled="!showPrintActions" @click="handleStop" />
      </div>
    </div>

    <div class="card hms" @click="router.replace({ name: ROUTE_NAME.MESSAGE })">
      <van-badge :content="device && device.hms.length > 0 ? device.hms.length : undefined" :offset="[-2, 6]">
        <img :src="hmsIcon(!(device && device.hms.length > 0))" />
      </van-badge>
      {{ t('assistant') }}
    </div>

    <van-popup v-model:show="showSkipPopup" position="bottom" round :style="{ maxHeight: '85%' }">
      <div class="skip-popup">
        <div class="skip-title">{{ t('skip_objects_title') }}</div>
        <div class="skip-hint">{{ t('skip_objects_hint') }}</div>
        <div v-if="!skipMap.items.length" class="skip-empty">{{ t('skip_objects_empty') }}</div>
        <template v-else>
          <svg
            class="skip-map"
            :viewBox="`0 0 ${skipMap.width} ${skipMap.height}`"
            preserveAspectRatio="xMidYMid meet"
          >
            <rect
              v-for="obj in skipMap.items"
              :key="obj.id"
              :x="obj.x" :y="obj.y" :width="obj.w" :height="obj.h"
              :class="['skip-obj', { selected: selectedObjIds.has(obj.id), skipped: obj.skipped }]"
              rx="2"
              @click.stop="toggleObject(obj.id)"
            />
            <text
              v-for="obj in skipMap.items"
              :key="`t${obj.id}`"
              :x="obj.labelX" :y="obj.labelY"
              :class="['skip-obj-label', { skipped: obj.skipped }]"
              text-anchor="middle"
            >{{ obj.id }}</text>
          </svg>
          <div class="skip-list">
            <div
              v-for="obj in skipMap.items"
              :key="`l${obj.id}`"
              :class="['skip-item', { selected: selectedObjIds.has(obj.id), skipped: obj.skipped }]"
              @click="toggleObject(obj.id)"
            >
              <span>{{ t('skip_object_label', { n: obj.id }) }}</span>
              <span v-if="obj.skipped" class="skipped-tag">{{ t('skip_object_skipped') }}</span>
            </div>
          </div>
          <van-button type="danger" block :disabled="!selectedObjIds.size" :loading="skipConfirming" @click="confirmSkip">
            {{ t('skip_objects_confirm') }}
          </van-button>
        </template>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { FTPSClient } from '@bambulab-p1screen/printer-api'
import { CLOUD_BASE_URLS, client, createApiUrl, createFtpUrl, getPrinterConnectionMode } from '../../printer'
import { getCurrentDevice } from '../../utils/device'
import { usePrintStatus } from '../../composables/usePrintStatus'
import { unzipSync } from 'fflate'
import { ROUTE_NAME } from '../../router/routes'
import { usePrinterStore } from '../../stores/printer'
import { getCachedThumbnailUrl, setCachedThumbnailUrl } from '../../utils/thumbnail'
import { hmsIcon, wifiSignalIcon } from '../../utils/icon'
import { getCloudUser } from '../../utils/user'
import { amsPrefix } from '../../utils/ams'
import AMSIndicator from '../../components/AMSIndicator.vue'

import skipIcon from '../../assets/images/print_control_partskip.svg'
import pauseIcon from '../../assets/images/print_control_pause.svg'
import resumeIcon from '../../assets/images/print_control_resume.svg'
import stopIcon from '../../assets/images/print_control_stop.svg'
import loadingThumbnail from '../../assets/images/placeholder_image_dark.svg'
import brokenThumbnail from '../../assets/images/ic_file_broken_dark.svg'
import { printerThumbnail, nozzleIndicatorImage } from '../../utils/printerArt'
import nozzleOffIcon from '../../assets/images/monitor_nozzle_temp.svg'
import bedOffIcon from '../../assets/images/monitor_bed_temp.svg'
import nozzleNormalThumbnail from '../../assets/images/indicator_nozzle_23.png'
import nozzleHeatingThumbnail from '../../assets/images/indicator_heat_nozzle_23.png'
import nozzleCoolingThumbnail from '../../assets/images/indicator_nozzle_cooling_23.png'
import nozzleOcclusionThumbnail from '../../assets/images/indicator_occlusion_filament_23.png'
import { tintFilamentImage } from '../../utils/filamentTint'
import { isCloudPrintBlocked } from '../../utils/printGate'

const { t } = useI18n()
const router = useRouter()
const { device, model, modules } = usePrinterStore()

const printerImage = computed(() => printerThumbnail(model.value))

// Same AMS strip as the idle home page, so filament slots stay visible on the
// printing page too (e.g. while a job is FINISH/PAUSE and the printer sits there).
const amsList = computed(() => device.value?.ams?.ams?.slice(0, 2) ?? [])

const taskCardRef = ref<HTMLElement | null>(null)
const taskCardWidth = ref(0)
const wifiIcon = ref(wifiSignalIcon())
const nozzleThumbnail = ref(nozzleNormalThumbnail)
const showDeviceListPopup = ref(false)
const { isPaused, printInfo, printPercent, printStateLabel, showPrintActions } = usePrintStatus(device)

const handleResize = () => {
  if (taskCardRef.value) {
    taskCardWidth.value = taskCardRef.value.clientHeight
  }
}

const getNozzleThumbnail = () => {
  // H2/A1 series have their own toolhead artwork (no state variants available)
  const modelArt = nozzleIndicatorImage(model.value, device.value?.nozzle_diameter)
  if (modelArt) return modelArt
  if (!device.value) return nozzleNormalThumbnail
  // Only depict filament in the extruder while a print is actually running
  // AND a filament is still loaded. stg_cur can linger at the printing stage
  // after a failed/finished job or an unload, which used to leave the green
  // strand visible on idle/failed printers.
  const state = (device.value.gcode_state ?? '').toUpperCase()
  const trayNow = Number(device.value.ams?.tray_now ?? -1)
  const filamentLoaded = trayNow !== 255 && trayNow !== -1
  if (state === 'RUNNING' && filamentLoaded) return nozzleOcclusionThumbnail
  if (device.value.nozzle_temper > 50) {
    return device.value.nozzle_target_temper === 0 ? nozzleCoolingThumbnail : nozzleHeatingThumbnail
  }
  return nozzleNormalThumbnail
}

/** tray_color ("RRGGBBAA") of the filament currently loaded in the extruder. */
const currentFilamentColor = () => {
  const ams = device.value?.ams
  if (!ams) return ''
  const trayNow = Number(ams.tray_now ?? -1)
  if (trayNow === -1 || trayNow === 255) return ''
  if (trayNow === 254) return String(device.value?.vt_tray?.tray_color ?? '')
  for (const unit of ams.ams ?? []) {
    const amsId = Number(unit.id)
    for (const tray of unit.tray ?? []) {
      if (amsId * 4 + Number(tray.id) === trayNow) return String(tray.tray_color ?? '')
    }
  }
  return ''
}

// The artwork ships with a fixed green strand; repaint it with the loaded
// filament colour. Only the "filament in extruder" image has a strand.
let nozzleRequestToken = 0
const refreshNozzleThumbnail = async () => {
  const token = ++nozzleRequestToken
  const base = getNozzleThumbnail()
  const color = base === nozzleOcclusionThumbnail ? currentFilamentColor() : ''
  if (!color) {
    if (token === nozzleRequestToken) nozzleThumbnail.value = base
    return
  }
  const tinted = await tintFilamentImage(base, color)
  if (token === nozzleRequestToken) nozzleThumbnail.value = tinted
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
  handleResize()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
})

watch(
  [device, model],
  () => {
    wifiIcon.value = wifiSignalIcon()
    refreshNozzleThumbnail()
    nextTick(() => handleResize())
  },
  { immediate: true }
)

const thumbnailUrl = ref('')
const loadCloudThumbnail = async () => {
  const cacheKey = device.value?.task_id || ''
  if (cacheKey) {
    const cachedUrl = getCachedThumbnailUrl(cacheKey)
    if (cachedUrl) {
      thumbnailUrl.value = cachedUrl
      return
    }
  }

  try {
    const user = getCloudUser()
    if (!user) {
      throw new Error('cloud user is not configured')
    }

    console.log('[HomePrintingPage] fetching cover image url from bambu cloud')
    const serial = client.connectOptions?.serial
    if (!serial) {
      throw new Error('no printer serial')
    }

    // The task list is shared across all of the account's devices and the
    // unparameterized request only returns the first page, which may be filled
    // entirely by other printers. Page through until this device shows up.
    const host = CLOUD_BASE_URLS[user.region]
    const PAGE_SIZE = 40
    let task: Record<string, any> | undefined
    for (let offset = 0; offset < 400 && !task; offset += PAGE_SIZE) {
      const res = await fetch(
        `${createApiUrl(host)}/v1/user-service/my/tasks?limit=${PAGE_SIZE}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${user.accessToken}` } }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const hits: Array<Record<string, any>> = Array.isArray(data?.hits) ? data.hits : []
      if (!hits.length) break

      const deviceTasks = hits.filter(item => item.deviceId === serial)
      if (deviceTasks.length) {
        // Prefer the entry matching the printer's current task, falling back
        // to the device's newest task.
        const subtaskId = String(device.value?.subtask_id ?? '')
        const taskId = String(device.value?.task_id ?? '')
        task =
          (subtaskId && subtaskId !== '0'
            ? deviceTasks.find(item => String(item.instanceId ?? '') === subtaskId)
            : undefined) ||
          (taskId && taskId !== '0'
            ? deviceTasks.find(item => String(item.id ?? '') === taskId)
            : undefined) ||
          deviceTasks[0]
        break
      }
      if (hits.length < PAGE_SIZE) break
    }

    const coverUrl = task?.cover
    if (!coverUrl) {
      throw new Error('no cover image found in cloud task list')
    }

    if (cacheKey) {
      setCachedThumbnailUrl(cacheKey, coverUrl)
    }
    thumbnailUrl.value = coverUrl
    console.log('[HomePrintingPage] set cloud cover image url:', coverUrl)
  } catch (error) {
    console.error('[HomePrintingPage] loadCloudThumbnail error:', error)
  }
}

/**
 * Downloads the current print job's .3mf from the local printer, mirroring
 * ha-bambulab's candidate filename discovery:
 * - subtask_name first (`name.3mf`, then `name.gcode.3mf`)
 * - gcode_file second
 * - fallback: first .3mf found in /cache or / when there is no subtask name
 */
const downloadCurrent3mf = async (ftp: FTPSClient) => {
  const candidates: string[] = []
  const push = (name?: string) => {
    if (!name) return
    if (name.endsWith('.3mf')) {
      candidates.push(name)
    } else {
      candidates.push(`${name}.3mf`)
      candidates.push(`${name}.gcode.3mf`)
    }
  }
  push(device.value?.subtask_name)
  if (device.value?.gcode_file && device.value.gcode_file !== device.value?.subtask_name) {
    push(device.value.gcode_file)
  }

  for (const filename of candidates) {
    for (const searchPath of ['/cache/', '/']) {
      const remotePath = `${searchPath}${filename.replace(/^\//, '')}`
      try {
        return await ftp.downloadContent(remotePath)
      } catch (err: any) {
        if (err?.code !== 550) {
          console.warn(`[HomePrintingPage] failed to download ${remotePath}: ${err?.message ?? err}`)
        }
      }
    }
  }

  if (!device.value?.subtask_name) {
    for (const searchPath of ['/cache/', '/']) {
      try {
        const files = await ftp.list(searchPath)
        const modelFile = files.find(file => file.name.endsWith('.3mf'))
        if (modelFile) {
          return await ftp.downloadContent(`${searchPath}${modelFile.name}`)
        }
      } catch (err: any) {
        console.warn(`[HomePrintingPage] failed to list ${searchPath}: ${err?.message ?? err}`)
      }
    }
  }

  throw new Error('No .3mf file found on printer')
}

/**
 * Reads the plate index from the 3mf's slice_info.config, mirroring
 * ha-bambulab: find `<plate><metadata key="index" value="N"/></plate>`.
 */
const parsePlateIndex = (xmlText: string): string | undefined => {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
    return doc.querySelector('plate metadata[key="index"]')?.getAttribute('value') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Loads the current project thumbnail from the printer's local .3mf file over
 * the WebSocket FTP tunnel (LAN mode only).
 */
const loadLocalThumbnail = async () => {
  const cacheKey = device.value?.task_id || ''
  if (cacheKey) {
    const cachedUrl = getCachedThumbnailUrl(cacheKey)
    if (cachedUrl) {
      thumbnailUrl.value = cachedUrl
      return
    }
  }

  const currentDevice = getCurrentDevice()
  const ip = currentDevice?.ip ?? ''
  const code = currentDevice?.code ?? ''
  if (!ip || !code) return

  const ftp = new FTPSClient()
  try {
    console.log('[HomePrintingPage] fetching project 3mf from local')
    await ftp.connect(createFtpUrl(ip))
    await ftp.login('bblp', code)

    const data = await downloadCurrent3mf(ftp)
    const unzipped = unzipSync(data)

    const sliceInfo = unzipped['Metadata/slice_info.config']
    const plateIndex = sliceInfo
      ? parsePlateIndex(new TextDecoder().decode(sliceInfo))
      : undefined
    const thumbnailData = plateIndex ? unzipped[`Metadata/plate_${plateIndex}.png`] : undefined

    const thumbnailUrlValue = thumbnailData
      ? `data:image/png;base64,${btoa(String.fromCharCode(...thumbnailData))}`
      : ''
    if (cacheKey && thumbnailUrlValue) {
      setCachedThumbnailUrl(cacheKey, thumbnailUrlValue)
    }
    thumbnailUrl.value = thumbnailUrlValue

    console.log('[HomePrintingPage] extracted project thumbnail from .3mf')
  } catch (error) {
    console.error('[HomePrintingPage] loadLocalThumbnail error:', error)
    thumbnailUrl.value = brokenThumbnail
  } finally {
    ftp.close()
  }
}

if (getPrinterConnectionMode() === 'cloud') {
  loadCloudThumbnail()
} else {
  loadLocalThumbnail()
}

const taskThumbnail = computed(() => thumbnailUrl.value || '')
const taskName = computed(() => device.value?.subtask_name || '')
const nozzleTemp = computed(() => Math.floor(device.value?.nozzle_temper ?? 0))
const heatbedTemp = computed(() => Math.floor(device.value?.bed_temper ?? 0))
const nozzleIsHeating = computed(() => (device.value?.nozzle_target_temper ?? 0) - (device.value?.nozzle_temper ?? 0) > 2)

// --- Skip objects -----------------------------------------------------------
// The printer reports objects_list while a print runs; skipping sends the
// selected obj ids via print.skip_objects.

type PrintObject = { obj_id: number, boundary: number[], flag?: string }

const showSkipPopup = ref(false)
const selectedObjIds = ref<Set<number>>(new Set())
const locallySkippedIds = ref<Set<number>>(new Set())
const skipConfirming = ref(false)

const objectsList = computed<PrintObject[]>(() => {
  const list = (device.value as Record<string, unknown> | undefined)?.objects_list
  if (!Array.isArray(list)) return []
  return list.filter((item): item is PrintObject =>
    !!item && typeof item === 'object' && Number.isFinite(Number((item as PrintObject).obj_id)))
})

const isObjSkipped = (obj: PrintObject) =>
  locallySkippedIds.value.has(Number(obj.obj_id)) || String(obj.flag ?? '') === 'skipped'

const handleSkip = () => {
  if (isCloudPrintBlocked(modules.value)) {
    showConfirmDialog({
      title: t('skip_objects_title'),
      message: t('cloud_print_blocked_hint'),
      showCancelButton: false,
      confirmButtonText: t('confirm'),
    })
    return
  }
  if (!objectsList.value.length) {
    showToast({ message: t('skip_objects_empty'), position: 'bottom' })
    return
  }
  // drop stale selections for objects that no longer exist
  const alive = new Set(objectsList.value.map(item => Number(item.obj_id)))
  selectedObjIds.value = new Set([...selectedObjIds.value].filter(id => alive.has(id)))
  showSkipPopup.value = true
}

const toggleObject = (id: number) => {
  if (locallySkippedIds.value.has(id)) return
  const next = new Set(selectedObjIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedObjIds.value = next
}

/** Normalises the printer's boundary boxes ([x0,y0,x1,y1] in mm, y up) into
 *  SVG coordinates (y down) with a small margin, so the user can tell which
 *  physical object each id refers to. */
const skipMap = computed(() => {
  const boxes = objectsList.value.map(item => {
    const b = Array.isArray(item.boundary) ? item.boundary.map(Number) : []
    return {
      id: Number(item.obj_id),
      skipped: isObjSkipped(item),
      x0: b[0], y0: b[1], x1: Number.isFinite(b[2]) ? b[2] : b[0], y1: Number.isFinite(b[3]) ? b[3] : b[1],
    }
  }).filter(b => [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite))
  if (!boxes.length) return { items: [] as Array<{ id: number, x: number, y: number, w: number, h: number, labelX: number, labelY: number, skipped: boolean }>, width: 100, height: 60 }

  const pad = 5
  const minX = Math.min(...boxes.map(b => Math.min(b.x0, b.x1))) - pad
  const maxX = Math.max(...boxes.map(b => Math.max(b.x0, b.x1))) + pad
  const minY = Math.min(...boxes.map(b => Math.min(b.y0, b.y1))) - pad
  const maxY = Math.max(...boxes.map(b => Math.max(b.y0, b.y1))) + pad
  const width = Math.max(maxX - minX, 1)
  const height = Math.max(maxY - minY, 1)

  const items = boxes.map(b => {
    const x = Math.min(b.x0, b.x1) - minX
    const y = maxY - Math.max(b.y0, b.y1)
    const w = Math.max(Math.abs(b.x1 - b.x0), 1)
    const h = Math.max(Math.abs(b.y1 - b.y0), 1)
    return { id: b.id, x, y, w, h, labelX: x + w / 2, labelY: y + h / 2 + 3, skipped: b.skipped }
  })
  return { items, width, height }
})

const confirmSkip = async () => {
  const ids = [...selectedObjIds.value]
  if (!ids.length || skipConfirming.value) return
  skipConfirming.value = true
  try {
    await client.skipObjects(ids)
    ids.forEach(id => locallySkippedIds.value.add(id))
    selectedObjIds.value = new Set()
    showToast({ message: t('skip_objects_sent'), position: 'bottom' })
    showSkipPopup.value = false
  } catch (err: any) {
    showToast({ message: err?.message || 'error', position: 'bottom' })
  } finally {
    skipConfirming.value = false
  }
}

const handleResume = () => {
  console.log('[Controls] resume')
  client.setResume()
}

const handlePause = () => {
  console.log('[Controls] pause')
  client.setPause()
}

const handleStop = () => {
  console.log('[Controls] stop')
  client.setStop()
}
</script>

<style scoped>
.homepage {
  display: grid;
  height: 100%;
  gap: 10px;
  font-size: 14px;
}

.homepage-running {
  grid-template-columns: auto 1fr;
  grid-template-rows: 1fr auto;
}

.task-card {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  /* row 1: AMS strip (auto width, never clipped) + 文件> link (rest, right-aligned) */
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 25px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

/* 
.recording {
  grid-column: 1;
  grid-row: 1;
  justify-self: start;
  margin-left: 8px;
  padding: 1px 2px;
  font-size: 6px;
  font-weight: bold;
  border-radius: 3px;
  border: 1px solid var(--van-text-color);
  color: var(--van-text-color);
}

.recording > svg {
  font-size: 3px;
  color: var(--van-red);
  margin-right: 1px;
}
*/

.task-card .task-ams {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--van-text-color-2);
  padding-left: 12px;
  white-space: nowrap;
}

.task-card .task-ams > * {
  flex-shrink: 0;
}

.task-card .files {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  font-size: 12px;
  color: var(--van-text-color);
  padding: 0 8px;
}

.task-thumbnail {
  grid-column: 1 / span 2;
  grid-row: 2;
  width: 100%;
  object-fit: contain;
  align-self: stretch;
}

.task-loading-thumbnail {
  filter: brightness(1.1);
  width: 95%;
}

.task-name {
  grid-column: 1 / span 2;
  grid-row: 3;
  width: 100%;
  height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  text-align: left;
  align-content: center;
  padding: 0 12px;
  background-color: var(--van-background-3);
}

.printer-card {
  display: grid;
  grid-template-columns: 0.625fr 0.375fr;
}

.printer-card > div {
  position: relative;
  overflow: hidden;
  height: 100%;
}

.printer-card .temp-unit {
  font-size: 12px;
  color: var(--van-text-color-2);
}

.printer-card .temp-icon {
  top: 3px;
  position: relative;
  width: 16px;
  height: 16px;
  margin-right: 2px;
}

.printer-content > img {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90%;
  border-radius: 14px;
  object-fit: contain;
  padding: 4px;
}

.printer-card > div > span {
  display: block;
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 14px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 14px;
  width: max-content;
  padding: 0 8px;
  line-height: 20px;
}

.heatbed-temp {
  left: 40%;
  top: 60%;
}

.printer-card .wifi-signal {
  left: 25%;
  top: 25%;
  border-radius: 50%;
  width: 34px;
  height: 34px;
  padding: 8px !important;
}

.printer-card .wifi-signal img {
  width: 18px;
  height: 18px;
}

.nozzle-content::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10%;
  height: 80%;
  width: 0.5px;
  background: var(--van-background-5);
}

.nozzle-content > img {
  position: absolute;
  top: 45%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: 90%;
  max-height: 82%;
}

.nozzle-temp {
  top: 75%;
  left: 50%;
}

.progress-card {
  grid-column: 1 / 3;
  grid-row: 2;
  display: grid;
  grid-template-columns: 1fr auto;
  font-size: 12px;
  gap: 8px;
  padding: 8px;
  margin-right: calc(56px + 10px);
}

.progress-card-left {
  display: grid;
  padding: 0 4px;
}

.progress-card-buttons {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  margin-right: -8px;
}

.progress-labels {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}

.progress-labels > span:first-child {
  font-weight: 500;
  font-size: 16px;
}

.van-progress {
  margin: 4px 0;
  height: 6px;
}

.progress-status {
  font-size: 12px;
  height: 22px;
  color: var(--van-text-color-2);
}

.progress-card-buttons > .control-button {
  width: 56px;
  height: 56px;
  margin-right: 8px;
  border-radius: 8px;
}

:deep(.progress-card-buttons > .control-button > img) {
  width: 20px;
  height: 20px;
  margin-bottom: 2px;
}

.homepage-running > .card.hms {
  grid-column: 2;
  grid-row: 2;
  justify-self: end;
  width: 56px;
  background-color: var(--van-background-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}

.homepage-running > .card.hms img {
  width: 28px;
  height: 28px;
}

@media (orientation: portrait) {
  .homepage {
    grid-template-columns: 1fr;
    grid-template-rows: 250px 250px auto auto;
    height: auto;
  }

  .task-card {
    grid-column: 1;
    grid-row: 1;
    height: 250px;
    width: 100% !important;
  }

  .printer-card {
    grid-column: 1;
    grid-row: 2;
    width: 100%;
    height: 250px;
  }

  .progress-card {
    grid-column: 1;
    grid-row: 3;
    margin-right: 0;
    grid-template-columns: 1fr;
    grid-template-rows: auto auto;
  }

  .progress-card-buttons {
    justify-content: flex-start;
  }

  .homepage-running > .card.hms {
    display: none;
  }
}

.skip-popup {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  max-height: 85vh;
  overflow-y: auto;
}

.skip-title {
  font-size: 16px;
  font-weight: 600;
  text-align: center;
}

.skip-hint {
  font-size: 12px;
  color: #999;
  text-align: center;
}

.skip-empty {
  padding: 32px 0;
  text-align: center;
  color: #999;
  font-size: 14px;
}

.skip-map {
  width: 100%;
  max-height: 38vh;
  background: #1e1e1e;
  border-radius: 8px;
}

.skip-obj {
  fill: rgba(255, 255, 255, 0.12);
  stroke: #9e9e9e;
  stroke-width: 1;
  cursor: pointer;
}

.skip-obj.selected {
  fill: rgba(238, 61, 61, 0.45);
  stroke: #ee3d3d;
}

.skip-obj.skipped {
  fill: rgba(255, 255, 255, 0.04);
  stroke: #4a4a4a;
  stroke-dasharray: 3 2;
  cursor: default;
}

.skip-obj-label {
  fill: #eee;
  font-size: 12px;
  pointer-events: none;
}

.skip-obj-label.skipped {
  fill: #666;
}

.skip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.skip-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 13px;
  cursor: pointer;
}

.skip-item.selected {
  background: rgba(238, 61, 61, 0.35);
}

.skip-item.skipped {
  opacity: 0.45;
  cursor: default;
}

.skipped-tag {
  font-size: 11px;
  color: #999;
}
</style>
