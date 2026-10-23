<template>
  <BasePage :title="t('file_list')">
    <van-cell-group inset class="tl-entry">
      <van-cell
        :title="t('tl_gen_title')"
        :label="localSupported ? t('tl_gen_entry_local') : t('tl_gen_entry_cloud')"
        is-link
        center
        @click="openTimelapse"
      />
    </van-cell-group>
    <van-tabs v-model:active="activeTab" class="files-tabs">
      <van-tab :title="t('files_history')">
        <div class="history-filter">
          <van-tag :type="onlyCurrent ? 'primary' : 'default'" size="large" clickable @click="toggleFilter">
            {{ onlyCurrent ? (getCurrentDevice()?.name ?? '') : t('files_all_devices') }}
          </van-tag>
        </div>
        <van-pull-refresh :model-value="refreshing" @update:model-value="onRefresh">
          <van-list
            v-model:loading="listLoading"
            :finished="finished"
            :finished-text="tasks.length ? t('files_no_more') : ''"
            @load="loadMore"
          >
            <div v-for="task in tasks" :key="task.id" class="task-card" clickable @click="onTaskClick(task)">
              <van-image
                class="task-cover"
                fit="cover"
                radius="8"
                :src="task.cover"
              >
                <template #loading>
                  <div class="cover-loading"><van-loading type="spinner" size="18" /></div>
                </template>
                <template #error>
                  <div class="cover-loading"><van-icon name="photo-o" size="26" /></div>
                </template>
              </van-image>
              <div class="task-info">
                <div class="task-title">{{ task.designTitle || task.title }}</div>
                <div class="task-sub">{{ task.instanceTitle || task.title }}</div>
                <div class="task-meta">
                  <span class="task-device">{{ task.deviceName }}</span>
                  <span>{{ formatDate(task.startTime) }}</span>
                  <span v-if="task.weight">{{ task.weight }}g</span>
                </div>
              </div>
              <van-tag :type="statusType(task.status)" class="task-status">
                {{ statusText(task.status) }}
              </van-tag>
            </div>
            <van-empty v-if="finished && !tasks.length" :description="t('files_empty_history')" />
          </van-list>
        </van-pull-refresh>
      </van-tab>

      <van-tab :title="t('files_local')">
        <template v-if="localSupported">
          <van-pull-refresh :model-value="localRefreshing" @update:model-value="onLocalRefresh">
            <van-list
              v-model:loading="localLoading"
              :finished="localFinished"
              :finished-text="localFiles.length ? t('files_no_more') : ''"
              @load="loadLocalFiles"
            >
              <van-cell-group inset class="local-group">
                <van-cell
                  v-for="file in localFiles"
                  :key="file.path"
                  :title="file.name"
                  :label="file.label"
                  center
                  is-link
                  @click="onLocalFileClick(file)"
                />
              </van-cell-group>
              <van-empty v-if="localFinished && !localFiles.length" :description="t('files_empty_local')" />
            </van-list>
          </van-pull-refresh>
        </template>
        <van-empty v-else :description="t('files_local_lan_hint')" />
      </van-tab>

      <van-tab :title="t('files_timelapse')">
        <template v-if="localSupported">
          <van-pull-refresh :model-value="tlRefreshing" @update:model-value="onTlRefresh">
            <van-list
              v-model:loading="tlLoading"
              :finished="tlFinished"
              :finished-text="timelapseFiles.length ? t('files_no_more') : ''"
              @load="loadTimelapseFiles"
            >
              <van-cell-group inset class="local-group">
                <van-cell
                  v-for="file in timelapseFiles"
                  :key="file.path"
                  :title="file.name"
                  :label="file.label"
                  center
                  is-link
                  :disabled="tlDownloading"
                  @click="onTimelapseClick(file)"
                />
              </van-cell-group>
              <van-empty v-if="tlFinished && !timelapseFiles.length">
                <template #description>
                  <div>{{ t('files_timelapse_empty') }}</div>
                  <div class="tl-empty-desc">{{ t('files_timelapse_empty_desc') }}</div>
                </template>
              </van-empty>
            </van-list>
          </van-pull-refresh>
        </template>
        <van-empty v-else :description="t('files_local_lan_hint')" />
      </van-tab>
    </van-tabs>
    <van-action-sheet
      v-model:show="actionSheetShow"
      :actions="actionSheetActions"
      :cancel-text="t('cancel')"
      close-on-click-action
      @select="onActionSelect"
    />
  </BasePage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { showConfirmDialog, showToast } from 'vant'
