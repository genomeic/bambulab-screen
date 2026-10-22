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

const ANG = Math.PI / 6 // classic 30° isometric — three-quarter view
const COS = Math.cos(ANG)
const SIN = Math.sin(ANG)

/** Solid top-face colour (the "plastic"). */
const TOP_COLOR = '#1e40af'
/** Side wall gradient anchors — the bottom of every layer fades into the
 *  shade below, the top meets the top-face colour, so the stack reads as
 *  one continuous surface with faint layer steps. */
const SIDE_DARK = '#122a6e'
/** Bright rim — drawn only on the growing layer, not on baked ones. */
const RIM_COLOR = '#3b82f6'

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
 * Gentle vertical stretch (2.2×) — enough depth to read as a solid object,
 * small enough that layer lines stay hairline instead of striped.
 */
const Z_STRETCH = 2.2

const computeView = (m: TimelapseModel, canvas: HTMLCanvasElement): View => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth
  const h = Math.round(w * 0.78)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.height = `${h}px`
  const c = ctxOf(canvas)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)

  const sxMin = (m.minX - m.maxY) * COS
  const sxMax = (m.maxX - m.minY) * COS
  const sumMin = m.minX + m.minY
  const sumMax = m.maxX + m.maxY
  const syMin = sumMin * SIN - m.maxZ * Z_STRETCH
  const syMax = sumMax * SIN
  const margin = 14
  const scale = Math.min(
    (w - margin * 2) / Math.max(sxMax - sxMin, 1),
    (h - margin * 2) / Math.max(syMax - syMin, 1),
  )
  return {
    scale,
    zScale: Z_STRETCH,
    offX: w / 2 - ((sxMin + sxMax) / 2) * scale,
    offY: h / 2 - ((syMin + syMax) / 2) * scale,
    w,
    h,
    dpr,
    centerX: (m.minX + m.maxX) / 2,
    centerY: (m.minY + m.maxY) / 2,
  }
}

const sx = (v: View, x: number, y: number) => v.offX + (x - y) * COS * v.scale
const sy = (v: View, x: number, y: number, z: number) => v.offY + ((x + y) * SIN - z * v.zScale) * v.scale

const drawBed = (c: CanvasRenderingContext2D, v: View) => {
  c.strokeStyle = 'rgba(148, 163, 184, 0.35)'
  c.lineWidth = 1
  const pad = 4
  c.beginPath()
  const c0x = 0 - pad
  const c0y = 0 - pad
  const c1x = 256 + pad
  const c1y = 256 + pad
  c.moveTo(sx(v, c0x, c0y), sy(v, c0x, c0y, 0))
  c.lineTo(sx(v, c1x, c0y), sy(v, c1x, c0y, 0))
  c.lineTo(sx(v, c1x, c1y), sy(v, c1x, c1y, 0))
  c.lineTo(sx(v, c0x, c1y), sy(v, c0x, c1y, 0))
  c.closePath()
  c.stroke()
}

/**
 * Draws one layer as a solid slab:
 * - the outer contour is filled as a solid top face,
 * - infill / inner / support paths show as faint texture on top.
 * The continuous side wall (skirt) is drawn once per frame by drawSkirt().
 * While a layer is still growing (complete=false) the top face is only
 * stroked as a thick outline, so layer growth stays visible.
 */
const drawLayerSolid = (
  c: CanvasRenderingContext2D,
  v: View,
  layer: TimelapseLayer,
  maxSegs: number,
  complete: boolean,
  texture: boolean,
) => {
  const z1 = layer.z
  const outer = layer.segs.outer
  const others = (Object.keys(layer.segs) as TimelapsePathType[]).filter(k => k !== 'outer')

  // Solid top face from the outer contour.
  if (outer) {
    c.beginPath()
    let started = false
    const limit = Math.min(outer.length / 4, maxSegs)
    for (let i = 0, s = 0; s < limit; i += 4, s++) {
      const px = sx(v, outer[i], outer[i + 1])
      const py = sy(v, outer[i], outer[i + 1], z1)
      if (!started) {
        c.moveTo(px, py)
        started = true
      } else {
        c.lineTo(px, py)
      }
    }
    if (complete) {
      c.closePath()
      // Stroke the same colour first: fills anti-alias their edge against
      // transparency, and 100+ stacked layer edges would accumulate into
      // faint rings. A same-colour stroke seals them.
      c.strokeStyle = TOP_COLOR
      c.lineWidth = 1
      c.stroke()
      c.fillStyle = TOP_COLOR
      c.fill()
    }
    // Bright rim — only on the growing layer; baked layers stay clean so
    // the layer steps come from the side shading alone.
    if (!complete) {
      c.strokeStyle = RIM_COLOR
      c.lineWidth = 2.2
      c.lineJoin = 'round'
      c.lineCap = 'round'
      c.stroke()
    }
  }

  // Infill / inner / support texture — only on the growing top layer;
  // baked layers keep a clean surface (their texture would shine
  // through the gaps between the layers above).
  let quota = maxSegs
  for (const key of others) {
    const pts = layer.segs[key]
    if (!pts || quota <= 0 || !texture) continue
    const available = pts.length / 4
    const take = Math.min(available, quota)
    c.strokeStyle = key === 'support' ? 'rgba(245, 158, 11, 0.35)' : 'rgba(96, 165, 250, 0.16)'
    c.lineWidth = Math.max(0.45 * v.scale, 1.2)
    c.lineCap = 'round'
    c.beginPath()
    for (let i = 0, s = 0; s < take; i += 4, s++) {
      c.moveTo(sx(v, pts[i], pts[i + 1]), sy(v, pts[i], pts[i + 1], z1))
      c.lineTo(sx(v, pts[i + 2], pts[i + 3]), sy(v, pts[i + 2], pts[i + 3], z1))
    }
    c.stroke()
    quota -= take
    if (take < available) break
  }
}

