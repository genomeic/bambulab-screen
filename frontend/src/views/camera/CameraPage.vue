<template>
  <BasePage :title="t('camera')">
    <div class="camera-page">
      <template v-if="!isAndroid">
        <van-empty :description="t('camera_need_app')" />
      </template>

      <template v-else-if="!isLocalReady">
        <van-empty :description="t('camera_need_local')" />
        <div class="camera-steps">{{ t('camera_local_steps') }}</div>
      </template>

      <template v-else>
        <div class="camera-stage">
          <img v-if="frameUrl" :src="frameUrl" class="camera-frame" draggable="false" />
          <div v-else class="camera-placeholder">
            <span>{{ placeholderText }}</span>
          </div>
        </div>

        <div class="camera-status">
          <span :class="['dot', statusLevel]" />
          {{ statusText }}
        </div>

        <div class="camera-actions">
          <van-button v-if="streaming" type="default" block @click="stopStream">
            {{ t('camera_stop') }}
          </van-button>
          <van-button v-else type="primary" block @click="startStream">
            {{ streaming ? t('camera_start') : (status === 'not_started' ? t('camera_start') : t('camera_retry')) }}
          </van-button>
        </div>
      </template>
    </div>
  </BasePage>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BasePage from '../../components/BasePage.vue'
import { getCurrentDevice, type DeviceRecord } from '../../utils/device'

const { t } = useI18n()

type CameraBridge = {
  startCamera?: (serial: string, ip: string, code: string) => void
  stopCamera?: (serial: string) => void
  getCameraStatus?: (serial: string) => string
}

const getBridge = () => (window as unknown as { P1ScreenBridge?: CameraBridge }).P1ScreenBridge

const currentDevice = ref<DeviceRecord | null>(null)
const status = ref('not_started')
const frameUrl = ref('')
const frameTick = ref(0)

let frameTimer: number | undefined
let statusTimer: number | undefined

const isAndroid = computed(() => !!getBridge())
const isLocalReady = computed(() => {
  const device = currentDevice.value
  return !!device && device.connect === 'local' && !!device.ip && !!device.code
})

const streaming = computed(() => status.value === 'streaming' || status.value === 'connecting' || status.value === 'reconnecting')

const statusLevel = computed(() => {
  if (status.value === 'streaming') return 'ok'
  if (status.value.startsWith('error')) return 'error'
  if (status.value === 'connecting' || status.value === 'reconnecting') return 'busy'
  return 'idle'
})

const statusText = computed(() => {
  if (status.value === 'streaming') return t('camera_streaming')
  if (status.value === 'connecting') return t('camera_connecting')
  if (status.value === 'reconnecting') return t('camera_reconnecting')
  if (status.value.startsWith('error:')) return `${t('camera_error')}: ${status.value.slice('error:'.length)}`
  return t('camera_not_started')
})

const placeholderText = computed(() => {
  if (status.value.startsWith('error:')) return statusText.value
  if (status.value === 'not_started') return t('camera_start_hint')
  return t('camera_waiting_frame')
})

const refreshFrame = () => {
  const device = currentDevice.value
  if (!device) return
  // cache-buster keeps the webview from serving a stale frame
  frameUrl.value = `/api/camera?serial=${encodeURIComponent(device.serial)}&t=${Date.now()}`
}

const refreshStatus = () => {
  const device = currentDevice.value
  const bridge = getBridge()
  if (!device || !bridge?.getCameraStatus) return
  status.value = bridge.getCameraStatus(device.serial) ?? 'not_started'
}

const startStream = () => {
  const device = currentDevice.value
  const bridge = getBridge()
  if (!device || !bridge?.startCamera) return
  frameUrl.value = ''
  status.value = 'connecting'
  bridge.startCamera(device.serial, device.ip, device.code)
  clearTimers()
  frameTimer = window.setInterval(() => {
    frameTick.value++
    refreshFrame()
  }, 250)
  statusTimer = window.setInterval(refreshStatus, 1000)
}

const stopStream = () => {
  const device = currentDevice.value
  getBridge()?.stopCamera?.(device?.serial ?? '')
  clearTimers()
  frameUrl.value = ''
  status.value = 'not_started'
}

const clearTimers = () => {
  if (frameTimer !== undefined) {
    window.clearInterval(frameTimer)
    frameTimer = undefined
  }
  if (statusTimer !== undefined) {
    window.clearInterval(statusTimer)
    statusTimer = undefined
  }
}

onMounted(() => {
  currentDevice.value = getCurrentDevice()
  refreshStatus()
})

onUnmounted(() => {
  clearTimers()
  getBridge()?.stopCamera?.(currentDevice.value?.serial ?? '')
})
</script>

<style scoped>
.camera-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 12px;
  height: 100%;
  box-sizing: border-box;
}

.camera-stage {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}

.camera-frame {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.camera-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 24px;
  box-sizing: border-box;
  color: #9e9e9e;
  font-size: 14px;
  text-align: center;
}

.camera-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #757575;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #bdbdbd;
}

.dot.ok {
  background: #4caf50;
}

.dot.busy {
  background: #ff9800;
}

.dot.error {
  background: #f44336;
}

.camera-actions {
  width: 100%;
  max-width: 360px;
}

.camera-steps {
  max-width: 520px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--van-cell-background, #f7f8fa);
  color: #616161;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-line;
}
</style>