import { FTPSClient, type FTPFileInfo } from '@bambulab-p1screen/printer-api'
import { client } from '../../printer'
import { CLOUD_BASE_URLS, createApiUrl, createFtpUrl } from '../../printer'
import { getCloudUser } from '../../utils/user'
import { getCurrentDevice } from '../../utils/device'
import { isCloudPrintBlocked } from '../../utils/printGate'
import { usePrinterStore } from '../../stores/printer'
import { useRouter } from 'vue-router'
import { ROUTE_NAME } from '../../router/routes'
import BasePage from '../../components/BasePage.vue'

const { t } = useI18n()
const { device, modules } = usePrinterStore()
const router = useRouter()

type CloudTask = {
  id: number
  designTitle: string
  title: string
  instanceTitle: string
  instanceId: number
  cover: string
  status: number
  startTime: string
  endTime: string
  weight: number
  profileId: number
  plateIndex: number
  deviceId: string
  deviceName: string
  bedType: string
  useAms: boolean
}

const activeTab = ref(0)
const tasks = ref<CloudTask[]>([])
const actionFile = ref<{ name: string; path: string } | null>(null)
const actionSheetShow = ref(false)
const actionSheetActions = computed(() => [
  { name: t('tl_gen_action_print') },
  { name: t('tl_gen_action') },
])
const listLoading = ref(false)
const finished = ref(false)
const refreshing = ref(false)
const offset = ref(0)
const PAGE_SIZE = 20
const onlyCurrent = ref(true)

const localFiles = ref<{ name: string; path: string; label: string }[]>([])
const localLoading = ref(false)
const localFinished = ref(false)
const localRefreshing = ref(false)

const timelapseFiles = ref<{ name: string; path: string; label: string }[]>([])
const tlLoading = ref(false)
const tlFinished = ref(false)
const tlRefreshing = ref(false)
const tlDownloading = ref(false)

const timelapseDefault = () => localStorage.getItem('print_timelapse_default') === '1'

const currentSerial = computed(() => client.connectOptions?.serial ?? '')

const isPrinting = computed(() => device.value?.gcode_state === 'RUNNING')

