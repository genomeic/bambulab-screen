import { getPrinterConnectionMode } from '../printer'
import semverGt from 'semver/functions/gt'

/**
 * True when a print-starting command will be rejected by the printer's
 * firmware signature check (HMS 0500-0500-0001-0007): cloud-connected P1/P1S
 * with firmware 01.08+ verify every command against Bambu's per-installation
 * key, which third-party apps cannot sign.
 */
export const isCloudPrintBlocked = (modules?: Array<{ name: string, product_name?: string, sw_ver?: string }>) => {
  if (getPrinterConnectionMode() !== 'cloud') return false
  const ota = modules?.find(item => item.name === 'ota')
  if (!ota?.sw_ver || !['Bambu Lab P1P', 'Bambu Lab P1S'].includes(ota.product_name ?? '')) return false
  try {
    return semverGt(String(ota.sw_ver).split('.').slice(0, 3).map(Number).join('.'), '1.8.1')
  } catch {
    return false
  }
}
