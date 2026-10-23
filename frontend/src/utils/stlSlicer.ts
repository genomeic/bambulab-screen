/**
 * STL support for the virtual timelapse — main-thread side.
 *
 * An STL is a triangle soup: no layers, no extrusion paths, so it has to be
 * sliced before the timelapse pipeline can render it. Slicing is done by
 * polyslice (MIT, https://github.com/jgphilpott/polyslice), a pure-JS FDM
 * slicer that takes a three.js mesh and returns G-code. (The alternative,
 * three-slicer, is an OrcaSlicer WASM port — it is AGPL and ~19 MB, which
 * rules it out for a shipped app.)
 *
 * The result is a *preview* slice, not a print-ready file: grid infill, no
 * supports, no brim, and a layer height chosen to keep the layer count
 * reasonable. That is all the timelapse needs.
 *
 * Slicing happens in `stlSlicer.worker.ts`. It has to: on the main thread a
 * detailed model blocks for minutes, which is an unresponsive app and an
 * ANR. The worker keeps the UI alive, reports progress and can be cancelled.
 */
import './threeGlobal'
import * as THREE from 'three'
import { INFILL_PERCENT, layerHeightFor, loadStlGeometry } from './stlSliceParams'

/** The worker for the slice in flight, if any. */
let worker: Worker | null = null

/** Abandons the slice in flight. Safe to call when nothing is running. */
export const cancelStlSlice = (): void => {
  worker?.terminate()
  worker = null
}

/** Same job as the worker, on the main thread — only a fallback. */
const sliceInline = async (
  data: Uint8Array,
  onProgress?: (percent: number) => void,
): Promise<string> => {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer
  const { geometry, heightMm } = loadStlGeometry(buffer)

  // `threeGlobal` (imported at the top of this module) has already published
  // three as window.THREE, which polyslice's bundled helpers read.
  const mod = await import('@jgphilpott/polyslice')
  const { Polyslice } = mod.default

  let lastPercent = -1
  const slicer = new Polyslice({
    infillPattern: 'grid',
    infillDensity: INFILL_PERCENT,
    nozzleTemperature: 0,
    bedTemperature: 0,
    layerHeight: layerHeightFor(heightMm),
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
      onProgress?.(percent)
    },
  })
  return slicer.slice(new THREE.Mesh(geometry))
}

/**
 * Reads an STL (binary or ASCII) and slices it into G-code.
 *
 * The mesh is centred on the bed and dropped onto the plate first: STL
 * coordinates are arbitrary and often sit around the origin, which would
 * otherwise leave the model half below z=0 or off in a corner.
 *
 * @param onProgress receives 0-100 while polyslice works through the layers.
 */
export const sliceStl = async (
  data: Uint8Array,
  onProgress?: (percent: number) => void,
): Promise<string> => {
  if (typeof Worker === 'undefined') return sliceInline(data, onProgress)

  // Copy into a standalone buffer before handing it over: the view may sit
  // inside a larger buffer, and only ArrayBuffers survive structured clone.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer

  cancelStlSlice()
  const w = new Worker(new URL('./stlSlicer.worker.ts', import.meta.url))
  worker = w

  return new Promise<string>((resolve, reject) => {
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data ?? {}
      if (msg.type === 'progress') {
        onProgress?.(msg.percent)
        return
      }
      if (msg.type === 'done') {
        cancelStlSlice()
        resolve(msg.gcode as string)
        return
      }
      cancelStlSlice()
      reject(new Error((msg.message as string) || 'slice failed'))
    }
    w.onerror = (e: ErrorEvent) => {
      cancelStlSlice()
      reject(new Error(e.message || 'slicer crashed'))
    }
    w.postMessage({ buffer }, [buffer])
  })
}
