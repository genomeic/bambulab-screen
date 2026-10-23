<template>
  <BasePage :title="t('tl_gen_title')">
    <div class="tl-gen">
      <div class="tl-stage">
        <!-- :key rebuilds this element through Vue when a second file is
             loaded — swapping the node manually would leave the template
             ref pointing at the detached old canvas after the next
             re-render, and the new scene would build into an element that
             is no longer in the document. -->
        <canvas :key="sceneKey" ref="canvasEl" class="tl-canvas" />
        <div v-if="phase === 'loading'" class="tl-overlay">
          <van-loading size="24" />
          <div class="tl-overlay-text">{{ loadingText }}</div>
          <!-- Slicing a detailed model can take minutes; without a way out
               the only exit is an ANR. -->
          <div v-if="canCancel" class="tl-cancel" @click="onCancel">{{ t('cancel') }}</div>
        </div>
        <div v-else-if="phase === 'error'" class="tl-overlay">
          <van-icon name="warning-o" size="28" />
          <div class="tl-overlay-text">{{ errorText }}</div>
        </div>
        <div v-else-if="phase === 'idle'" class="tl-overlay">
          <van-icon name="photo-o" size="28" />
          <div class="tl-overlay-text">{{ t('tl_gen_pick_prompt') }}</div>
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
        class="tl-pick"
        round
        block
        plain
        type="primary"
        :disabled="phase === 'loading'"
        @click="openPicker"
      >
        {{ t('tl_gen_pick_device_file') }}
      </van-button>
      <input
        ref="fileInput"
        type="file"
        accept=".gcode,.3mf,.stl"
        class="tl-file-input"
        @change="onFilePicked"
      />

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
import { sliceStl, cancelStlSlice } from '../../utils/stlSlicer'
import BasePage from '../../components/BasePage.vue'
import { usePrinterStore } from '../../stores/printer'

const { device } = usePrinterStore()

const { t } = useI18n()
const route = useRoute()

const DURATIONS = [8, 15, 30]

/** Nothing loaded yet — waiting for the user to pick a file. */
type Phase = 'loading' | 'ready' | 'error' | 'idle'
const phase = ref<Phase>('loading')
const loadingText = ref('')
/** True only while a slice is in flight — the one job worth cancelling. */
const canCancel = ref(false)
const errorText = ref('')
const fileName = ref('')
const isSample = ref(false)
/** Printable layers — drives the slider and the playback mapping. */
const layerCount = ref(0)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
/**
 * Bumped per file load so Vue rebuilds the canvas element. A new WebGL
 * context is created on the fresh element; the old one is disposed first.
 */
const sceneKey = ref(0)
// Opens on the finished print, not on layer 1. Showing a single layer on a
// dark stage reads as an empty black frame — the whole point of the page is
// to see the model. Playback rewinds to 0 on its own (see togglePlay).
const progressPct = ref(100)
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
let rafCam = 0
/** Playback anchor: progress at the time the current rAF run started. */
let anchorPct = 0
let anchorTime = 0
/** Last time the slider value was pushed to the UI (throttled). */
let lastUiUpdate = 0
/** Last playback frame drawn — playback renders at 30 fps, not 60. */
let lastRender = 0

/** Draws one frame — called on demand only, never in an idle loop. */
const renderFrame = (): void => {
  if (preview) preview.renderer.render(preview.scene, preview.camera)
}

/**
 * Camera loop. The controls only apply orbit/zoom input when update() is
 * called, so a loop is still needed — but a frame is drawn only when the
 * camera actually moved. The library's own unconditional 60 fps render
 * loop is cancelled: it kept the GPU busy while the page sat idle, which
 * is what made the UI feel laggy.
 *
 * The once-per-second idle frame is a safety net: a lost GL surface or a
 * compositor hiccup can blank the canvas with nothing to trigger a redraw
 * (the old 60 fps loop recovered by accident). At 2 fps the cost is ~3% of
 * that loop while guaranteeing the view never stays black.
 */
