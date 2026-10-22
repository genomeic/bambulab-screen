<template>
  <BasePage :title="t('tl_gen_title')">
    <div class="tl-gen">
      <div class="tl-stage">
        <canvas ref="canvasEl" class="tl-canvas" />
        <div v-if="phase === 'loading'" class="tl-overlay">
          <van-loading size="24" />
          <div class="tl-overlay-text">{{ loadingText }}</div>
        </div>
        <div v-else-if="phase === 'error'" class="tl-overlay">
          <van-icon name="warning-o" size="28" />
          <div class="tl-overlay-text">{{ errorText }}</div>
        </div>
      </div>

      <div class="tl-meta">
        <span class="tl-name">{{ fileName }}</span>
        <span v-if="model" class="tl-layers">{{ t('tl_gen_layers', { count: model.layers.length }) }}</span>
        <van-tag v-if="isSample" size="medium" type="warning">{{ t('tl_gen_sample') }}</van-tag>
      </div>

      <div class="tl-controls">
        <van-button
          round
          type="primary"
          size="small"
          :disabled="!model"
          :icon="playing ? 'pause' : 'play'"
          @click="togglePlay"
        >
          {{ playing ? t('tl_gen_pause') : t('tl_gen_play') }}
        </van-button>
        <van-slider
          v-model="progressPct"
          class="tl-slider"
          :disabled="!model"
          bar-height="4"
          @change="onSliderChange"
        />
      </div>

      <div class="tl-durations">
        <span class="tl-durations-label">{{ t('tl_gen_duration') }}</span>
        <van-tag
          v-for="d in DURATIONS"
          :key="d"
          size="medium"
          :type="durationSec === d ? 'primary' : 'default'"
          clickable
          @click="durationSec = d"
        >
          {{ d }}s
        </van-tag>
      </div>

      <van-button
        class="tl-export"
        round
        block
        type="primary"
        :loading="exporting"
        :disabled="!model"
        @click="exportVideo"
      >
        {{ exporting ? t('tl_gen_exporting') : t('tl_gen_export') }}
      </van-button>
    </div>
  </BasePage>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { unzipSync } from 'fflate'
import { FTPSClient } from '@bambulab-p1screen/printer-api'
import { createFtpUrl } from '../../printer'
import { getCurrentDevice } from '../../utils/device'
import {
  generateSampleGcode,
  layerPointCount,
  parseGcodeTimelapse,
  type TimelapseLayer,
  type TimelapseModel,
  type TimelapsePathType,
} from '../../utils/gcodeTimelapse'
import BasePage from '../../components/BasePage.vue'
import { usePrinterStore } from '../../stores/printer'

const { device } = usePrinterStore()

const { t } = useI18n()
const route = useRoute()

const DURATIONS = [8, 15, 30]

type Phase = 'loading' | 'ready' | 'error'
const phase = ref<Phase>('loading')
const loadingText = ref('')
const errorText = ref('')
const fileName = ref('')
const isSample = ref(false)
const model = ref<TimelapseModel | null>(null)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const progressPct = ref(0)
const playing = ref(false)
const durationSec = ref(15)
const exporting = ref(false)

/**
 * Camera model: a fixed camera above the printer looking down, tilted just
 * enough to see the sides — exactly how a real timelapse is shot. Screen
 * mapping is sx = x, sy = y*cos + z*sin with TILT ≈ 22°.
 */
const TILT = (22 * Math.PI) / 180
const COS = Math.cos(TILT)
const SIN = Math.sin(TILT)

/** Filament colour from the current tray ('RRGGBBAA' Bambu format). */
const filamentColor = (): string => {
  const tray = (device.value as any)?.ams?.ams?.[0]?.tray?.[0]
  const raw: string | undefined = tray?.tray_color
  if (raw && /^[0-9a-fA-F]{8}$/.test(raw)) {
    const r = parseInt(raw.slice(0, 2), 16)
    const g = parseInt(raw.slice(2, 4), 16)
    const b = parseInt(raw.slice(4, 6), 16)
    // Keep some luminance range so shading still reads.
    return `rgb(${r}, ${g}, ${b})`
  }
  return '#2f6fd0'
}

/** Mixes a colour toward white by amount 0..1. */
const tint = (color: string, amount: number): string => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  if (!m) return color
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  return `rgb(${mix(Number(m[1]))}, ${mix(Number(m[2]))}, ${mix(Number(m[3]))})`
}

