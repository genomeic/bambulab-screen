/**
 * Virtual timelapse: parses a Bambu-style G-code into per-layer extrusion
 * paths so the print process can be replayed as an animation without a
 * camera. Pure frontend, no printer communication.
 *
 * Bambu Studio G-code conventions relied upon:
 * - `; layer #N, Z = 0.2` marks a new layer
 * - `;TYPE:WALL-OUTER` / `WALL-INNER` / `FILL` / `SUPPORT` ... marks path type
 * - `G1 X.. Y.. E..` extrudes when the E value increases
 */

export type TimelapsePathType = 'outer' | 'inner' | 'fill' | 'support' | 'other'

export interface TimelapseLayer {
  z: number
  /** Flat point arrays per path type: [x0,y0,x1,y1, NaN,NaN, x0,y0,x1,y1, ...].
   *  NaN separates disconnected paths. */
  segs: Partial<Record<TimelapsePathType, number[]>>
}

export interface TimelapseModel {
  layers: TimelapseLayer[]
  minX: number
  maxX: number
  minY: number
  maxY: number
  maxZ: number
}

const TYPE_MAP: Record<string, TimelapsePathType> = {
  'WALL-OUTER': 'outer',
  'WALL-INNER': 'inner',
  FILL: 'fill',
  'SOLIDFILL': 'fill',
  'TOP-SURFACE': 'fill',
  'BOTTOM-SURFACE': 'fill',
  'BRIDGE-FILL': 'fill',
  'IRONING': 'fill',
  SUPPORT: 'support',
  'SOLIDSUPPORT': 'support',
  'TREE-SUPPORT': 'support',
  SKIRT: 'other',
  BRIM: 'other',
  PURGE: 'other',
  WIPE: 'other',
}

const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Parses the numeric value of a G-code word like X12.5 / E-0.001. */
const wordValue = (line: string, letter: string): number | undefined => {
  const idx = line.indexOf(letter)
  if (idx < 0) return undefined
  // Make sure the letter is not part of another word (e.g. "E" in "FEED").
  if (idx > 0) {
    const prev = line[idx - 1]
    if ((prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z')) return undefined
  }
  const rest = line.slice(idx + 1)
  const match = /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(rest)
  return match ? parseFloat(match[0]) : undefined
}

interface ParseState {
  layers: TimelapseLayer[]
  curType: TimelapsePathType
  layer: TimelapseLayer | null
  x: number
  y: number
  z: number
  e: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  maxZ: number
}

const appendSeg = (state: ParseState, nx: number, ny: number) => {
  const layer = state.layer
  if (!layer) return
  const arr = (layer.segs[state.curType] ??= [])
  arr.push(state.x, state.y, nx, ny)
  if (state.minX > Math.min(state.x, nx)) state.minX = Math.min(state.x, nx)
  if (state.maxX < Math.max(state.x, nx)) state.maxX = Math.max(state.x, nx)
  if (state.minY > Math.min(state.y, ny)) state.minY = Math.min(state.y, ny)
  if (state.maxY < Math.max(state.y, ny)) state.maxY = Math.max(state.y, ny)
}

const newState = (): ParseState => ({
  layers: [],
  curType: 'other',
  layer: null,
  x: 0,
  y: 0,
  z: 0,
  e: 0,
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
  maxZ: 0,
})

const parseLine = (state: ParseState, line: string) => {
  if (line.charCodeAt(0) === 59 /* ; */) {
    if (line.startsWith('; layer') || line.startsWith(';LAYER_CHANGE')) {
      const zMatch = /Z\s*=\s*([-+]?[0-9]*\.?[0-9]+)/.exec(line)
      if (zMatch) state.z = parseFloat(zMatch[1])
      state.layer = { z: state.z, segs: {} }
      state.layers.push(state.layer)
      if (state.maxZ < state.z) state.maxZ = state.z
      return
    }
    if (line.startsWith(';TYPE:')) {
      state.curType = TYPE_MAP[line.slice(6).trim().toUpperCase()] ?? 'other'
      return
    }
    return
  }
  // G92 E0 resets the extruder origin — must run before the move filter,
  // otherwise absolute E tracking desyncs after every layer change.
  if (/^G92\b/.test(line)) {
    if (wordValue(line, 'E') !== undefined) state.e = 0
    return
  }
  // G0/G1/G2/G3 — G2/G3 arcs are approximated by their endpoint.
  if (!/^[GM]\s*[01]/.test(line) && !/^[GM][123]\b/.test(line)) return
  const g = /^G([01])\b/.exec(line)
  const arc = /^G([23])\b/.exec(line)
  if (!g && !arc) return
  const nx = wordValue(line, 'X')
  const ny = wordValue(line, 'Y')
  const nz = wordValue(line, 'Z')
  const ne = wordValue(line, 'E')
  if (nz !== undefined) state.z = nz
  const extruding = ne !== undefined && ne > state.e + 1e-6
  if (nx !== undefined || ny !== undefined) {
    const tx = nx ?? state.x
    const ty = ny ?? state.y
    if (extruding && (nx !== state.x || ny !== state.y)) {
      appendSeg(state, tx, ty)
    }
    state.x = tx
    state.y = ty
  }
  if (ne !== undefined) state.e = ne
}

/**
 * Parses G-code into layers, yielding to the UI thread between chunks so
 * large files (10+ MB) do not freeze the interface.
 */
export const parseGcodeTimelapse = async (
  text: string,
  onProgress?: (progress: number) => void,
  chunkChars = 512 * 1024,
): Promise<TimelapseModel> => {
  const state = newState()
  let pos = 0
  while (pos < text.length) {
    let end = Math.min(pos + chunkChars, text.length)
    if (end < text.length) {
      const nl = text.indexOf('\n', end)
      end = nl === -1 ? text.length : nl + 1
    }
    const chunk = text.slice(pos, end)
    pos = end
    const lines = chunk.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line) parseLine(state, line)
    }
    onProgress?.(pos / text.length)
    await yieldToUI()
  }
  const model: TimelapseModel = {
    layers: state.layers,
    minX: state.minX,
    maxX: state.maxX,
    minY: state.minY,
    maxY: state.maxY,
    maxZ: state.maxZ,
  }
  if (!Number.isFinite(model.minX)) {
    model.minX = 0
    model.maxX = 1
    model.minY = 0
    model.maxY = 1
  }
  return model
}

