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
 * - default-slice structure: solid top/bottom shells, 15% sparse infill
 *   between them, alternating 45°/135° like real rectilinear infill
 */

/**
 * Generates a small synthetic G-code (a tapering vase tower, 120 layers)
 * used by the in-app sample entry so the feature can be exercised without
 * a printer. Mirrors Bambu Studio default slicing: two-perimeter walls,
 * solid top/bottom shells, and 15% sparse infill in between.
 */
export const generateSampleGcode = (): string => {
  const lines: string[] = [
    '; generated sample for timelapse preview',
    'G28',
    'G92 E0',
  ]
  const layerCount = 120
  const layerHeight = 0.24
  /** Solid shell layers at the bottom and top, like a default slice. */
  const SHELL_LAYERS = 3
  /** Extrusion width in mm — infill density = width / spacing. */
  const LINE_WIDTH = 0.42
  /** Bambu Studio's default infill density. */
  const INFILL_DENSITY = 0.15
  const INFILL_SPACING = LINE_WIDTH / INFILL_DENSITY
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
    const shell = l < SHELL_LAYERS || l >= layerCount - SHELL_LAYERS
    if (shell) {
      // Solid shell layers — 0.5 mm line spacing reads as a continuous
      // surface, like a real top/bottom skin.
      const step = 0.5
      for (let d = -radius; d < radius; d += step) {
        const half = Math.sqrt(Math.max(radius * radius - d * d, 0))
        const y = 128 + d
        lines.push(`G1 X${(128 - half).toFixed(3)} Y${y.toFixed(3)} F6000`)
        e += 0.004
        lines.push(`G1 X${(128 + half).toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)}`)
      }
    } else {
      // Sparse infill at the default 15% density: straight lines alternating
      // 45°/135° between layers, each clipped to the cross-section circle.
      const diag = l % 2 === 0
      const cMax = radius * Math.SQRT2
      for (let c = -cMax; c <= cMax; c += INFILL_SPACING * Math.SQRT2) {
        const t = Math.sqrt(Math.max(radius * radius - (c * c) / 2, 0))
        const u = t / Math.SQRT2
        // 45°: (c/2, -c/2) ± (u, u); 135°: (c/2, c/2) ± (u, -u)
        const px = 128 + c / 2
        const py = 128 + (diag ? -c / 2 : c / 2)
        const vx = u
        const vy = diag ? u : -u
        lines.push(`G1 X${(px + vx).toFixed(3)} Y${(py + vy).toFixed(3)} F6000`)
        e += 0.004
        lines.push(`G1 X${(px - vx).toFixed(3)} Y${(py - vy).toFixed(3)} E${e.toFixed(5)}`)
      }
    }
  }
  return lines.join('\n')
}