/**
 * The continuous side wall: the outer contour of the highest baked layer,
 * extruded from the bed up to that layer's Z, filled with one vertical
 * gradient (dark at the bed, top-face colour at the top). Drawn before the
 * baked layers so only its outer fringe shows — that fringe is the volume.
 */
const drawSkirt = (c: CanvasRenderingContext2D, v: View, m: TimelapseModel, topIndex: number) => {
  const top = m.layers[Math.max(Math.min(topIndex, m.layers.length - 1), 0)]
  const outer = top?.segs.outer
  if (!outer) return
  const z0 = 0
  const z1 = top.z
  const yBottom = sy(v, v.centerX, v.centerY, z0)
  const yTop = sy(v, v.centerX, v.centerY, z1)
  const grad = c.createLinearGradient(0, yBottom, 0, yTop)
  grad.addColorStop(0, SIDE_DARK)
  grad.addColorStop(1, TOP_COLOR)
  c.fillStyle = grad
  c.beginPath()
  for (let i = 0; i + 3 < outer.length; i += 4) {
    const x0 = outer[i]
    const y0 = outer[i + 1]
    const x1 = outer[i + 2]
    const y1 = outer[i + 3]
    c.moveTo(sx(v, x0, y0), sy(v, x0, y0, z0))
    c.lineTo(sx(v, x1, y1), sy(v, x1, y1, z0))
    c.lineTo(sx(v, x1, y1), sy(v, x1, y1, z1))
    c.lineTo(sx(v, x0, y0), sy(v, x0, y0, z1))
    c.closePath()
  }
  c.fill()
}

const bakeLayer = (m: TimelapseModel, index: number) => {
  if (!offscreen || !view) return
  drawLayerSolid(ctxOf(offscreen), view, m.layers[index], Infinity, true, false)
  bakedLayers = index + 1
}

const draw = (progress: number) => {
  const m = model.value
  const canvas = canvasEl.value
  if (!m || !canvas || !view || !offscreen || m.layers.length === 0) return
  const v = view
  const c = ctxOf(canvas)
  c.clearRect(0, 0, v.w, v.h)
  c.fillStyle = '#101318'
  c.fillRect(0, 0, v.w, v.h)
  drawBed(c, v)
  // Continuous side wall first, so the baked top faces cover its top edge.
  drawSkirt(c, v, m, bakedLayers > 0 ? bakedLayers - 1 : 0)
  c.drawImage(offscreen, 0, 0, v.w, v.h)

  const total = m.layers.length
  const layerFloat = progress * (total - 1)
  const current = Math.min(Math.floor(layerFloat), total - 1)
  const sub = layerFloat - current
  // Bake every fully-revealed layer that is not baked yet.
  while (bakedLayers < current) bakeLayer(m, bakedLayers)
  const segs = layerPointCount(m.layers[current])
  if (segs > 0 && sub > 0) {
    drawLayerSolid(
      c,
      v,
      m.layers[current],
      Math.max(1, Math.round(segs * sub)),
      false,
      true,
    )
  }
  // Top-light pass: source-atop tints only the model pixels, giving the
  // solid a lit top and shaded base — the main depth cue.
  c.globalCompositeOperation = 'source-atop'
  const light = c.createLinearGradient(0, 0, 0, v.h)
  light.addColorStop(0, 'rgba(255,255,255,0.12)')
  light.addColorStop(0.45, 'rgba(255,255,255,0.02)')
  light.addColorStop(1, 'rgba(0,0,0,0.22)')
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