/** Mixes a colour toward black by amount 0..1. */
const shade = (color: string, amount: number): string => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  if (!m) return color
  const f = 1 - amount
  const r = Math.round(Number(m[1]) * f)
  const g = Math.round(Number(m[2]) * f)
  const b = Math.round(Number(m[3]) * f)
  return `rgb(${r}, ${g}, ${b})`
}

/** Top-face colour — refreshed from the current tray when a file opens. */
let TOP_COLOR = '#2f6fd0'
/** Rim / fresh-bead colour — a light tint of the filament. */
let RIM_COLOR = '#8fb4f5'

interface View {
  scale: number
  zScale: number
  offX: number
  offY: number
  w: number
  h: number
  dpr: number
  /** Model centre in bed coordinates — gradient anchor for side walls. */
  centerX: number
  centerY: number
}

let view: View | null = null
let offscreen: HTMLCanvasElement | null = null
/** Layer index already baked into the offscreen canvas. */
let bakedLayers = 0
let raf = 0
/** Playback anchor: progress at the time the current rAF run started. */
let anchorPct = 0
let anchorTime = 0

const ctxOf = (canvas: HTMLCanvasElement) => canvas.getContext('2d')!

/**
 * Physical proportions: z scales exactly like x/y — a 0.24 mm layer is a
 * hairline on screen, which is what a top-down timelapse actually shows.
 */
const computeView = (m: TimelapseModel, canvas: HTMLCanvasElement): View => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth
  const h = Math.round(w * 0.78)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.height = `${h}px`
  const c = ctxOf(canvas)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)

  const margin = 12
  const scale = Math.min((w - margin * 2) / 256, (h - margin * 2) / (256 * COS + 90 * SIN))
  return {
    scale,
    zScale: 1,
    offX: w / 2 - 128 * scale,
    offY: h / 2 - (128 * COS) * scale,
    w,
    h,
    dpr,
    centerX: (m.minX + m.maxX) / 2,
    centerY: (m.minY + m.maxY) / 2,
  }
}

const sx = (v: View, x: number) => v.offX + x * v.scale
const sy = (v: View, y: number, z: number) => v.offY + (y * COS + z * SIN) * v.scale

const drawBed = (c: CanvasRenderingContext2D, v: View) => {
  // Bed plate.
  c.fillStyle = '#14161b'
  c.fillRect(sx(v, 0), sy(v, 0, 0), 256 * v.scale, 256 * COS * v.scale)
  // Faint grid, like the PEI plate pattern under print-cam light.
  c.strokeStyle = 'rgba(148, 163, 184, 0.07)'
  c.lineWidth = 1
  c.beginPath()
  for (let g = 32; g < 256; g += 32) {
    c.moveTo(sx(v, g), sy(v, 0, 0))
    c.lineTo(sx(v, g), sy(v, 256, 0))
    c.moveTo(sx(v, 0), sy(v, g, 0))
    c.lineTo(sx(v, 256), sy(v, g, 0))
  }
  c.stroke()
  // Bed edge.
  c.strokeStyle = 'rgba(148, 163, 184, 0.28)'
  c.strokeRect(sx(v, 0), sy(v, 0, 0), 256 * v.scale, 256 * COS * v.scale)
}

/**
 * Draws one layer: solid top face from the outer contour, extrusion lines
 * as texture, and (while growing) a bright rim so the newest layer reads
 * as "being printed right now". Returns the last point drawn — the nozzle
 * position for toolhead rendering.
 */
