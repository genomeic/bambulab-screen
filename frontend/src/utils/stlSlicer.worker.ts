/// <reference lib="webworker" />
/**
 * STL slicing runs here, off the main thread.
 *
 * Slicing is by far the slowest thing the app does: polyslice links the
 * segments of every layer with an O(n³) pass, and a detailed model can need
 * a minute or more of CPU (measured: 24k triangles over 140 mm ≈ 54 s on a
 * desktop at 0.2 mm layers). On the main thread that is an unresponsive app
 * and an ANR; in a worker it is a progress bar, and the job can be cancelled.
 *
 * Two details make this work:
 * - A worker has no `window`, but polyslice's browser build (and the helpers
 *   bundled into it) read three off `window.THREE`. Without the shim below
 *   they fall back to `require("three")` and throw. `threeGlobal` publishes
 *   three on the worker scope and is imported first, so it runs before
 *   polyslice's module body.
 * - Layer height is chosen to keep the layer count near TARGET_LAYERS. Slice
 *   time is essentially linear in layer count, and this is a preview — the
 *   animation reads the same at 0.8 mm layers as at 0.2 mm.
 */
import './threeGlobal'
import * as THREE from 'three'
import polyslice from '@jgphilpott/polyslice'
import { INFILL_PERCENT, layerHeightFor, loadStlGeometry } from './stlSliceParams'

const ctx = self as unknown as {
  postMessage: (msg: unknown) => void
  onmessage: ((e: MessageEvent) => void) | null
}

ctx.onmessage = async (e: MessageEvent) => {
  const buffer = e.data?.buffer as ArrayBuffer | undefined
  if (!buffer) {
    ctx.postMessage({ type: 'error', message: 'no data' })
    return
  }
  try {
    const { geometry, heightMm } = loadStlGeometry(buffer)
    const triangleCount = geometry.index
      ? Math.floor(geometry.index.count / 3)
      : Math.floor((geometry.attributes.position?.count ?? 0) / 3)
    const layerHeight = layerHeightFor(heightMm)
    // polyslice's own complexity metric (triangles x layers). Its thresholds
    // are calibrated for a desktop core; a phone core is 2-5x slower and
    // throttles under a sustained load, so warn earlier than it does.
    ctx.postMessage({
      type: 'info',
      score: triangleCount * Math.max(1, Math.ceil(heightMm / layerHeight)),
    })

    const { Polyslice } = polyslice
    let lastPercent = -1
    const slicer = new Polyslice({
      infillPattern: 'grid',
      infillDensity: INFILL_PERCENT,
      nozzleTemperature: 0,
      bedTemperature: 0,
      layerHeight,
      verbose: false,
      progressCallback: (info: {
        currentLayer?: number
        totalLayers?: number
        percent?: number
      }) => {
        const percent = info?.totalLayers
          ? Math.floor(((info.currentLayer ?? 0) / info.totalLayers) * 100)
          : Math.floor(info?.percent ?? 0)
        if (percent === lastPercent) return
        lastPercent = percent
        ctx.postMessage({ type: 'progress', percent })
      },
    })

    const gcode = slicer.slice(new THREE.Mesh(geometry))
    ctx.postMessage({
      type: 'done',
      gcode,
      layerHeight,
      triangleCount,
      heightMm: Math.round(heightMm * 10) / 10,
    })
  } catch (err: any) {
    ctx.postMessage({ type: 'error', message: err?.message ?? String(err) })
  }
}
