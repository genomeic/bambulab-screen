<template>
  <BasePage :title="t('overview')">
    <div class="overview-page">
      <div v-if="!hasDevices" class="card empty-card" clickable @click="router.replace({ name: ROUTE_NAME.SETTING_HOME })">
        {{ t('overview_empty') }}
      </div>

      <template v-else>
        <!-- currently active device, fed by the main client -->
        <div v-if="currentCard" class="device-card current" clickable @click="router.replace({ name: ROUTE_NAME.HOME })">
          <img class="device-thumb" :src="printerThumbnail(currentCard.modelName)" />
          <div class="device-info">
            <div class="card-head">
              <span class="device-name">{{ currentCard.record.name }}</span>
              <span class="chip chip-active">{{ t('overview_active') }}</span>
              <span class="chip">{{ modeLabel(currentCard.record) }}</span>
            </div>
            <div class="state-line">
              <span class="state" :class="{ printing: isPrinting(currentCard.state) }">{{ stateLabel(currentCard.state) }}</span>
              <span v-if="currentCard.taskName" class="task-name">{{ currentCard.taskName }}</span>
            </div>
            <template v-if="isPrinting(currentCard.state)">
              <div class="progress-track"><div class="progress-fill" :style="{ width: currentCard.progress + '%' }"></div></div>
            </template>
            <div class="card-foot">
              <span>{{ Math.floor(currentCard.nozzleTemper) }}°C / {{ Math.floor(currentCard.bedTemper) }}°C</span>
              <span v-if="isPrinting(currentCard.state)">{{ formatRemaining(currentCard.remaining) }}</span>
              <van-badge v-if="currentCard.hmsCount > 0" :content="currentCard.hmsCount" />
            </div>
          </div>
        </div>

        <!-- other devices, each with its own client -->
        <div
          v-for="item in deviceItems"
          :key="item.record.serial"
          class="device-card"
          clickable
          @click="handleSwitch(item)"
        >
          <img class="device-thumb" :src="printerThumbnail(modelOf(item.record.serial, item.model))" />
          <div class="device-info">
            <div class="card-head">
              <span class="device-name">{{ item.record.name }}</span>
              <span v-if="modelOf(item.record.serial, item.model)" class="chip">{{ modelOf(item.record.serial, item.model) }}</span>
              <span class="chip">{{ modeLabel(item.record) }}</span>
            </div>
            <div class="state-line">
              <span class="state" :class="{ printing: isPrinting(item.gcodeState), offline: !item.online && !item.connecting }">
                {{ stateLabel(item.online ? item.gcodeState : '', item.connecting) }}
              </span>
              <span v-if="item.taskName" class="task-name">{{ item.taskName }}</span>
            </div>
            <template v-if="item.online && isPrinting(item.gcodeState)">
              <div class="progress-track"><div class="progress-fill" :style="{ width: item.progress + '%' }"></div></div>
            </template>
            <div class="card-foot">
              <span v-if="item.online">{{ Math.floor(item.nozzleTemper) }}°C / {{ Math.floor(item.bedTemper) }}°C</span>
              <span v-if="item.online && isPrinting(item.gcodeState)">{{ formatRemaining(item.remaining) }}</span>
              <van-badge v-if="item.hmsCount > 0" :content="item.hmsCount" />
            </div>
          </div>
        </div>

        <div class="card manage-card" clickable @click="router.replace({ name: ROUTE_NAME.SETTING_HOME })">
          {{ t('overview_manage') }}
        </div>
      </template>
    </div>
  </BasePage>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { SERIAL_PREFIX_MODEL } from '@bambulab-p1screen/printer-api'
import { ROUTE_NAME } from '../../router/routes'
import { usePrinterStore } from '../../stores/printer'
import { fleetItems, startFleet, switchToDevice, type FleetItem } from '../../stores/fleet'
import { getCurrentDevice, getDevices } from '../../utils/device'
import { printerThumbnail } from '../../utils/printerArt'

const { t } = useI18n()
const router = useRouter()
const { device, model } = usePrinterStore()

const hasDevices = computed(() => getDevices().length > 0)
const deviceItems = computed(() => Array.from(fleetItems.value.values()))

