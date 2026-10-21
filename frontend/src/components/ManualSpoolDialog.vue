<template>
  <van-dialog
    :show="show"
    :title="t('set_remaining')"
    show-cancel-button
    :cancel-button-text="t('cancel')"
    :confirm-button-text="t('confirm')"
    :before-close="handleClose"
    @update:show="emit('update:show', $event)"
  >
    <div class="ms-body">
      <div class="ms-slot">{{ slotName }}</div>

      <div class="ms-row">
        <span class="ms-label">{{ t('spool_total') }}</span>
        <div class="ms-chips">
          <button
            v-for="preset in TOTAL_PRESETS"
            :key="preset"
            type="button"
            class="ms-chip"
            :class="{ active: total === preset }"
            @click="total = preset"
          >{{ preset }}g</button>
        </div>
      </div>

      <div class="ms-row">
        <span class="ms-label">{{ t('remaining_amount') }}</span>
        <div class="ms-input-wrap">
          <input
            v-model="remainingText"
            class="ms-input"
            type="text"
            inputmode="decimal"
            min="0"
            :placeholder="t('enter_remaining_g')"
          >
          <span class="ms-unit">g</span>
        </div>
      </div>

      <div v-if="percent !== null" class="ms-meter">
        <div class="ms-meter-track">
          <div class="ms-meter-fill" :style="{ width: `${percent}%` }"></div>
        </div>
        <span class="ms-meter-label">{{ remaining ?? 0 }}g / {{ total ?? '?' }}g（{{ percent }}%）</span>
      </div>

      <button v-if="hasStored" type="button" class="ms-clear" @click="handleClear">
        {{ t('clear_manual') }}
      </button>
    </div>
  </van-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { showToast } from 'vant'
import {
  clearManualSpool,
  getManualSpool,
  setManualSpool,
} from '../utils/spoolStore'

const props = defineProps<{
  show: boolean
  serial: string
  slotIndex: number
  slotName: string
}>()

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'saved'): void
}>()

const { t } = useI18n()

const TOTAL_PRESETS = [1000, 750, 500, 250]

const total = ref<number | null>(null)
const remainingText = ref('')
const hasStored = ref(false)

const remaining = computed(() => {
  // v-model may have converted the value to a number (looseToNumber on
  // numeric input) — coerce back to string before trimming.
  const text = String(remainingText.value ?? '').trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value)
})

const percent = computed(() => {
  if (!total.value || total.value <= 0) return null
  if (remaining.value === null) return null
  return Math.max(0, Math.min(100, Math.round((remaining.value / total.value) * 100)))
})

watch(
  () => [props.show, props.serial, props.slotIndex],
  () => {
    if (!props.show) return
    const stored = getManualSpool(props.serial, props.slotIndex)
    total.value = stored?.total ?? null
    remainingText.value = stored?.remaining !== undefined ? String(stored.remaining) : ''
    hasStored.value = !!stored
  },
  { immediate: true }
)

const handleClose = (action: string) => {
  if (action !== 'confirm') {
    emit('update:show', false)
    return
  }
  if (total.value !== null && remaining.value === null) {
    showToast({ message: t('enter_remaining_g'), position: 'bottom' })
    return false // keep the dialog open
  }
  setManualSpool(props.serial, props.slotIndex, {
    total: total.value ?? undefined,
    remaining: remaining.value ?? undefined,
  })
  hasStored.value = true
  emit('saved')
  emit('update:show', false)
  return true
}

const handleClear = () => {
  clearManualSpool(props.serial, props.slotIndex)
  total.value = null
  remainingText.value = ''
  hasStored.value = false
  emit('saved')
  emit('update:show', false)
}
</script>

<style scoped>
.ms-body {
  padding: 12px 20px 20px;
  display: grid;
  gap: 12px;
  font-size: 14px;
}

.ms-slot {
  color: var(--van-text-color-2);
  font-weight: 600;
}

.ms-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ms-label {
  flex: 0 0 auto;
  width: 70px;
  color: var(--van-text-color-2);
}

.ms-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ms-chip {
  border: 1px solid var(--van-background-5);
  background: var(--van-background-3);
  color: var(--van-text-color);
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 13px;
}

.ms-chip.active {
  border-color: var(--van-primary-color);
  color: var(--van-primary-color);
}

.ms-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}

.ms-input {
  width: 100%;
  border: 1px solid var(--van-background-5);
  border-radius: 6px;
  background: var(--van-background-3);
  color: var(--van-text-color);
  padding: 4px 8px;
  font-size: 14px;
}

.ms-unit {
  color: var(--van-text-color-2);
}

.ms-meter {
  display: grid;
  gap: 4px;
}

.ms-meter-track {
  height: 8px;
  border-radius: 4px;
  background: var(--van-background-4);
  overflow: hidden;
}

.ms-meter-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--van-primary-color);
}

.ms-meter-label {
  font-size: 12px;
  color: var(--van-text-color-2);
}

.ms-clear {
  justify-self: start;
  border: none;
  background: none;
  color: var(--van-red);
  font-size: 13px;
  padding: 0;
}
</style>