const IDLE_RENDER_MS = 500
const lastCamPos = new THREE.Vector3()
const lastCamQuat = new THREE.Quaternion()
let lastFrameAt = 0
const cameraLoop = (now?: number): void => {
  if (!preview) return
  preview.controls.update()
  const cam = preview.camera
  const moved = !cam.position.equals(lastCamPos) || !cam.quaternion.equals(lastCamQuat)
  const t = now ?? performance.now()
  if (moved || t - lastFrameAt >= IDLE_RENDER_MS) {
    // A canvas that had not been laid out when the scene was built keeps a
    // zero-sized drawing buffer, and no resize event fires to correct it.
    // A NaN aspect (same root cause) is just as fatal: the projection
    // matrix collapses and nothing ever draws.
    const el = preview.renderer.domElement
    if (el.width === 0 || el.height === 0 || !Number.isFinite(cam.aspect)) {
      preview.resize()
      preview.renderer.setPixelRatio(pixelRatio)
      if (!Number.isFinite(preview.camera.aspect)) {
        rafCam = requestAnimationFrame(cameraLoop)
        return
      }
    }
    renderFrame()
    lastCamPos.copy(cam.position)
    lastCamQuat.copy(cam.quaternion)
    lastFrameAt = t
  }
  rafCam = requestAnimationFrame(cameraLoop)
}

/** P1-series bed size in mm. */
const BED = 256

/**
 * A lost GL context is the classic "the canvas went black and never came
 * back" on Android: the WebView drops it under memory pressure or when the
 * app is backgrounded. The browser only fires `webglcontextrestored` if the
 * lost event is cancelled, so preventDefault() here is what makes recovery
 * possible at all.
 */
const onContextLost = (e: Event): void => {
  e.preventDefault()
}
const onContextRestored = (): void => {
  if (!preview) return
  preview.resize()
  preview.renderer.setPixelRatio(pixelRatio)
  renderFrame()
}

/**
 * Frames the model: places the camera along `dir` at the distance where the
 * bounding box's projected extents fit the viewport. The extents use the
 * box support function, so the framing is exact for any orbit angle — a
 * wide, flat print and a tall tower both fill the frame without clipping.
 */
const fitCamera = (
  p: WebGLPreview,
  dir: THREE.Vector3,
  hx: number,
  hy: number,
  hz: number,
): void => {
  const fov = (p.camera.fov * Math.PI) / 180
  // Math.max() propagates NaN — and a canvas that has not been laid out
  // yet reports offsetWidth/Height 0, which makes aspect 0/0. Guard both.
  const rawAspect = p.camera.aspect
  const aspect = Number.isFinite(rawAspect) && rawAspect > 0.1 ? rawAspect : 1
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize()
  const up = new THREE.Vector3().crossVectors(dir, right).normalize()
  const extX = Math.abs(right.x) * hx + Math.abs(right.y) * hy + Math.abs(right.z) * hz
  const extY = Math.abs(up.x) * hx + Math.abs(up.y) * hy + Math.abs(up.z) * hz
  let dist = Math.max(extY / Math.tan(fov / 2), extX / (Math.tan(fov / 2) * aspect), 30) * 1.1
  if (!Number.isFinite(dist) || dist <= 0) dist = 200
  p.camera.position.copy(p.controls.target).addScaledVector(dir, dist)
  p.camera.updateProjectionMatrix()
  p.controls.minDistance = 5
  p.controls.maxDistance = dist * 3
  // Keep the orbit above ~30° elevation so the print never leaves the frame.
  p.controls.maxPolarAngle = Math.PI / 3
  p.controls.update()
}

/** Lines fed to the parser per UI slice — keeps the thread responsive. */
const PARSE_CHUNK_LINES = 8000
/**
 * Layers built per UI slice while the scene is assembled. Kept small: one
 * layer is a renderLayer + batchGeometries pass, and on a detailed model
 * that is tens of milliseconds, so a coarse chunk reads as a freeze.
 */
const BUILD_CHUNK_LAYERS = 8
/** Layer groups shaded per UI slice in the depth pass. */
const SHADE_CHUNK_LAYERS = 32

/** Capped device pixel ratio — a dpr-3 phone would otherwise render 2.25× the pixels. */
let pixelRatio = 1

const yieldToUI = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/**
 * The renderer's drawing buffer does not follow CSS resizes on its own —
 * rotating the phone or a keyboard popping up would leave a stretched or
 * blank canvas. Debounced because resize storms otherwise re-render per event.
 */