/** Resolve model name from live data, falling back to the serial number prefix */
const modelOf = (serial: string, model?: string) =>
  (model ?? '').replace(/^Bambu Lab\s*/i, '') || SERIAL_PREFIX_MODEL[serial.slice(0, 3).toUpperCase()] || ''

const currentCard = computed(() => {
  const record = getCurrentDevice()
  if (!record || !device.value) return null
  return {
    record,
    modelName: modelOf(record.serial, model.value),
    state: device.value.gcode_state ?? '',
    progress: device.value.mc_percent ?? 0,
    remaining: device.value.mc_remaining_time ?? 0,
    nozzleTemper: device.value.nozzle_temper ?? 0,
    bedTemper: device.value.bed_temper ?? 0,
    hmsCount: Array.isArray(device.value.hms) ? device.value.hms.length : 0,
    taskName: device.value.subtask_name ?? '',
  }
})

const stateKey = (state: string) => {
  const key = state.toLowerCase()
  return ['idle', 'printing', 'paused', 'finished', 'failed', 'slicing', 'preparing'].includes(key) ? `print_state_${key}` : 'print_state_idle'
}
const stateLabel = (state: string, connecting = false) => {
  if (connecting) return t('overview_connecting')
  if (!state) return t('overview_offline')
  return t(stateKey(state))
}
const isPrinting = (state: string) => state?.toLowerCase() === 'printing'

const modeLabel = (record: { connect: string; from: string }) =>
  record.connect === 'cloud' && record.from !== 'local' ? t('mode_cloud') : t('mode_lan')

const formatRemaining = (minutes: number) => {
  if (!minutes || minutes <= 0) return ''
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}${t('unit_hour')}${m}${t('unit_minute')}` : `${m}${t('unit_minute')}`
}

const handleSwitch = (item: FleetItem) => {
  // switchToDevice also returns the previous active device to the fleet pool
  if (switchToDevice(item.record.serial)) {
    router.replace({ name: ROUTE_NAME.HOME })
  }
}

onMounted(() => {
  // no-op if the fleet was already started at app launch; keeps connections warm
  startFleet()
})
</script>

<style scoped>
.overview-page {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
}

.device-card,
.empty-card,
.manage-card {
  background: var(--van-background-2);
  border-radius: 10px;
  padding: 12px 14px;
  text-align: left;
}

.device-card {
  display: flex;
  align-items: center;
  gap: 12px;
}

.device-thumb {
  width: 96px;
  height: 72px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 8px;
  background: #f2f2f4;
}

.device-info {
  flex: 1;
  min-width: 0;
}

.device-card.current {
  border: 1px solid var(--van-primary-color);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.device-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--van-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 16px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--van-background-3);
  color: var(--van-text-color-2);
}

.chip-active {
  background: rgba(255, 255, 255, 0.12);
  color: var(--van-primary-color);
}

.state-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.state {
  font-size: 14px;
  color: var(--van-text-color-2);
  flex-shrink: 0;
  white-space: nowrap;
}

.state.printing {
  color: var(--van-primary-color);
}

.state.offline {
  color: var(--van-text-color-3);
}

.task-name {
  font-size: 12px;
  color: var(--van-text-color-3);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  word-break: break-all;
  line-height: 1.35;
}

.progress-track {
  margin-top: 8px;
  height: 6px;
  border-radius: 3px;
  background: var(--van-background-3);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--van-primary-color);
  transition: width 0.6s;
}

.card-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
  font-size: 13px;
  color: var(--van-text-color-2);
}

.card-foot > span {
  white-space: nowrap;
}

.empty-card,
.manage-card {
  color: var(--van-text-color-2);
  font-size: 14px;
  text-align: center;
}

@media (orientation: landscape) {
  .overview-page {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    align-content: start;
  }

  .empty-card,
  .manage-card {
    grid-column: 1 / -1;
  }

  .device-card {
    padding: 10px 12px;
    gap: 10px;
    min-width: 0;
  }

  .device-thumb {
    width: 72px;
    height: 54px;
  }

  .device-name {
    font-size: 15px;
  }

  .task-name {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
}
</style>
