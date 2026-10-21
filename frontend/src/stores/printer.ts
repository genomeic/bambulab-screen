import { ref, watch } from 'vue'
import { PrinterEvent, type DevicePrint, type Module } from '@bambulab-p1screen/printer-api'
import { client } from '../printer'
import { maybeAutoDeduct } from '../utils/spoolStore'

const print = ref<DevicePrint | undefined>(client.device.print)
const modules = ref<Module[] | undefined>(client.device.module)
const model = ref<string | undefined>(client.device.model)

let bound = false

const SYNC_INTERVAL = 250
let pendingSync: number | undefined
let lastSyncedState: string | undefined

const syncClientState = () => {
  print.value = client.device.print
  modules.value = client.device.module
  model.value = client.device.model
  lastSyncedState = client.device.print?.gcode_state
}

/**
 * Printers push status many times per second (and every device in the fleet
 * pushes independently). Re-rendering the whole UI on every push made pages
 * with lots of reactive nodes — the filament page in particular — visibly
 * stutter on phones. Data-only pushes are coalesced; a gcode_state change is
 * always flushed immediately so the print state machine stays exact.
 */
const syncCoalesced = () => {
  const state = client.device.print?.gcode_state
  if (state !== lastSyncedState) {
    if (pendingSync !== undefined) {
      clearTimeout(pendingSync)
      pendingSync = undefined
    }
    syncClientState()
    return
  }
  if (pendingSync !== undefined) return
  pendingSync = window.setTimeout(() => {
    pendingSync = undefined
    syncClientState()
  }, SYNC_INTERVAL)
}

// keep the native side informed so it can hold the screen awake while printing
watch(
  () => print.value?.gcode_state,
  (state, previous) => {
    const bridge = (window as any).P1ScreenBridge
    bridge?.setPrinting?.(state === 'RUNNING')

    // a print just finished normally: deduct this print's usage from the
    // tracked spool that was loaded (manual bookkeeping feature, best effort).
    // FAILED prints are intentionally skipped: the cloud task weight for a
    // failed task does not reflect real material usage, and deducting it
    // would overstate consumption.
    if (previous === 'RUNNING' && state === 'FINISH') {
      const serial = client.connectOptions?.serial
      if (serial && print.value) {
        maybeAutoDeduct(serial, print.value).catch((error) => {
          console.warn('[spoolDeduct] auto deduct failed:', error)
        })
      }
    }
  },
  { immediate: true }
)

const handleMqttStateChange = () => {
  // coalesced too: with several fleet devices connected this event fires very
  // often, and gcode_state changes still flush immediately via syncCoalesced.
  syncCoalesced()
}

const handlePrintPushStatus = () => {
  syncCoalesced()

  // test
  // print.value!.gcode_state = 'IDLE'
  // print.value!.gcode_state = 'FINISH'
  // print.value!.gcode_state = 'FAILED'
  // print.value!.gcode_state = 'RUNNING'
  // print.value!.gcode_state = 'SLICING'
  // print.value!.print_error = 117473297
  // print.value!.hms = [
  //   {"attr":117448704,"code":131073,"action":0,"timestamp":1777383334}, // AMS耗材用尽。请把耗材放入同一个AMS槽位后继续。
  // ]
  // print.value!.ams.ams = []
  // print.value!.ams.ams[1] = {
  //   id: '1',
  //   humidity: '3',
  //   humidity_raw: '10',
  //   temp: '20',
  //   tray: print.value!.ams.ams[0].tray,
  // }
  // print.value!.ams.ams[0].tray[0].tray_color = '00CC66FF'
  // print.value!.ams.ams[0].tray[0].tag_uid = 'xxx'
  // print.value!.ams.ams[0].tray[0].remain = 80
  // print.value!.ams.ams[0].tray[1].tray_color = '00CCCCFF'
  // print.value!.ams.ams[0].tray[1].tag_uid = 'xxx'
  // print.value!.ams.ams[0].tray[1].remain = 75
  // print.value!.ams.ams[0].tray[2].tray_color = 'CC0000FF'
  // print.value!.ams.ams[0].tray[2].tag_uid = 'xxx'
  // print.value!.ams.ams[0].tray[2].remain = 85
  // print.value!.ams.ams[0].tray[3].tray_color = 'FFFFFFFF'
  // print.value!.ams.ams[0].tray[3].tag_uid = '0000000000000000'
  // print.value!.ams.ams[0].tray[3].remain = -1
}

export const bindPrinterClient = () => {
  if (bound) return
  bound = true
  syncClientState()

  client.on(PrinterEvent.MQTT_STATE_CHANGE, handleMqttStateChange)
  client.on(PrinterEvent.PRINT_PUSH_STATUS, handlePrintPushStatus)
}

export const unbindPrinterClient = () => {
  if (!bound) return
  bound = false

  client.off(PrinterEvent.MQTT_STATE_CHANGE, handleMqttStateChange)
  client.off(PrinterEvent.PRINT_PUSH_STATUS, handlePrintPushStatus)
}

export const usePrinterStore = () => ({
  device: print,
  modules,
  model,
})
