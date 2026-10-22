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
        <span v-if="layerCount > 0" class="tl-layers">{{ t('tl_gen_layers', { count: layerCount }) }}</span>
        <van-tag v-if="isSample" size="medium" type="warning">{{ t('tl_gen_sample') }}</van-tag>
      </div>

      <div class="tl-controls">
        <van-button
          round
          type="primary"
          size="small"
          :disabled="layerCount === 0"
          :icon="playing ? 'pause' : 'play'"
          @click="togglePlay"
        >
          {{ playing ? t('tl_gen_pause') : t('tl_gen_play') }}
        </van-button>
        <van-slider
          v-model="progressPct"
          class="tl-slider"
          :disabled="layerCount === 0"
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
        :disabled="layerCount === 0"
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
import * as THREE from 'three'
import { init, type WebGLPreview } from 'gcode-preview'
import { FTPSClient } from '@bambulab-p1screen/printer-api'
import { createFtpUrl } from '../../printer'
import { getCurrentDevice } from '../../utils/device'
import { generateSampleGcode } from '../../utils/gcodeTimelapse'
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
/** Printable layers — drives the slider and the playback mapping. */
const layerCount = ref(0)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const progressPct = ref(0)
const playing = ref(false)
const durationSec = ref(15)
const exporting = ref(false)

/**
 * Rendering engine: gcode-preview (MIT) — a three.js viewer that turns each
 * extrusion path into a swept tube with the real extrusion width, lit by
 * ambient + directional light so the bead grooves read like a photo.
 * Every layer becomes its own Group; the timelapse is just visibility
 * toggling, which mirrors how a real print-cam works: the head parks, one
 * frame per finished layer.
 */
let preview: WebGLPreview | null = null
/** One group per gcode layer (index 0 is the parser's preamble — empty). */
let layerGroups: THREE.Group[] = []
let raf = 0
/** Playback anchor: progress at the time the current rAF run started. */
let anchorPct = 0
let anchorTime = 0

/** P1-series bed size in mm. */
const BED = 256

/** Lines fed to the parser per UI slice — keeps the thread responsive. */
const PARSE_CHUNK_LINES = 20000
/** Layers built per UI slice while the scene is assembled. */
const BUILD_CHUNK_LAYERS = 24

const yieldToUI = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Filament colour(s) from the AMS trays ('RRGGBBAA' Bambu format). */
const filamentColors = (): string[] => {
  const trays: any[] = (device.value as any)?.ams?.ams?.[0]?.tray ?? []
  const colors = trays
    .map((tr: any) => tr?.tray_color)
    .filter((raw: any): raw is string => typeof raw === 'string' && /^[0-9a-fA-F]{8}$/.test(raw))
    .map((raw: string) => `#${raw.slice(0, 6).toLowerCase()}`)
  return colors.length > 0 ? colors : ['#2f6fd0']
}

/** Keep the frame inside the visible page area (controls sit below). */
const stageHeight = (w: number): number =>
  Math.round(Math.min(w * 0.78, Math.max(window.innerHeight * 0.6, 260)))

/**
 * Builds the three.js scene. The library renders every layer into its own
 * group synchronously; only extrusion-bearing layers count toward the
 * timeline (start/end gcode travel lifts would add dead frames). Parsing
 * and scene assembly are chunked so large files never freeze the UI.
 */