/** Total number of extruded points — used for uniform layer interpolation. */
export const layerPointCount = (layer: TimelapseLayer): number => {
  let n = 0
  for (const key of Object.keys(layer.segs) as TimelapsePathType[]) {
    n += (layer.segs[key]?.length ?? 0) / 4
  }
  return n
}

/**
 * Generates a small synthetic G-code (a tapering vase tower) used by the
 * in-app sample entry so the feature can be exercised without a printer.
 * Fills run at 0.5 mm spacing — close to real extrusion width — so the
 * rendered surface looks continuous.
 */
export const generateSampleGcode = (): string => {
  const lines: string[] = [
    '; generated sample for timelapse preview',
    'G28',
    'G92 E0',
    'G1 Z0.2 F600',
  ]
  const layerCount = 120
  const layerHeight = 0.24
  for (let l = 0; l < layerCount; l++) {
    const z = (l + 1) * layerHeight
    // Vase silhouette: wide at the bottom, pinched in the middle, flared top.
    const radius = 30 + 16 * Math.sin((l / layerCount) * Math.PI * 1.6)
    lines.push(`; layer #${l + 1}, Z = ${z.toFixed(2)}`)
    lines.push(';TYPE:WALL-OUTER')
    const sides = 72
    const pts: [number, number][] = []
    for (let t = 0; t <= sides; t++) {
      const a = (t / sides) * Math.PI * 2
      pts.push([128 + radius * Math.cos(a), 128 + radius * Math.sin(a)])
    }
    lines.push(`G1 X${pts[0][0].toFixed(3)} Y${pts[0][1].toFixed(3)} F3000`)
    for (let i = 1; i < pts.length; i++) {
      lines.push(`G1 X${pts[i][0].toFixed(3)} Y${pts[i][1].toFixed(3)} E${(0.05 + i * 0.002).toFixed(5)}`)
    }
    lines.push(';TYPE:FILL')
    // Horizontal infill lines clipped to the circle, 0.5 mm apart.
    const step = 0.5
    for (let d = -radius; d < radius; d += step) {
      const half = Math.sqrt(Math.max(radius * radius - d * d, 0))
      const y = 128 + d
      lines.push(`G1 X${(128 - half).toFixed(3)} Y${y.toFixed(3)} F6000`)
      lines.push(`G1 X${(128 + half).toFixed(3)} Y${y.toFixed(3)} E0.004`)
    }
  }
  return lines.join('\n')
}