const drawLayerSolid = (
  c: CanvasRenderingContext2D,
  v: View,
  layer: TimelapseLayer,
  maxSegs: number,
  complete: boolean,
): { x: number; y: number } | null => {
  const z1 = layer.z
  const outer = layer.segs.outer
  const others = (Object.keys(layer.segs) as TimelapsePathType[]).filter(k => k !== 'outer')
  let last: { x: number; y: number } | null = null

  // Solid top face from the outer contour.
  if (outer) {
    c.beginPath()
    let started = false
    const limit = Math.min(outer.length / 4, maxSegs)
    for (let i = 0, s = 0; s < limit; i += 4, s++) {
      const px = sx(v, outer[i])
      const py = sy(v, outer[i + 1], z1)
      if (!started) {
        c.moveTo(px, py)
        started = true
      } else {
        c.lineTo(px, py)
      }
      last = { x: outer[i], y: outer[i + 1] }
    }
    if (complete) {
      c.closePath()
      // Same-colour stroke first: fills anti-alias their edge against
      // transparency, and stacked layer edges would accumulate into faint
      // rings. The stroke seals them.
      c.strokeStyle = TOP_COLOR
      c.lineWidth = 1
      c.stroke()
      c.fillStyle = TOP_COLOR
      c.fill()
    } else {
      // Growing layer: bright rim along the outline.
      c.strokeStyle = RIM_COLOR
      c.lineWidth = 2
      c.lineJoin = 'round'
      c.lineCap = 'round'
      c.stroke()
    }
  }

  // Extrusion texture — every layer, faint: a top-down timelapse shows the
  // extrusion lines on every exposed surface, strongest on the top layer.
  const strength = complete ? 0.5 : 1
  let quota = maxSegs
  for (const key of others) {
    const pts = layer.segs[key]
    if (!pts || quota <= 0) continue
    const available = pts.length / 4
    const take = Math.min(available, quota)
    c.strokeStyle =
      key === 'support'
        ? `rgba(255, 214, 130, ${0.4 * strength})`
        : `rgba(255, 255, 255, ${0.22 * strength})`
    c.lineWidth = Math.max(0.5 * v.scale, 1.1)
    c.lineCap = 'round'
    c.beginPath()
    for (let i = 0, s = 0; s < take; i += 4, s++) {
      c.moveTo(sx(v, pts[i]), sy(v, pts[i + 1], z1))
      c.lineTo(sx(v, pts[i + 2]), sy(v, pts[i + 3], z1))
    }
    c.stroke()
    quota -= take
    if (take < available) break
  }
  return last
}

/**
 * Continuous side wall of the printed stack: the outer contour extruded
 * from the bed up to the top baked layer, filled with one vertical
 * gradient. front=false draws the half behind the print (covered by the
 * top faces), front=true the half in front (visible) — caller draws the
 * front half after the top faces.
 */
const drawSkirt = (
  c: CanvasRenderingContext2D,
  v: View,
  m: TimelapseModel,
  topIndex: number,
  front: boolean,
) => {
  const top = m.layers[Math.max(Math.min(topIndex, m.layers.length - 1), 0)]
  const outer = top?.segs.outer
  if (!outer) return
  const z1 = top.z
  const yBottom = sy(v, v.centerY, 0)
  const yTop = sy(v, v.centerY, z1)
  const grad = c.createLinearGradient(0, yBottom, 0, yTop)
  grad.addColorStop(0, shade(TOP_COLOR, 0.62))
  grad.addColorStop(1, shade(TOP_COLOR, 0.3))
  c.fillStyle = grad
  c.beginPath()
  for (let i = 0; i + 3 < outer.length; i += 4) {
    // Split by whether the segment's midpoint sits in front of / behind
    // the model centre (screen-up is -y).
    const mid = (outer[i + 1] + outer[i + 3]) / 2
    if (mid > v.centerY !== front) continue
    c.moveTo(sx(v, outer[i]), sy(v, outer[i + 1], 0))
    c.lineTo(sx(v, outer[i + 2]), sy(v, outer[i + 3], 0))
    c.lineTo(sx(v, outer[i + 2]), sy(v, outer[i + 3], z1))
    c.lineTo(sx(v, outer[i]), sy(v, outer[i + 1], z1))
    c.closePath()
  }
  c.fill()
}

/**
 * The toolhead: extruder body riding above the nozzle, a drop shadow on
 * the print, and the hot-end tip at the extrusion point. This is what
 * makes the frame read as a real print-cam shot.
 */
const drawToolhead = (c: CanvasRenderingContext2D, v: View, x: number, y: number, z: number) => {
  const nx = sx(v, x)
  const ny = sy(v, y, z)
  // Shadow cast onto the print below.
  c.fillStyle = 'rgba(0, 0, 0, 0.35)'
  c.beginPath()
  c.ellipse(nx + 3 * v.scale, ny + 4 * v.scale, 20 * v.scale, 9 * v.scale, 0, 0, Math.PI * 2)
  c.fill()
  // Extruder body — sits behind (above on screen) the nozzle. The P1
  // extruder is a wide carriage, wider than it is deep.
  const bx = nx
  const by = ny - 18 * v.scale
  const bw = 46 * v.scale
  const bh = 16 * v.scale
  c.fillStyle = '#aeb4bd'
  c.strokeStyle = '#6b7280'
  c.lineWidth = 1
  c.beginPath()
  if (typeof c.roundRect === 'function') {
    c.roundRect(bx - bw / 2, by - bh / 2, bw, bh, 3 * v.scale)
  } else {
    c.rect(bx - bw / 2, by - bh / 2, bw, bh)
  }
  c.fill()
  c.stroke()
  // Fan + motor detail.
  c.fillStyle = '#4b5563'
  c.beginPath()
  c.arc(bx - 9 * v.scale, by, 4 * v.scale, 0, Math.PI * 2)
  c.arc(bx + 9 * v.scale, by, 4 * v.scale, 0, Math.PI * 2)
  c.fill()
  // Hot end + nozzle tip at the extrusion point.
  c.fillStyle = '#d1d5db'
  c.beginPath()
  c.moveTo(nx - 3 * v.scale, ny - 8 * v.scale)
  c.lineTo(nx + 3 * v.scale, ny - 8 * v.scale)
  c.lineTo(nx + 1.4 * v.scale, ny)
  c.lineTo(nx - 1.4 * v.scale, ny)
  c.closePath()
  c.fill()
  // Freshly extruded bead glowing at the tip.
  c.fillStyle = RIM_COLOR
  c.beginPath()
  c.arc(nx, ny, 1.6 * v.scale, 0, Math.PI * 2)
  c.fill()
}

