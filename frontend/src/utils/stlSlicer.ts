/**
 * STL support for the virtual timelapse.
 *
 * An STL is a triangle soup — no layers, no extrusion paths — so it has to
 * be sliced before the timelapse pipeline can render it. Slicing is done by
 * polyslice (MIT, https://github.com/jgphilpott/polyslice), a pure-JS FDM
 * slicer that takes a three.js mesh and returns G-code. (The alternative,
 * three-slicer, is an OrcaSlicer WASM port — it is AGPL and ~19 MB, which
 * rules it out for a shipped app.)
 *
 * The result is a *preview* slice, not a print-ready file: 15% grid infill
 * at 0.2 mm layers, no supports, no brim. That is all the timelapse needs.
 *
 * Two constraints shape how polyslice is loaded:
 *
 * 1. Only its **browser** build may be used. The default (Node) ESM build
 *    keeps `@jgphilpott/polyconvert` external and `require()`s it, which
 *    throws "Dynamic require ... is not supported" at runtime — and because
 *    that ran from the entry chunk it took down the whole app (black
 *    screen). `dist/index.browser.esm.js` inlines its dependencies instead.
 *    `vite.config.ts` aliases the bare specifier to that file.
 * 2. It is imported **lazily**. Slicing is the heaviest thing this app does
 *    and is only needed for STL, so it lives in its own chunk: loading a
 *    slicer must never be able to break the app for everyone else.
 */
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

/** P1-series bed size in mm. */
const BED = 256
/** Bambu Studio default infill density, in percent for polyslice. */
const INFILL_PERCENT = 15

/**
 * Reads an STL (binary or ASCII) and slices it into G-code.
 *
 * The mesh is centred on the bed and dropped onto the plate first: STL
 * coordinates are arbitrary and often sit around the origin, which would
 * otherwise leave the model half below z=0 or off in a corner.
 */
export const sliceStl = async (data: Uint8Array): Promise<string> => {
  // STLLoader wants an ArrayBuffer; a Uint8Array view into a larger buffer
  // would silently parse the wrong range, so copy first.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer
  const geometry = new STLLoader().parse(buffer)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) throw new Error('empty STL')
  geometry.translate(
    BED / 2 - (box.min.x + box.max.x) / 2,
    BED / 2 - (box.min.y + box.max.y) / 2,
    -box.min.z,
  )

  // polyslice's bundled helpers (polytree, three-subdivide) read three off
  // `window` in the browser build; expose it before the chunk evaluates.
  ;(window as unknown as { THREE?: typeof THREE }).THREE = THREE
  const mod = await import('@jgphilpott/polyslice')
  const { Polyslice } = mod.default

  const slicer = new Polyslice({
    infillPattern: 'grid',
    infillDensity: INFILL_PERCENT,
    nozzleTemperature: 0,
    bedTemperature: 0,
    // otherwise it console.logs a progress bar per layer
    verbose: false,
  })
  return slicer.slice(new THREE.Mesh(geometry))
}
