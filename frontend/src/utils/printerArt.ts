import p1Thumbnail from '../assets/images/studio_p1s.png'
import p1pThumbnail from '../assets/images/studio_p1p.png'
import p2sThumbnail from '../assets/images/studio_p2s.png'
import h2dThumbnail from '../assets/images/studio_h2d.png'
import h2sThumbnail from '../assets/images/studio_h2s.png'
import h2cThumbnail from '../assets/images/studio_h2c.png'
import a1Thumbnail from '../assets/images/studio_a1.png'
import a1MiniThumbnail from '../assets/images/studio_a1mini.png'
import x1cThumbnail from '../assets/images/studio_x1c.png'
import x1eThumbnail from '../assets/images/studio_x1e.png'
import p1Inside from '../assets/images/printer-inside.png'
import h2Hotend02 from '../assets/images/h2_hotend_02.webp'
import h2Hotend04 from '../assets/images/h2_hotend_04.webp'
import h2Hotend06 from '../assets/images/h2_hotend_06.webp'
import h2Hotend08 from '../assets/images/h2_hotend_08.webp'
import a1Toolhead from '../assets/images/a1_toolhead.webp'

const modelName = (model?: string) => (model ?? '').replace(/^Bambu Lab\s*/i, '')

/**
 * Official studio render (extracted from Bambu Studio's bundled resources,
 * 320x320 white background) matched to the printer model.
 */
export function printerThumbnail(model?: string): string {
  const name = modelName(model)
  if (/^H2D/.test(name)) return h2dThumbnail   // H2D / H2D Pro
  if (/^H2S/.test(name)) return h2sThumbnail
  if (/^H2/.test(name)) return h2cThumbnail    // H2C
  if (/^A1 Mini/.test(name)) return a1MiniThumbnail
  if (/^A[12]/.test(name)) return a1Thumbnail  // A1 / A2L
  if (/^P1P/.test(name)) return p1pThumbnail
  if (/^P2S/.test(name)) return p2sThumbnail
  if (/^X1E/.test(name)) return x1eThumbnail
  if (/^X1/.test(name)) return x1cThumbnail    // X1 / X1 Carbon
  return p1Thumbnail                           // P1S / P1P fallback default
}

/**
 * Nozzle/extruder indicator artwork matched to the printer model.
 * - H2 series: official quick-swap hotend renders (from Bambu Handy), chosen
 *   dynamically by the reported nozzle diameter (defaults to HF 0.4).
 * - A1 series: official toolhead photo (from the Bambu Lab wiki).
 * Other models return '' so the caller keeps its state-based P1 toolhead
 * indicators.
 */
export function nozzleIndicatorImage(model?: string, nozzleDiameter?: number | string): string {
  const name = modelName(model)
  if (/^H2/.test(name)) {
    const d = Math.round(Number(nozzleDiameter ?? 0.4) * 10) / 10
    if (d === 0.2) return h2Hotend02
    if (d === 0.6) return h2Hotend06
    if (d === 0.8) return h2Hotend08
    return h2Hotend04
  }
  if (/^A[12]/.test(name)) return a1Toolhead
  return ''
}

/**
 * Control-page background artwork. Only P1 has the purpose-made translucent
 * interior photo; other models return '' (no background) so the rectangular
 * product photo doesn't fight with the control cards.
 */
export function printerInsideImage(model?: string): string {
  const name = modelName(model)
  if (/^P[12]/.test(name)) return p1Inside
  return ''
}