const loadMore = async () => {
  if (finished.value) return
  try {
    const user = getCloudUser()
    if (!user) {
      finished.value = true
      return
    }
    const host = CLOUD_BASE_URLS[user.region]
    const res = await fetch(
      `${createApiUrl(host)}/v1/user-service/my/tasks?limit=${PAGE_SIZE}&offset=${offset.value}`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const hits: CloudTask[] = Array.isArray(data?.hits) ? data.hits : []
    const filtered = onlyCurrent.value && currentSerial.value
      ? hits.filter(item => item.deviceId === currentSerial.value)
      : hits
    // Server-side pages are not device-filtered; a page may yield nothing
    // after filtering while more pages remain.
    tasks.value.push(...filtered)
    offset.value += PAGE_SIZE
    if (hits.length < PAGE_SIZE) finished.value = true
  } catch (err: any) {
    finished.value = true
    showToast(err?.message ?? 'error')
  } finally {
    listLoading.value = false
    refreshing.value = false
  }
}

const onRefresh = (value: boolean) => {
  refreshing.value = value
  tasks.value = []
  offset.value = 0
  finished.value = false
  listLoading.value = true
  loadMore()
}

onMounted(() => {
  // van-list's mount-time visibility check can be missed inside tab panels;
  // kick off the first page explicitly.
  listLoading.value = true
  loadMore()
})

watch(currentSerial, (val, old) => {
  // MQTT just connected and the active device became known; reload the
  // device-filtered list if the first load ran without it.
  if (val && !old && !tasks.value.length && !finished.value) {
    offset.value = 0
    finished.value = false
    listLoading.value = true
    loadMore()
  }
})

const toggleFilter = () => {
  onlyCurrent.value = !onlyCurrent.value
  onRefresh(true)
}

// Firmware 01.08+ verifies command signatures and rejects third-party print
// commands with HMS_0500-0500-0001-0007 ("MQTT 命令校验失败…"). The stock
// message tells users to update Studio/Handy, which is misleading for this
// app — show actionable guidance instead.
const showReprintError = (err: any) => {
  const msg = String(err?.message ?? '')
  if (/校验失败|verification failed|0500-0500-0001-0007/i.test(msg)) {
    showReprintBlockedDialog()
  } else {
    showToast(msg || 'error')
  }
}

// The firmware usually does NOT ack the command with a failure — it pushes an
// HMS message (0500-0500-0001-0007) through the report channel instead, so the
// request promise stays pending. Watch for that HMS arriving shortly after a
// reprint attempt and surface the same guidance.
const REPRINT_HMS_CODE = '0500-0500-0001-0007'
const reprintAttemptAt = ref(0)

const hmsCode = (m: any) =>
  `${(m.attr >> 16).toString(16).padStart(4, '0')}-${(m.attr & 0xffff).toString(16).padStart(4, '0')}-${(m.code >> 16).toString(16).padStart(4, '0')}-${(m.code & 0xffff).toString(16).padStart(4, '0')}`.toUpperCase()

const seenHms = computed(() =>
  (device.value?.hms ?? []).map((m: any) => `${m.attr}-${m.code}`).join('|')
)

const maybeShowBlocked = () => {
  if (!reprintAttemptAt.value) return
  if (Date.now() - reprintAttemptAt.value > 60000) {
    reprintAttemptAt.value = 0
    return
  }
  const hit = (device.value?.hms ?? []).some((m: any) => hmsCode(m) === REPRINT_HMS_CODE)
  if (!hit) return
  reprintAttemptAt.value = 0
  showReprintBlockedDialog()
}

watch(seenHms, maybeShowBlocked)

const markReprintAttempt = () => {
  reprintAttemptAt.value = Date.now()
  // The HMS may already be in the device's message list from an earlier
  // rejection (array unchanged -> watcher won't fire); check once after a
  // short delay in addition to watching for new arrivals.
  setTimeout(maybeShowBlocked, 4000)
}

const showReprintBlockedDialog = () => {
  showConfirmDialog({
    title: t('files_reprint_blocked_title'),
    message: t('files_reprint_blocked'),
    showCancelButton: false,
    confirmButtonText: t('confirm'),
  })
}

const onTaskClick = (task: CloudTask) => {
  if (isCloudPrintBlocked(modules.value)) {
    showReprintBlockedDialog()
    return
  }
  showConfirmDialog({
    title: t('files_reprint'),
    message: isPrinting.value
      ? t('toolbox_warn_printing')
      : `${t('files_reprint_confirm')}\n${task.designTitle || task.title}`,
    showCancelButton: !isPrinting.value,
    cancelButtonText: t('cancel'),
    confirmButtonText: t('confirm'),
  })
    .then(async () => {
      try {
        markReprintAttempt()
        await client.startProject({
          param: `Metadata/plate_${task.plateIndex || 1}.gcode`,
          timelapse: timelapseDefault(),
          profileId: task.profileId,
          taskId: task.id,
          subtaskId: task.instanceId,
          useAms: task.useAms ?? true,
          bedType: task.bedType ?? 'auto',
        })
        showToast(t('files_reprint_sent'))
      } catch (err: any) {
        showReprintError(err)
      }
    })
    .catch(() => {})
}

/**
 * Printer files are read over FTP, which only needs the printer's LAN IP and
 * access code. Both are stored on the device even when the live control
 * connection runs through the cloud, so a cloud-connected printer sitting on
 * the same Wi-Fi is still readable — requiring connect === 'local' here hid
 * the entire files feature (and the timelapse entry) from cloud fleets.
 */
const localSupported = computed(() => {
  const dev = getCurrentDevice()
  return !!dev && !!dev.ip && !!dev.code
})

const loadLocalFiles = async () => {
  if (localFinished.value) return
  const dev = getCurrentDevice()
  if (!dev) {
    localFinished.value = true
    localLoading.value = false
    return
  }
  const ftp = new FTPSClient()
  try {
    await ftp.connect(createFtpUrl(dev.ip))
    await ftp.login('bblp', dev.code)
    const entries: FTPFileInfo[] = await ftp.list('/')
    localFiles.value = entries
      .filter(item => !item.isDirectory)
      .filter(item => /\.(3mf|gcode(\.3mf)?)$/i.test(item.name))
      .map(item => ({
        name: item.name,
        path: `/${item.name}`,
        label: `${(item.size / 1024 / 1024).toFixed(1)} MB · ${item.rawModifiedAt ?? ''}`,
      }))
    localFinished.value = true
  } catch (err: any) {
    localFinished.value = true
    showToast(err?.message ?? 'error')
  } finally {
    ftp.close()
    localLoading.value = false
    localRefreshing.value = false
  }
}

const loadTimelapseFiles = async () => {
  if (tlFinished.value) return
  const dev = getCurrentDevice()
  if (!dev) {
    tlFinished.value = true
    tlLoading.value = false
    return
  }
  const ftp = new FTPSClient()
  try {
    await ftp.connect(createFtpUrl(dev.ip))
    await ftp.login('bblp', dev.code)
    const entries: FTPFileInfo[] = await ftp.list('/timelapse/')
    timelapseFiles.value = entries
      .filter(item => !item.isDirectory)
      .filter(item => /\.(mp4|avi|mov)$/i.test(item.name))
      .sort((a, b) => (b.rawModifiedAt ?? '').localeCompare(a.rawModifiedAt ?? ''))
      .map(item => ({
        name: item.name,
        path: `/timelapse/${item.name}`,
        label: `${(item.size / 1024 / 1024).toFixed(1)} MB · ${item.rawModifiedAt ?? ''}`,
      }))
    tlFinished.value = true
  } catch (err: any) {
    // 550 = no timelapse directory: nothing has ever been recorded
    tlFinished.value = true
    if (err?.code !== 550) showToast(err?.message ?? 'error')
  } finally {
    ftp.close()
    tlLoading.value = false
    tlRefreshing.value = false
  }
}

const onTlRefresh = (value: boolean) => {
  tlRefreshing.value = value
  timelapseFiles.value = []
  tlFinished.value = false
  tlLoading.value = true
  loadTimelapseFiles()
}

const toBase64 = (data: Uint8Array) => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const onTimelapseClick = (file: { name: string; path: string }) => {
  if (tlDownloading.value) return
  showConfirmDialog({
    title: t('files_timelapse_download'),
    message: file.name,
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
  })
    .then(async () => {
      tlDownloading.value = true
      showToast(t('files_timelapse_downloading'))
      const dev = getCurrentDevice()
      if (!dev) return
      const ftp = new FTPSClient()
      try {
        await ftp.connect(createFtpUrl(dev.ip))
        await ftp.login('bblp', dev.code)
        const data = await ftp.downloadContent(file.path)
        const bridge = (window as any).P1ScreenBridge
        if (!bridge?.saveDownloadedFile) throw new Error('native bridge unavailable')
        const result = bridge.saveDownloadedFile(toBase64(data), file.name)
        if (typeof result === 'string' && result.startsWith('error:')) {
          throw new Error(result.slice(6))
        }
        showToast(t('files_timelapse_saved', { path: result }))
      } catch (err: any) {
        showToast(t('failed', { message: err?.message ?? '' }))
      } finally {
        ftp.close()
        tlDownloading.value = false
      }
    })
    .catch(() => {})
}

const onLocalRefresh = (value: boolean) => {
  localRefreshing.value = value
  localFiles.value = []
  localFinished.value = false
  localLoading.value = true
  loadLocalFiles()
}

/**
 * Entry point for the virtual timelapse. It used to exist only inside the
 * "local files" tab, which is hidden unless the device is connected over
 * LAN — so on a cloud-connected fleet the feature was unreachable and
 * looked like it had never been shipped.
 */
const openTimelapse = () => {
  // Straight to the page — it offers both sources (a file on the phone, or
  // one read from the printer). Pointing at the local-files tab instead hid
  // the phone-pick button behind a list that is empty whenever the printer
  // cannot be reached.
  router.push({ name: ROUTE_NAME.GCODE_TIMELAPSE })
}

const onLocalFileClick = (file: { name: string; path: string }) => {
  if (!/\.(3mf|gcode)$/i.test(file.name)) return
  if (isCloudPrintBlocked(modules.value)) {
    showReprintBlockedDialog()
    return
  }
  actionFile.value = file
  actionSheetShow.value = true
}

const onActionSelect = (action: { name: string }) => {
  const file = actionFile.value
  actionSheetShow.value = false
  if (!file) return
  if (action.name === t('tl_gen_action_print')) {
    confirmPrint(file)
  } else {
    router.push({
      name: ROUTE_NAME.GCODE_TIMELAPSE,
      query: { path: file.path, name: file.name },
    })
  }
}

const confirmPrint = (file: { name: string; path: string }) => {
  showConfirmDialog({
    title: t('files_print_local'),
    message: isPrinting.value
      ? t('toolbox_warn_printing')
      : `${t('files_reprint_confirm')}\n${file.name}`,
    showCancelButton: !isPrinting.value,
    cancelButtonText: t('cancel'),
    confirmButtonText: t('confirm'),
  })
    .then(async () => {
      try {
        markReprintAttempt()
        await client.startProject({
          param: file.path,
          url: `ftp://${file.path}`,
          timelapse: timelapseDefault(),
        })
        showToast(t('files_reprint_sent'))
      } catch (err: any) {
        showReprintError(err)
      }
    })
    .catch(() => {})
}

const formatDate = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const statusText = (status: number) => {
  if (status === 2) return t('files_status_done')
  if (status === 4) return t('files_status_printing')
  return t('files_status_failed')
}

const statusType = (status: number): 'success' | 'primary' | 'danger' => {
  if (status === 2) return 'success'
  if (status === 4) return 'primary'
  return 'danger'
}
</script>

<style scoped>
.files-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tl-entry {
  flex-shrink: 0;
  padding-top: 8px;
}

.files-tabs :deep(.van-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.history-filter {
  padding: 8px 16px 0;
}

.task-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 8px;
  border-radius: 10px;
  background: var(--van-cell-background);
}

.task-cover {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}

.cover-loading {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--van-gray-6);
}

.task-info {
  flex: 1;
  min-width: 0;
}

.task-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-sub {
  font-size: 12px;
  color: var(--van-text-color-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--van-text-color-3);
  margin-top: 4px;
}

.task-device {
  color: var(--van-primary-color);
}

.task-status {
  flex-shrink: 0;
}

.local-group {
  margin-top: 8px;
}

.tl-empty-desc {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.7;
}
</style>
