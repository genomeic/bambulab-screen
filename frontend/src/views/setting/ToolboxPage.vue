<template>
  <BasePage :title="t('toolbox')">
    <div class="toolbox-groups">
      <van-cell-group inset :title="t('toolbox_maintenance')">
        <van-cell :title="t('toolbox_light')" center>
          <template #right-icon>
            <van-switch
              :model-value="lightOn"
              :loading="lightLoading"
              size="24px"
              @update:model-value="onLightToggle"
            />
          </template>
        </van-cell>
        <van-cell :title="t('toolbox_fan')" is-link center @click="showFanPopup = true" />
        <van-cell :title="t('toolbox_home_axes')" :label="t('toolbox_home_axes_desc')" is-link center @click="confirmHome" />
        <van-cell :title="t('toolbox_auto_leveling')" :label="t('toolbox_auto_leveling_desc')" is-link center @click="confirmLeveling" />
        <van-cell :title="t('toolbox_axis_move')" is-link center @click="router.push({ name: ROUTE_NAME.CONTROL_MOTION })" />
      </van-cell-group>

      <van-cell-group inset :title="t('toolbox_device')">
        <van-cell :title="t('toolbox_calibration')" is-link center @click="router.push({ name: ROUTE_NAME.SETTING_CALIBRATION })" />
        <van-cell :title="t('toolbox_ams_setting')" is-link center @click="router.push({ name: ROUTE_NAME.SETTING_AMS_SETTING })" />
        <van-cell :title="t('device_serial')" :value="getCurrentDevice()?.name ?? ''" is-link center @click="router.push({ name: ROUTE_NAME.SETTING_SERIAL })" />
        <van-cell :title="t('firmware')" is-link center @click="router.push({ name: ROUTE_NAME.SETTING_FIRMWARE })" />
      </van-cell-group>
    </div>

    <FanSpeedPopup v-model:show="showFanPopup" />
  </BasePage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { LightType } from '@bambulab-p1screen/printer-api'
import { ROUTE_NAME } from '../../router/routes'
import { client } from '../../printer'
import { usePrinterStore } from '../../stores/printer'
import { getCurrentDevice } from '../../utils/device'
import BasePage from '../../components/BasePage.vue'
import FanSpeedPopup from '../../components/FanSpeedPopup.vue'

const { t } = useI18n()
const router = useRouter()
const { device } = usePrinterStore()

const showFanPopup = ref(false)
const lightLoading = ref(false)

const lightOn = computed(
  () => device.value?.lights_report?.find(item => item.node === LightType.Chamber)?.mode === 'on'
)
const isPrinting = computed(() => device.value?.gcode_state === 'RUNNING')

const onLightToggle = async (on: boolean) => {
  lightLoading.value = true
  try {
    await client.setLight(LightType.Chamber, on)
  } catch (err: any) {
    showToast(err?.message ?? 'error')
  } finally {
    lightLoading.value = false
  }
}

const sendGcode = (gcode: string) => client.request('print.gcode_line', { param: gcode })

const confirmHome = () => {
  showConfirmDialog({
    title: t('toolbox_home_axes'),
    message: isPrinting.value
      ? t('toolbox_warn_printing')
      : t('toolbox_confirm_home'),
    showCancelButton: !isPrinting.value,
    cancelButtonText: t('cancel'),
    confirmButtonText: t('confirm'),
  })
    .then(() => sendGcode('G28 \n'))
    .catch(() => {})
}

const confirmLeveling = () => {
  showConfirmDialog({
    title: t('toolbox_auto_leveling'),
    message: isPrinting.value
      ? t('toolbox_warn_printing')
      : t('toolbox_confirm_leveling'),
    showCancelButton: !isPrinting.value,
    cancelButtonText: t('cancel'),
    confirmButtonText: t('confirm'),
  })
    .then(() => sendGcode('G29 \n'))
    .catch(() => {})
}
</script>

<style scoped>
.toolbox-groups {
  display: grid;
  gap: 10px;
  padding-bottom: 12px;
}

:deep(.van-cell-group__title) {
  padding: 8px 16px 4px;
}
</style>
