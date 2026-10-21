import { ref } from 'vue'
import { PrinterClient, PrinterEvent } from '@bambulab-p1screen/printer-api'
import { connectPrinter, getConnectionOptions } from '../printer'
import { getCurrentDevice, getDevices, setCurrentDevice, type DeviceRecord } from '../utils/device'

export type FleetItem = {
  record: DeviceRecord
  model: string
  online: boolean
  connecting: boolean
  gcodeState: string
  progress: number
  remaining: number // minutes
  nozzleTemper: number
  bedTemper: number
  chamberTemper?: number
  hmsCount: number
  taskName: string
}

/**
 * Multi-device manager: keeps one lightweight PrinterClient per non-active
 * device so the overview page can show every printer at once. The currently
 * active device is driven by the main singleton client and is not duplicated.
 */
const items = ref<Map<string, FleetItem>>(new Map())
const started = ref(false)
const clients = new Map<string, PrinterClient>()

const buildItem = (record: DeviceRecord): FleetItem => ({
  record,
  model: '',
  online: false,
  connecting: true,
  gcodeState: '',
  progress: 0,
  remaining: 0,
  nozzleTemper: 0,
  bedTemper: 0,
  chamberTemper: undefined,
  hmsCount: 0,
  taskName: '',
})

const syncItem = (item: FleetItem, client: PrinterClient) => {
  item.online = !!client.mqttClient?.connected
  item.connecting = !item.online && !!client.connectOptions
  item.model = client.device.model ?? ''
  const p: any = client.device.print
  if (!p) return
  item.gcodeState = p.gcode_state ?? ''
  item.progress = p.mc_percent ?? 0
  item.remaining = p.mc_remaining_time ?? 0
  item.nozzleTemper = p.nozzle_temper ?? 0
  item.bedTemper = p.bed_temper ?? 0
  if (p.chamber_temper !== undefined) item.chamberTemper = p.chamber_temper
  item.hmsCount = Array.isArray(p.hms) ? p.hms.length : 0
  item.taskName = p.subtask_name ?? ''
}

export const startFleet = () => {
  if (started.value) return
  started.value = true
  const current = getCurrentDevice()
  for (const record of getDevices()) {
    if (current && record.serial === current.serial) continue
    const item = buildItem(record)
    items.value.set(record.serial, item)
    const client = new PrinterClient()
    clients.set(record.serial, client)
    const handler = () => syncItem(item, client)
    client.on(PrinterEvent.MQTT_STATE_CHANGE, handler)
    client.on(PrinterEvent.PRINT_PUSH_STATUS, handler)
    try {
      client.connect(getConnectionOptions(record))
    } catch {
      item.connecting = false
    }
  }
}

export const stopFleet = () => {
  for (const client of clients.values()) client.disconnect()
  clients.clear()
  items.value.clear()
  started.value = false
}

export const restartFleet = () => {
  stopFleet()
  startFleet()
}

/** Ensure one non-active device has a fleet client; connect it if missing. */
export const ensureFleetDevice = (serial: string) => {
  const current = getCurrentDevice()
  if (current && serial === current.serial) return
  const record = getDevices().find(item => item.serial === serial)
  if (!record) return
  // Existing item: refresh its record (name/mode may have been edited) and keep the client.
  const existing = items.value.get(serial)
  if (existing) {
    existing.record = record
    return
  }
  if (clients.has(serial)) return
  const item = buildItem(record)
  items.value.set(record.serial, item)
  const client = new PrinterClient()
  clients.set(record.serial, client)
  const handler = () => syncItem(item, client)
  client.on(PrinterEvent.MQTT_STATE_CHANGE, handler)
  client.on(PrinterEvent.PRINT_PUSH_STATUS, handler)
  try {
    client.connect(getConnectionOptions(record))
  } catch {
    item.connecting = false
  }
}

/** Drop a deleted device from the fleet pool and close its connection. */
export const removeFleetDevice = (serial: string) => {
  const client = clients.get(serial)
  if (client) {
    client.disconnect()
    clients.delete(serial)
  }
  items.value.delete(serial)
}

/** Make the picked device the active one and let the main client take over its connection. */
export const switchToDevice = (serial: string) => {
  const record = getDevices().find(item => item.serial === serial)
  if (!record) return false
  const previousSerial = getCurrentDevice()?.serial
  setCurrentDevice(serial)
  const client = clients.get(serial)
  if (client) {
    client.disconnect()
    clients.delete(serial)
  }
  items.value.delete(serial)
  connectPrinter(record)
  // the previous active device was outside the fleet pool (it was driven by
  // the main client) — put it back so the overview keeps showing it
  if (previousSerial && previousSerial !== serial) ensureFleetDevice(previousSerial)
  return true
}

export const fleetItems = items
export const fleetStarted = started
