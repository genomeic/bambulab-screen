/**
 * Virtual timelapse helpers.
 *
 * G-code parsing and rendering live in the `gcode-preview` library (MIT,
 * https://github.com/xyz-tools/gcode-preview) — it handles Bambu Studio
 * conventions, arcs and renders real tube geometry with physical extrusion
 * widths. This module only keeps the synthetic sample used by the in-app
 * "sample" entry so the feature can be exercised without a printer.
 *
 * Sample conventions (mirroring Bambu Studio output):
 * - `; layer #N, Z = 0.2` marks a new layer
 * - `G1 X.. Y.. E..` extrudes (absolute E, monotonically increasing)
 * - infill runs at 0.5 mm spacing — close to real extrusion width — so the
 *   rendered surface reads as continuous beads
 */

/**
 * Generates a small synthetic G-code (a tapering vase tower, 120 layers)
 * used by the in-app sample entry so the feature can be exercised without
 * a printer.
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
  // Extruder position is absolute and must keep increasing — that is how
  // real G-code marks an extruding move.
  let e = 0
  for (let l = 0; l < layerCount; l++) {
    const z = (l + 1) * layerHeight
    // Vase silhouette: wide at the bottom, pinched in the middle, flared top.
    const radius = 22 + 13 * Math.sin((l / layerCount) * Math.PI * 1.6)
    lines.push(`; layer #${l + 1}, Z = ${z.toFixed(2)}`)
    // A real Z move per layer — viewers detect layer changes from Z, not
    // from the comment (gcode-preview groups on |ΔZ| > threshold).
    lines.push(`G0 Z${z.toFixed(2)} F10800`)
    lines.push(';TYPE:WALL-OUTER')
    const sides = 72
    const pts: [number, number][] = []
    for (let t = 0; t <= sides; t++) {
      const a = (t / sides) * Math.PI * 2
      pts.push([128 + radius * Math.cos(a), 128 + radius * Math.sin(a)])
    }
    lines.push(`G1 X${pts[0][0].toFixed(3)} Y${pts[0][1].toFixed(3)} F3000`)
    for (let i = 1; i < pts.length; i++) {
      e += 0.002
      lines.push(`G1 X${pts[i][0].toFixed(3)} Y${pts[i][1].toFixed(3)} E${e.toFixed(5)}`)
    }
    lines.push(';TYPE:FILL')
    // Horizontal infill lines clipped to the circle, 0.5 mm apart.
    const step = 0.5
    for (let d = -radius; d < radius; d += step) {
      const half = Math.sqrt(Math.max(radius * radius - d * d, 0))
      const y = 128 + d
      lines.push(`G1 X${(128 - half).toFixed(3)} Y${y.toFixed(3)} F6000`)
      e += 0.004
      lines.push(`G1 X${(128 + half).toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)}`)
    }
  }
  return lines.join('\n')
}