let resizeTimer = 0
const onWindowResize = (): void => {
  if (!preview) return
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    if (!preview) return
    preview.resize()
    preview.renderer.setPixelRatio(pixelRatio)
    renderFrame()
  }, 150)
}

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
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(w * pixelRatio)
  canvas.height = Math.round(h * pixelRatio)
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
  p.renderer.setPixelRatio(pixelRatio)
  // A canvas that resetScene() just swapped in can reach this point before
  // the layout engine has run — init() then computes aspect as 0/0 = NaN,
  // and a NaN projection matrix draws nothing at all (not even the plate).
  // Wait a frame, force the drawing buffer, recompute.
  if (!Number.isFinite(p.camera.aspect) || p.camera.aspect <= 0) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const w2 = canvas.clientWidth || canvas.parentElement?.clientWidth || 360
    const h2 = stageHeight(w2)
    canvas.width = Math.round(w2 * pixelRatio)
    canvas.height = Math.round(h2 * pixelRatio)
    canvas.style.height = `${h2}px`
    p.resize()
    p.renderer.setPixelRatio(pixelRatio)
  }
  // The library ships an unconditional 60 fps render loop. On a phone that
  // keeps the main thread and GPU busy even when the scene is static, which
  // makes the whole page feel laggy — so it is stopped here; cameraLoop
  // below applies input and draws only when something actually changed.
  ;(p as any).cancelAnimation()

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

  // Depth shading: deeper layers catch less chamber light. Looking down at
  // sparse infill you can see ~10 layers through the gaps, which otherwise
  // accumulates into a solid-looking mesh — the falloff is what makes the
  // top layer's separate lines read clearly, like a real print-cam frame.
  const top = layerGroups.length - 1
  // A material can be referenced by more than one mesh in a group; visiting
  // it twice would compound the multiplier and drive the colour to black.
  const shaded = new Set<object>()
  for (let i = 0; i < layerGroups.length; i++) {
    const shade = Math.max(0.6, 1 - (top - i) * 0.006)
    if (shade >= 1) continue
    if (i % SHADE_CHUNK_LAYERS === 0) await yieldToUI()
    layerGroups[i].traverse(obj => {
      const mat = (obj as THREE.Mesh).material as { color?: THREE.Color } | undefined
      if (!mat?.color || shaded.has(mat.color)) return
      shaded.add(mat.color)
      mat.color.multiplyScalar(shade)
    })
  }

  // Camera fit. The group is rotated -90° about X and offset to the bed
  // centre, so gcode (x, y, z) maps to world (x - BED/2, z, BED/2 - y).
  p.controls.target.set(
    (minX + maxX) / 2 - BED / 2,
    (minZ + maxZ) / 2,
    BED / 2 - (minY + maxY) / 2,
  )
  // Downward oblique view — steep enough to read the whole top surface,
  // still angled so the walls and layer steps stay visible, like a chamber
  // camera looking into the bed. Half-extents in world axes: gcode x/y/z
  // map to world x/z/y.
  const dir = new THREE.Vector3(0.4, 0.82, 0.42).normalize()
  fitCamera(p, dir, (maxX - minX) / 2, (maxZ - minZ) / 2, (maxY - minY) / 2)
  p.renderer.render(p.scene, p.camera)

  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)
  preview = p
  // Debug handle for CDP inspection of the scene state.
  ;(window as any).__tl = { p, layerGroups, printable }
  layerCount.value = printable
  // Seed the camera snapshot, then drive input/rendering on demand.
  lastCamPos.copy(p.camera.position)
  lastCamQuat.copy(p.camera.quaternion)
  rafCam = requestAnimationFrame(cameraLoop)
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
  renderFrame()
}

const tick = (now: number) => {
  if (!anchorTime) anchorTime = now
  const elapsed = now - anchorTime
  const target = Math.min(1, anchorPct + elapsed / (durationSec.value * 1000))
  // The slider only needs ~10 fps — pushing a Vue update every frame is
  // wasted work while the canvas redraws anyway.
  if (target >= 1 || now - lastUiUpdate >= 100) {
    progressPct.value = Math.round(target * 1000) / 10
    lastUiUpdate = now
  }
  // 30 fps is video-smooth and halves the GPU load of a full-scene redraw.
  if (target >= 1 || now - lastRender >= 33) {
    renderAt(target)
    lastRender = now
  }
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
  lastRender = 0
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
    lastUiUpdate = 0
    lastRender = 0
    playing.value = true
    const step = (now: number) => {
      if (!anchorTime) anchorTime = now
      const elapsed = now - anchorTime
      const target = Math.min(1, elapsed / (durationSec.value * 1000))
      if (target >= 1 || now - lastUiUpdate >= 100) {
        progressPct.value = Math.round(target * 1000) / 10
        lastUiUpdate = now
      }
      if (target >= 1 || now - lastRender >= 33) {
        renderAt(target)
        lastRender = now
      }
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

/** Runs the whole pipeline for any gcode text — printer, sample or phone. */
const runWithGcode = async (text: string) => {
  loadingText.value = t('tl_gen_parsing')
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 50))
  await buildPreview(text)
  // The first draw uploads every layer's buffers to the GPU, which on a
  // detailed model is seconds of blocking work. The overlay stays up until
  // that frame is on screen: a spinner that cannot move is still better
  // than a finished-looking canvas that ignores every touch.
  loadingText.value = `${t('tl_gen_rendering')} 100%`
  await yieldToUI()
  renderAt(1)
  await yieldToUI()
  phase.value = 'ready'
}

