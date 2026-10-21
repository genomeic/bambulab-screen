/**
 * Recolors the baked-in green filament strand of the extruder illustrations so
 * it matches the filament that is actually loaded.
 *
 * The artwork ships with a fixed green strand; instead of bundling one image
 * per colour we rewrite the hue of the green pixels at runtime and keep the
 * original lightness/saturation structure, so highlights and shadows survive.
 */

type Hsl = { h: number, s: number, l: number }

const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<string>>()

/** Accepts 'RRGGBBAA' (Bambu tray_color) or '#RRGGBB'/'RRGGBB'. */
const parseColor = (value: string): { r: number, g: number, b: number } | null => {
  const raw = String(value ?? '').trim().replace(/^#/, '')
  if (raw.length < 6) return null
  const hex = raw.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

const rgbToHsl = (r: number, g: number, b: number): Hsl => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0))
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

const hueToRgb = (p: number, q: number, tIn: number) => {
  let t = tIn
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

const hslToRgb = (h: number, s: number, l: number) => {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hn = h / 360
  return {
    r: Math.round(hueToRgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hn) * 255),
    b: Math.round(hueToRgb(p, q, hn - 1 / 3) * 255),
  }
}

/**
 * True for the green strand pixels of the stock artwork. Hue-based because the
 * strand's dark olive shades (e.g. rgb(104,125,86)) fail channel-ratio tests,
 * while the gray printer body stays far below the saturation threshold.
 */
const isFilamentPixel = (r: number, g: number, b: number, a: number) => {
  if (a <= 10) return false
  const { h, s, l } = rgbToHsl(r, g, b)
  return s > 0.08 && l < 0.93 && h >= 60 && h <= 180
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('image load failed'))
  image.src = src
})

/**
 * Returns a data URL of `src` with the green strand repainted in `color`
 * (Bambu `tray_color`, e.g. "00CC66FF"). Falls back to `src` when the colour is
 * missing, already green, or when canvas access fails.
 */
export const tintFilamentImage = async (src: string, color: string): Promise<string> => {
  const target = parseColor(color)
  if (!src || !target) return src

  const targetHsl = rgbToHsl(target.r, target.g, target.b)
  // The artwork is already green - skip the whole pixel pass in that case.
  const artworkGreen = rgbToHsl(162, 249, 96)
  if (targetHsl.s > 0.25 && Math.abs(targetHsl.h - artworkGreen.h) < 12) return src

  const key = `${src}|${target.r},${target.g},${target.b}`
  const cached = cache.get(key)
  if (cached) return cached
  const existing = inFlight.get(key)
  if (existing) return existing

  const task = (async () => {
    try {
      const image = await loadImage(src)
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      if (!width || !height) return src
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return src
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, width, height)
      const pixels = data.data

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i]
        const g = pixels[i + 1]
        const b = pixels[i + 2]
        const a = pixels[i + 3]
        if (!isFilamentPixel(r, g, b, a)) continue
        const srcHsl = rgbToHsl(r, g, b)
        // Keep the shading of the artwork, adopt the target hue. Saturation is
        // scaled by the target's (so white/gray filament stays neutral) and
        // lightness leans towards the target (so black filament stays dark).
        const next = hslToRgb(
          targetHsl.h,
          srcHsl.s * Math.sqrt(targetHsl.s),
          Math.min(1, srcHsl.l * (0.25 + 0.75 * targetHsl.l))
        )
        pixels[i] = next.r
        pixels[i + 1] = next.g
        pixels[i + 2] = next.b
      }

      context.putImageData(data, 0, 0)
      const url = canvas.toDataURL('image/png')
      cache.set(key, url)
      return url
    } catch {
      return src
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, task)
  return task
}