const bakeLayer = (m: TimelapseModel, index: number) => {
  if (!offscreen || !view) return
  drawLayerSolid(ctxOf(offscreen), view, m.layers[index], Infinity, true)
  bakedLayers = index + 1
}

const draw = (progress: number) => {
  const m = model.value
  const canvas = canvasEl.value
  if (!m || !canvas || !view || !offscreen || m.layers.length === 0) return
  const v = view
  const c = ctxOf(canvas)
  c.clearRect(0, 0, v.w, v.h)
  drawBed(c, v)
  const total = m.layers.length
  const layerFloat = progress * (total - 1)
  const current = Math.min(Math.floor(layerFloat), total - 1)
  const sub = layerFloat - current
  // Bake every fully-revealed layer that is not baked yet.
  while (bakedLayers < current) bakeLayer(m, bakedLayers)
  // Painter's order for the side wall: back half first (hidden by the
  // top faces), front half after.
  drawSkirt(c, v, m, bakedLayers > 0 ? bakedLayers - 1 : 0, false)
  c.drawImage(offscreen, 0, 0, v.w, v.h)
  drawSkirt(c, v, m, bakedLayers > 0 ? bakedLayers - 1 : 0, true)
  // Growing layer + toolhead at the extrusion point.
  const segs = layerPointCount(m.layers[current])
  if (segs > 0 && sub > 0) {
    const last = drawLayerSolid(
      c,
      v,
      m.layers[current],
      Math.max(1, Math.round(segs * sub)),
      false,
    )
    if (last) drawToolhead(c, v, last.x, last.y, m.layers[current].z)
  }
  // Top-light pass: source-atop tints only the model pixels.
  c.globalCompositeOperation = 'source-atop'
  const light = c.createLinearGradient(0, 0, 0, v.h)
  light.addColorStop(0, 'rgba(255,255,255,0.10)')
  light.addColorStop(0.5, 'rgba(255,255,255,0)')
  light.addColorStop(1, 'rgba(0,0,0,0.16)')
  c.fillStyle = light
  c.fillRect(0, 0, v.w, v.h)
  c.globalCompositeOperation = 'source-over'
}

const resetOffscreen = () => {
  const canvas = canvasEl.value
  if (!canvas || !view) return
  offscreen = document.createElement('canvas')
  offscreen.width = canvas.width
  offscreen.height = canvas.height
  const c = ctxOf(offscreen)
  c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
  c.lineCap = 'round'
  bakedLayers = 0
}

const tick = (now: number) => {
  if (!anchorTime) anchorTime = now
  const elapsed = now - anchorTime
  const target = Math.min(1, anchorPct + elapsed / (durationSec.value * 1000))
  progressPct.value = Math.round(target * 1000) / 10
  draw(target)
  if (target >= 1) {
    playing.value = false
    raf = 0
    return
  }
  raf = requestAnimationFrame(tick)
}

const togglePlay = () => {
  if (!model.value) return
  if (playing.value) {
    playing.value = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    return
  }
  if (progressPct.value >= 100) {
    progressPct.value = 0
    resetOffscreen()
  }
  anchorPct = progressPct.value / 100
  anchorTime = 0
  playing.value = true
  raf = requestAnimationFrame(tick)
}

const onSliderChange = () => {
  playing.value = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  resetOffscreen()
  draw(progressPct.value / 100)
}