const start = async () => {
  const test = route.query.test === '1'
  const path = String(route.query.path ?? '')
  // Opened from the files page without a file: show the picker prompt
  // instead of failing on a missing path.
  if (!test && !path) {
    phase.value = 'idle'
    return
  }
  phase.value = 'loading'
  try {
    let text: string
    if (test) {
      isSample.value = true
      fileName.value = 'sample.gcode'
      loadingText.value = t('tl_gen_generating')
      text = generateSampleGcode()
    } else {
      const name = String(route.query.name ?? '')
      fileName.value = name || path.split('/').pop() || 'model'
      loadingText.value = t('tl_gen_downloading')
      text = await loadGcodeFromPrinter(path, fileName.value)
    }
      await runWithGcode(text)
    } catch (err: any) {
      canCancel.value = false
      cancelStlSlice()
      phase.value = 'error'
      errorText.value = err?.message ?? String(err)
    }
}

/** Abandons a slice that is taking too long. */
const onCancel = () => {
  cancelStlSlice()
  canCancel.value = false
  phase.value = 'idle'
  fileName.value = ''
}

/**
 * Frees the previous scene. The canvas element itself is rebuilt through
 * its :key (see the template) — the next buildPreview() call runs after a
 * nextTick, when the ref points at the fresh, attached element.
 */
const resetScene = () => {
  if (raf) cancelAnimationFrame(raf)
  if (rafCam) cancelAnimationFrame(rafCam)
  raf = 0
  rafCam = 0
  playing.value = false
  preview?.dispose()
  preview = null
  layerGroups = []
  layerCount.value = 0
  progressPct.value = 100
  sceneKey.value++
}

const openPicker = () => fileInput.value?.click()

/** Reads a gcode/3mf picked from the phone and renders it. */
const onFilePicked = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  resetScene()
  phase.value = 'loading'
  isSample.value = false
  fileName.value = file.name
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      let text: string
      if (/\.stl$/i.test(file.name)) {
        // An STL has no toolpaths of its own — slice it first. Slicing runs
        // in a worker because a detailed model needs minutes of CPU; this
        // reports its progress instead of freezing the page.
        loadingText.value = t('tl_gen_slicing')
        canCancel.value = true
        await nextTick()
        await new Promise(resolve => setTimeout(resolve, 50))
        text = await sliceStl(data, pct => {
          loadingText.value = `${t('tl_gen_slicing')} ${pct}%`
        })
        canCancel.value = false
      } else if (/\.3mf$/i.test(file.name)) {
        const unzipped = unzipSync(data)
        const key = Object.keys(unzipped).find(k => /^Metadata\/plate_\d+\.gcode$/.test(k))
        if (!key) throw new Error('no gcode inside 3mf')
        text = new TextDecoder().decode(unzipped[key])
      } else {
        text = new TextDecoder().decode(data)
      }
      await runWithGcode(text)
    } catch (err: any) {
    phase.value = 'error'
    errorText.value = err?.message ?? String(err)
  }
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  start()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  cancelStlSlice()
  canvasEl.value?.removeEventListener('webglcontextlost', onContextLost)
  canvasEl.value?.removeEventListener('webglcontextrestored', onContextRestored)
  clearTimeout(resizeTimer)
  if (raf) cancelAnimationFrame(raf)
  if (rafCam) cancelAnimationFrame(rafCam)
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

.tl-cancel {
  margin-top: 10px;
  padding: 5px 18px;
  font-size: 13px;
  color: var(--van-gray-5, #c8c9cc);
  border: 1px solid var(--van-gray-5, #c8c9cc);
  border-radius: 14px;
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

.tl-pick {
  margin-top: -4px;
}

.tl-file-input {
  display: none;
}
</style>
