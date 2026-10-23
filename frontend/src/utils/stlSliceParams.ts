/**
 * Shared tuning for the STL preview slice.
 *
 * These are preview settings, not print settings: the timelapse only needs
 * enough layers to animate convincingly, and every layer costs slice time
 * (polyslice links each layer's segments with an O(n³) pass) plus a batched
 * mesh to draw. Cutting the layer count is the one lever that moves both.
 */
import type * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

/** P1-series bed size in mm. */
export const BED = 256
/** Bambu Studio default infill density, in percent for polyslice. */
export const INFILL_PERCENT = 15
/**
 * Layer count a preview aims for. 180 still animates smoothly while keeping
 * a 140 mm model to ~45 s of slicing on a phone instead of ~90 s.
 */
export const TARGET_LAYERS = 180
export const MIN_LAYER_HEIGHT = 0.2
export const MAX_LAYER_HEIGHT = 1

/** Layer height that keeps a model of this height near TARGET_LAYERS. */
export const layerHeightFor = (heightMm: number): number => {
  const clamped = Math.min(
    MAX_LAYER_HEIGHT,
    Math.max(MIN_LAYER_HEIGHT, heightMm / TARGET_LAYERS),
  )
  return Math.round(clamped * 100) / 100
}

/** STL -> centred, plate-seated geometry, ready to slice. */
export const loadStlGeometry = (
  buffer: ArrayBuffer,
): { geometry: THREE.BufferGeometry; heightMm: number } => {
  const geometry = new STLLoader().parse(buffer)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) throw new Error('empty STL')
  const heightMm = box.max.z - box.min.z
  // STL coordinates are arbitrary and often sit around the origin, which
  // would otherwise leave the model half below z=0 or off in a corner.
  geometry.translate(
    BED / 2 - (box.min.x + box.max.x) / 2,
    BED / 2 - (box.min.y + box.max.y) / 2,
    -box.min.z,
  )
  return { geometry, heightMm }
}