const playOnce = (): Promise<void> =>
  new Promise<void>(resolve => {
    progressPct.value = 0
    resetOffscreen()
    anchorPct = 0
    anchorTime = 0
    playing.value = true
    const step = (now: number) => {
      if (!anchorTime) anchorTime = now
      const elapsed = now - anchorTime
      const target = Math.min(1, elapsed / (durationSec.value * 1000))
      progressPct.value = Math.round(target * 1000) / 10
      draw(target)
      if (target >= 1) {
        playing.value = false
        resolve()
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  })

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

const pickMime = (): string => {
  const candidates = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
  ]
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime
  }
  return 'video/webm'
}

const exportVideo = async () => {
  const canvas = canvasEl.value
  if (!canvas || !model.value || exporting.value) return
  exporting.value = true
  try {
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, {
      mimeType: pickMime(),
      videoBitsPerSecond: 4_000_000,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = e => {
      if (e.data.size) chunks.push(e.data)
    }
    const stopped = new Promise<void>(resolve => {
      recorder.onstop = () => resolve()
    })
    recorder.start()
    await playOnce()
    recorder.stop()
    await stopped

    const blob = new Blob(chunks, { type: 'video/webm' })
    const base64 = await blobToBase64(blob)
    const bridge = (window as any).P1ScreenBridge
    if (!bridge?.saveDownloadedFile) {
      showToast(t('tl_gen_no_bridge'))
      return
    }
    const base = fileName.value.replace(/\.[^.]+$/, '') || 'model'
    const result = bridge.saveDownloadedFile(base64, `timelapse_${base}.webm`)
    if (typeof result === 'string' && result.startsWith('error:')) {
      showToast(t('failed', { message: result.slice(6) }))
      return
    }
    showToast(t('tl_gen_saved', { path: result }))
  } catch (err: any) {
    showToast(t('failed', { message: err?.message ?? String(err) }))
  } finally {
    exporting.value = false
  }
}

const loadGcodeFromPrinter = async (path: string, name: string): Promise<string> => {
  const dev = getCurrentDevice()
  if (!dev?.ip || !dev?.code) throw new Error('no local device')
  const ftp = new FTPSClient()
  try {
    await ftp.connect(createFtpUrl(dev.ip))
    await ftp.login('bblp', dev.code)
    const data = await ftp.downloadContent(path)
    if (/\.3mf$/i.test(name)) {
      const unzipped = unzipSync(data)
      const key = Object.keys(unzipped).find(k => /^Metadata\/plate_\d+\.gcode$/.test(k))
      if (!key) throw new Error('no gcode inside 3mf')
      return new TextDecoder().decode(unzipped[key])
    }
    return new TextDecoder().decode(data)
  } finally {
    ftp.close()
  }
}

const start = async () => {
  phase.value = 'loading'
  try {
    let text: string
    if (route.query.test === '1') {
      isSample.value = true
      fileName.value = 'sample.gcode'
      loadingText.value = t('tl_gen_generating')
      text = generateSampleGcode()
    } else {
      const name = String(route.query.name ?? '')
      const path = String(route.query.path ?? '')
      if (!path) throw new Error('missing file')
      fileName.value = name || path.split('/').pop() || 'model'
      loadingText.value = t('tl_gen_downloading')
      text = await loadGcodeFromPrinter(path, fileName.value)
    }
    loadingText.value = t('tl_gen_parsing')
    await nextTick()
    const parsed = await parseGcodeTimelapse(text, p => {
      loadingText.value = `${t('tl_gen_parsing')} ${Math.round(p * 100)}%`
    })
    if (parsed.layers.length === 0) throw new Error('no printable layers found')
    model.value = parsed
    // Filament colour from the active tray — a real timelapse shows the
    // actual plastic, not a generic blue.
    TOP_COLOR = filamentColor()
    RIM_COLOR = tint(TOP_COLOR, 0.45)
    phase.value = 'ready'
    await nextTick()
    const canvas = canvasEl.value
    if (canvas) {
      view = computeView(parsed, canvas)
      resetOffscreen()
      draw(0)
    }
  } catch (err: any) {
    phase.value = 'error'
    errorText.value = err?.message ?? String(err)
  }
}

onMounted(start)

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
})
</script>

<style scoped>
.tl-gen {
  padding: 12px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tl-stage {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  background: #101318;
}

.tl-canvas {
  display: block;
  width: 100%;
}

.tl-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--van-text-color-2);
  background: rgba(16, 19, 24, 0.85);
}

.tl-overlay-text {
  font-size: 13px;
}

.tl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tl-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--van-text-color-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl-layers {
  font-size: 12px;
  color: var(--van-text-color-3);
}

.tl-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tl-slider {
  flex: 1;
}

.tl-durations {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tl-durations-label {
  font-size: 12px;
  color: var(--van-text-color-3);
}
</style>
