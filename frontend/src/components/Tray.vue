<template>
  <van-popover
    v-model:show="showPopover"
    trigger="manual"
    placement="bottom"
    :actions="actions"
    :offset="[0, -32]"
    style="--van-popover-action-width: 90px;"
    @select="handleTrayAction"
  >
    <template #reference>
      <div class="tray" :class="{ 'has-weight': materialWeight !== null }" @click.stop="handleTrayClick">
        <div class="remain" :style="{ visibility: isExt || effectiveRemain === -1 ? 'hidden' : 'visible' }">
          <div :style="{ backgroundColor: bgColor, width: `${effectiveRemain}%` }"></div>
        </div>
        <div class="filament" :style="{ '--tray-bg': bgColor }"></div>
        <span class="name" :style="{ color: textColor }">{{ name }}</span>
        <span class="material" :style="{ color: textColor }">
          <span class="material-type">{{ materialType }}</span>
          <span v-if="materialWeight !== null" class="material-weight">{{ materialWeight }}g</span>
        </span>
        <template v-if="exist || isExt">
          <span v-if="readonly" class="icon icon-readonly" :style="{ backgroundColor: textColor}"></span>
          <span v-else class="icon icon-edit" :style="{ backgroundColor: textColor}"></span>
        </template>
        <div v-if="isCurrent" class="arrow">
          <div class="line" :style="{ borderColor: bgColor }" ></div>
          <i-material-symbols-arrow-drop-down :style="{ color: bgColor }" />
        </div>
      </div>
    </template>
  </van-popover>
</template>

<script setup lang="ts">
import { colord } from 'colord'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceTray } from '@bambulab-p1screen/printer-api'
import { type PopoverAction } from 'vant'
import { getManualRemainPercent, getManualSpool, getSpoolSerial, spoolStoreVersion } from '../utils/spoolStore'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    name: string
    amsId: number
    tray: DeviceTray
    trayNow: number
    trayTar: number
    trayPrev: number
    popoverAction?: (amsId: number, tray: DeviceTray, action: PopoverAction) => void
  }>(),
  {
  }
)

const showPopover = ref(false)

const actions = computed<PopoverAction[]>(() => {
  if (!exist.value && !isExt.value) return []

  const menu: PopoverAction[] = [
    { type: 'edit', text: readonly.value ? t('view') : t('edit') },
    { type: 'spool', text: t('set_remaining') },
  ]

  // if (isLoading.value) { // 换料中
  if (!isExt.value && isLoading.value) { // TODO: temporary solution, need test
    if (props.trayTar !== 255 && isTarget.value) {
      menu.push({ type: 'load', text: t('loading_filament'), disabled: true })
    } else if (props.trayTar === 255 && isPrev.value) {
      menu.push({ type: 'load', text: t('unloading_filament'), disabled: true })
    } else {
      menu.push({ type: 'load', text: t('load'), disabled: true })
    }
  } else {
    menu.push(isCurrent.value ? { type: 'unload', text: t('unload') } : { type: 'load', text: t('load') })
  }

  if (!isExt.value) {
    menu.push({ type: 'reload', text: t('reload') })
  }
  return menu
})

// The type and the remaining grams are stacked: a single line is too narrow
// for "ABS·340g" and got clipped on real devices.
const materialType = computed(() => props.tray.tray_type || '?')
const materialWeight = computed(() => {
  const remaining = manualSpool.value?.remaining
  return typeof remaining === 'number' ? Math.round(remaining) : null
})
const color = computed(() => `#${props.tray.tray_color}`)
const exist = computed(() => props.tray.tray_info_idx?.length > 0)

// Manual spool bookkeeping (community feature): a manually-entered remaining
// amount replaces the printer-reported remain value.
const slotIndex = computed(() => (Number(props.tray.id) === 254 ? 254 : props.amsId * 4 + Number(props.tray.id)))
const manualSpool = computed(() => {
  spoolStoreVersion.value // reactive dependency on localStorage mutations
  const serial = getSpoolSerial()
  if (!serial) return undefined
  return getManualSpool(serial, slotIndex.value)
})
const manualPercent = computed(() => {
  spoolStoreVersion.value
  const serial = getSpoolSerial()
  if (!serial) return null
  return getManualRemainPercent(serial, slotIndex.value)
})

