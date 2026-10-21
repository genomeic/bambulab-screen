<template>
  <BasePage :title="t('auto_refill')">
    <div v-if="device" class="auto-refill">
      <van-cell-group inset>
        <van-cell :title="t('ams_auto_switch')" :label="t('ams_auto_switch_desc')" center>
          <template #right-icon>
            <van-switch :model-value="autoSwitch" :loading="switching" @change="toggleAutoSwitch" />
          </template>
        </van-cell>
      </van-cell-group>

      <div class="refill-hint">{{ t('auto_refill_hint') }}</div>

      <van-cell-group
        v-for="ams in device.ams.ams"
        :key="ams.id"
        inset
        :title="`AMS-${amsPrefix(String(ams.id))}`"
      >
        <div class="refill-body">
          <div class="slot-row">
            <div
              v-for="tray in traysOf(ams.id)"
              :key="tray.id"
              class="slot"
              :class="{ empty: !isFilled(tray), linked: isLinked(ams.id, tray.id) }"
            >
              <div class="slot-color" :style="{ backgroundColor: cssColor(tray) }"></div>
              <div class="slot-name">{{ slotName(ams.id, tray.id) }}</div>
              <div class="slot-type">{{ isFilled(tray) ? tray.tray_type : '—' }}</div>
            </div>
          </div>

          <div v-if="chainsOf(ams.id).length" class="chains">
            <div v-for="(chain, index) in chainsOf(ams.id)" :key="index" class="chain">
              <span class="chain-label">{{ t('refill_order') }}</span>
              <span v-for="(tray, i) in chain" :key="tray.id" class="chain-item">
                <span v-if="i" class="chain-arrow">→</span>
                <span class="chain-slot">{{ slotName(ams.id, tray.id) }}</span>
              </span>
            </div>
          </div>
          <div v-else class="no-chain">
            {{ t('auto_refill_none') }}
            <div class="no-chain-desc">{{ t('auto_refill_none_desc') }}</div>
          </div>
        </div>
      </van-cell-group>
    </div>
  </BasePage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { showToast } from 'vant'
import { HomeFlagBit, type DeviceTray } from '@bambulab-p1screen/printer-api'
import { client } from '../../printer'
import { amsPrefix } from '../../utils/ams'
import { usePrinterStore } from '../../stores/printer'

const { t } = useI18n()
const { device } = usePrinterStore()

// ---------------------------------------------------------------------------
// Auto-refill switch (mirrors the AMS settings page): home_flag bit 10 is the
// read state, print.print_option auto_switch_filament toggles it.
// ---------------------------------------------------------------------------
const autoSwitch = computed(() =>
  Boolean((device.value?.home_flag ?? 0) & (1 << HomeFlagBit.auto_switch_filament))
)
const switching = ref(false)

const toggleAutoSwitch = async (selected: boolean) => {
  if (switching.value) return
  switching.value = true
  try {
    await client.request('print.print_option', { auto_switch_filament: selected })
    if (device.value) {
      device.value.home_flag = selected
        ? device.value.home_flag | (1 << HomeFlagBit.auto_switch_filament)
        : device.value.home_flag & ~(1 << HomeFlagBit.auto_switch_filament)
    }
    showToast({ message: t('success'), position: 'bottom' })
  } catch (error: any) {
    // err_code 84033543 = "mqtt message verify failed": newer firmware rejects
    // unsigned third-party commands — guide the user instead of a raw error.
    const message = String(error?.message ?? '')
    showToast({
      message: message.includes('84033543') || message.includes('verify failed')
        ? t('option_blocked_by_firmware')
        : t('failed', { message }),
      position: 'bottom',
    })
  } finally {
    switching.value = false
  }
}

// ---------------------------------------------------------------------------
// Refill chains: slots that the AMS can fail over to must have identical
// filament attributes (brand profile, type, colour, temperatures).
// ---------------------------------------------------------------------------
const isFilled = (tray: DeviceTray) => Boolean(tray.tray_info_idx)

const slotName = (amsId: string | number, trayId: string | number) =>
  `${amsPrefix(String(amsId))}${Number(trayId) + 1}`

const traysOf = (amsId: string | number): DeviceTray[] => {
  const ams = device.value?.ams.ams.find(unit => String(unit.id) === String(amsId))
  return ams ? [...ams.tray].sort((a, b) => Number(a.id) - Number(b.id)) : []
}

const attrKey = (tray: DeviceTray) =>
  [
    tray.tray_info_idx,
    tray.tray_type,
    tray.tray_color,
    tray.nozzle_temp_min,
    tray.nozzle_temp_max,
  ].join('|')

const chainsOf = (amsId: string | number): DeviceTray[][] => {
  const groups = new Map<string, DeviceTray[]>()
  for (const tray of traysOf(amsId)) {
    if (!isFilled(tray)) continue
    const key = attrKey(tray)
    const group = groups.get(key)
    if (group) group.push(tray)
    else groups.set(key, [tray])
  }
  return [...groups.values()].filter(group => group.length > 1)
}

const isLinked = (amsId: string | number, trayId: string | number) =>
  chainsOf(amsId).some(chain => chain.some(tray => String(tray.id) === String(trayId)))

const cssColor = (tray: DeviceTray) => `#${(tray.tray_color || 'FFFFFF00').slice(0, 6)}`
</script>

<style scoped>
.auto-refill {
  padding-bottom: 24px;
}
.refill-hint {
  margin: 12px 20px 0;
  font-size: 12px;
  color: var(--van-text-color-2);
}
.refill-body {
  padding: 12px 16px;
}
.slot-row {
  display: flex;
  gap: 10px;
}
.slot {
  flex: 1;
  max-width: 76px;
  border: 1px solid var(--van-background-5);
  border-radius: 8px;
  background: var(--van-background-3);
  padding: 6px 4px 8px;
  text-align: center;
}
.slot.empty {
  opacity: 0.45;
}
.slot.linked {
  border-color: var(--van-primary-color);
}
.slot-color {
  height: 5px;
  border-radius: 3px;
  margin-bottom: 6px;
}
.slot-name {
  font-size: 12px;
  font-weight: 600;
}
.slot-type {
  font-size: 11px;
  color: var(--van-text-color-2);
}
.chains {
  margin-top: 12px;
  display: grid;
  gap: 8px;
}
.chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 13px;
}
.chain-label {
  color: var(--van-text-color-2);
  margin-right: 4px;
}
.chain-slot {
  border: 1px solid var(--van-primary-color);
  color: var(--van-primary-color);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 12px;
}
.chain-arrow {
  color: var(--van-text-color-2);
}
.no-chain {
  margin-top: 12px;
  font-size: 13px;
  color: var(--van-text-color-2);
}
.no-chain-desc {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.7;
}
</style>