const buildPreview = async (text: string): Promise<void> => {
  const canvas = canvasEl.value
  if (!canvas) throw new Error('canvas not ready')
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 360
  const h = stageHeight(w)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.height = `${h}px`

  const colors = filamentColors()
  const p = init({
    canvas,
    // Volumetric rendering: each path becomes a swept tube with the real
    // extrusion width, so walls and infill show as physical beads.
    renderTubes: true,
    extrusionWidth: 0.42,
    lineHeight: 0.2,
    renderTravel: false,
    buildVolume: { x: BED, y: BED, z: BED },
    backgroundColor: '#101318',
    initialCameraPosition: [-140, 420, 460],
    minLayerThreshold: 0.05,
    extrusionColor: colors.length > 1 ? colors : colors[0],
  })
  p.resize()
  p.renderer.setPixelRatio(dpr)

  // Chunked parse — the library concatenates internally, so feeding it
  // line batches is equivalent to one call but keeps the thread free.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += PARSE_CHUNK_LINES) {
    p.parser.parseGCode(lines.slice(i, i + PARSE_CHUNK_LINES))
    const pct = Math.min(40, Math.round(((i + PARSE_CHUNK_LINES) / lines.length) * 40))
    loadingText.value = `${t('tl_gen_parsing')} ${pct}%`
    await yieldToUI()
  }

  const layers = p.layers
  if (layers.length <= 1) throw new Error('no printable layers found')

  // Drop the library's build-volume wireframe — a dark plate with a faint
  // grid reads closer to a real print-cam frame.
  const anyP = p as any
  anyP.resetState()
  anyP.initScene()
  for (const child of [...p.scene.children]) {
    if ((child as any).isLight) continue
    p.scene.remove(child)
  }
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(BED, BED),
    new THREE.MeshBasicMaterial({ color: 0x1b1f27 }),
  )
  plate.rotation.x = -Math.PI / 2
  p.scene.add(plate)
  const grid = new THREE.GridHelper(BED, 8, 0x39414f, 0x272c35)
  grid.position.y = 0.02
  p.scene.add(grid)

  // Bounds from extrusion-bearing layers only — the end-of-print travel
  // lift would otherwise inflate the camera distance. Running nozzle Z is
  // sampled only at extruding moves for the same reason.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let printable = 0
  let runZ = 0

  layerGroups = []
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    const prints = layer.commands.some(c => (c.params.e ?? 0) > 0)
    if (prints) {
      printable++
      for (const cmd of layer.commands) {
        const q = cmd.params
        if (q.z != null) runZ = q.z
        if ((q.e ?? 0) > 0 && q.x != null) {
          minX = Math.min(minX, q.x)
          maxX = Math.max(maxX, q.x)
          minY = Math.min(minY, q.y ?? 0)
          maxY = Math.max(maxY, q.y ?? 0)
          minZ = Math.min(minZ, runZ)
          maxZ = Math.max(maxZ, runZ)
        }
      }
    }
    anyP.group = anyP.createGroup(`layer${i}`)
    anyP.renderLayer(i)
    anyP.batchGeometries()
    p.scene.add(anyP.group)
    layerGroups.push(anyP.group)
    if (i % BUILD_CHUNK_LAYERS === 0) {
      const pct = 40 + Math.round((i / layers.length) * 60)
      loadingText.value = `${t('tl_gen_rendering')} ${pct}%`
      await yieldToUI()
    }
  }
  if (printable === 0 || !Number.isFinite(minX)) {
    throw new Error('no printable layers found')
  }

  // Camera fit. The group is rotated -90° about X and offset to the bed
  // centre, so gcode (x, y, z) maps to world (x - BED/2, z, BED/2 - y).
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cz = (minZ + maxZ) / 2
  const radius = Math.max(maxX - minX, maxY - minY, (maxZ - minZ) * 1.35) / 2 + 4
  const fovRad = (p.camera.fov * Math.PI) / 180
  const dist = (radius / Math.sin(fovRad / 2)) * 1.12
  p.controls.target.set(cx - BED / 2, cz, BED / 2 - cy)
  // Three-quarter view from front-right-above, like a chamber camera.
  const dx = 0.72
  const dy = 0.66
  const dz = 1
  const dl = Math.hypot(dx, dy, dz)
  p.camera.position.set(
    p.controls.target.x + (dx / dl) * dist,
    p.controls.target.y + (dy / dl) * dist,
    p.controls.target.z + (dz / dl) * dist,
  )
  p.camera.updateProjectionMatrix()
  p.controls.update()
  p.renderer.render(p.scene, p.camera)

  preview = p
  layerCount.value = printable
}

/** Shows every layer up to `progress` and draws one frame. */
const renderAt = (progress: number): void => {
  const total = Math.max(layerCount.value, 1)
  // Layer groups are 1-based — group 0 is the parser's preamble (start
  // gcode, never visible). Progress 0 shows the first finished layer,
  // progress 1 the whole print.
  const upto = Math.min(Math.round(progress * (total - 1)) + 1, total)
  for (let i = 0; i < layerGroups.length; i++) {
    layerGroups[i].visible = i <= upto
  }
  if (preview) preview.renderer.render(preview.scene, preview.camera)
}

const tick = (now: number) => {
  if (!anchorTime) anchorTime = now
  const elapsed = now - anchorTime
  const target = Math.min(1, anchorPct + elapsed / (durationSec.value * 1000))
  progressPct.value = Math.round(target * 1000) / 10
  renderAt(target)
  if (target >= 1) {
    playing.value = false
    raf = 0
    return
  }
  raf = requestAnimationFrame(tick)
}

const togglePlay = () => {
  if (layerCount.value === 0) return
  if (playing.value) {
    playing.value = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    return
  }
  if (progressPct.value >= 100) {
    progressPct.value = 0
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
  renderAt(progressPct.value / 100)
}

const playOnce = (): Promise<void> =>
  new Promise<void>(resolve => {
    progressPct.value = 0
    anchorPct = 0
    anchorTime = 0
    playing.value = true
    const step = (now: number) => {
      if (!anchorTime) anchorTime = now
      const elapsed = now - anchorTime
      const target = Math.min(1, elapsed / (durationSec.value * 1000))
      progressPct.value = Math.round(target * 1000) / 10
      renderAt(target)
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
  if (!canvas || layerCount.value === 0 || exporting.value) return
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
    // Let the loading overlay paint before the first parse slice blocks.
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 50))
    await buildPreview(text)
    phase.value = 'ready'
    await nextTick()
    renderAt(0)
  } catch (err: any) {
    phase.value = 'error'
    errorText.value = err?.message ?? String(err)
  }
}

onMounted(start)

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  preview?.dispose()
  preview = null
  layerGroups = []
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
</style>