// -1 = empty slot (hide bar). AMS 2 Pro (H2D) may report remain=0 or omit the
// field entirely even with filament loaded, so any non-positive/missing value
// on a loaded slot shows as full — consistent with AMSIndicator.
const effectiveRemain = computed(() => {
  if (manualPercent.value !== null) return manualPercent.value
  const remain = Number(props.tray.remain)
  if (remain === -1) return -1
  if (remain > 0) return remain
  return exist.value ? 100 : -1
})
const readonly = computed(() => props.tray.tag_uid !== '0000000000000000')
const isLoading = computed(() => props.trayNow !== props.trayTar)
const isCurrent = computed(() => trayEqual(props.trayNow))
const isTarget = computed(() => trayEqual(props.trayTar))
const isPrev = computed(() => trayEqual(props.trayPrev))
const isExt = computed(() => trayEqual(254))

const trayEqual = (target: number) => (target === 254 && Number(props.tray.id) === 254) || (props.amsId * 4 + Number(props.tray.id) === target)

const handleTrayClick = () => {
  if (!props.tray) return
  if (!isExt.value && !props.tray.tray_info_idx) return
  showPopover.value = !showPopover.value
}

const handleTrayAction = (action: PopoverAction) => {
  showPopover.value = false
  if (props.popoverAction) props.popoverAction(props.amsId, props.tray, action)
}

const bgColor = computed(() => {
  const parsedColor = colord(color.value)
  return parsedColor.toRgbString()
})

const textColor = computed(() => {
  let parsedColor = colord(bgColor.value)
  if (parsedColor.rgba.a === 0) return 'white'
  return parsedColor.brightness() > 0.5 ? 'black' : 'white'
})

</script>

<style scoped>
.tray {
  position: relative;
  display: grid;
  width: 48px;
  height: 64px;
  margin: 8px;
  margin-left: 6px;
  /* extra row added by the "340g" line — offset the arrow so it stays
     inside the filament spool (grid rows push it down otherwise) */
  --extra-line: 0px;
}
.tray.has-weight {
  --extra-line: 12px;
}
.remain {
  position: relative;
  width: 24px;
  height: 4px;
  border-radius: 2px;
  top: -6px;
  margin: 0 12px;
  background-color: var(--van-background-5);
  overflow: hidden;
}
.remain > div {
  height: 100%;
  border-radius: 2px;
}
.filament {
  width: 48px;
  height: 64px;
  border: var(--van-background-5) 2px solid;
  --tray-bg: var(--van-text-color-2);
  background-image:
    linear-gradient(var(--tray-bg), var(--tray-bg)),
    linear-gradient(45deg, var(--van-background-5) 25%, transparent 25%, transparent 75%, var(--van-background-5) 75%),
    linear-gradient(45deg, var(--van-background-5) 25%, transparent 25%, transparent 75%, var(--van-background-5) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 0, 6px 6px;
}
.filament::before, .filament::after {
  display: block;
  width: 4px;
  height: 130%;
  border-radius: 2px;
  position: relative;
  content: '\0020';
  background-color: var(--van-background-5);
}
.filament::before {
  left: -2px;
  top: -15%;
}
.filament::after {
  left: calc(100% - 2px);
  top: -145%;
}
.tray > span:not(.icon) {
  position: relative;
  top: -58px;
  font-weight: 600;
  text-align: center;
}.name {
  font-size: 11px;
}
.material {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 11px;
  line-height: 1.15;
  white-space: nowrap;
}
.material-weight {
  font-size: 11px;
  opacity: 0.85;
}
.icon {
  /* pinned to the bottom of the spool, centred, so the stacked
     name/type/weight lines can never push or overlap it */
  position: absolute;
  bottom: 0px;
  left: 50%;
  transform: translateX(-50%);
  width: 12px;
  height: 12px;
  margin: 0;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}
.icon-edit {
  mask-image: url(/src/assets/images/rename_edit.svg);
}
.icon-readonly {
  mask-image: url(/src/assets/images/ams_slot_readonly.svg);
}
.arrow {
  position: relative;
  top: -53px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tray.has-weight .arrow {
  top: calc(-53px - var(--extra-line));
}
.line {
  width: 4px;
  height: 15px;
  border: 2px dashed;
  margin-bottom: -8px;
}
:deep(.van-popover__action-text) {
  white-space: nowrap !important;
}
</style>
