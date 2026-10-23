/**
 * polyslice ships no type declarations and its ESM build only has a default
 * export. Only the entry point the timelapse uses is described here — the
 * rest of the API is intentionally left out so nothing else starts
 * depending on it.
 */
declare module '@jgphilpott/polyslice' {
  import type { Mesh } from 'three'

  export interface PolysliceOptions {
    infillPattern?: 'grid' | 'triangles' | 'hexagons'
    infillDensity?: number
    nozzleTemperature?: number
    bedTemperature?: number
    fanSpeed?: number
    layerHeight?: number
    verbose?: boolean
    [key: string]: unknown
  }

  class Polyslice {
    constructor(options?: PolysliceOptions)
    /** Slices a three.js mesh into G-code. */
    slice(mesh: Mesh): string
  }

  const api: {
    Polyslice: typeof Polyslice
    [key: string]: unknown
  }
  export default api
}
