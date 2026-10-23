/**
 * Publishes three as `window.THREE`.
 *
 * polyslice's browser build bundles helpers (polytree, three-subdivide) that
 * read three off `window` instead of importing it. In a worker there is no
 * `window` at all, so without this they fall back to `require("three")` and
 * throw "Dynamic require of \"three\" is not supported".
 *
 * Because ES modules are evaluated in import-declaration order, importing
 * this module *before* polyslice guarantees the global is in place when the
 * slicer's own module body runs — which is what lets the worker stay a single
 * IIFE chunk (a dynamic import would force code splitting, and IIFE workers
 * cannot split).
 */
import * as THREE from 'three'

const globalScope = globalThis as unknown as { window?: Record<string, unknown> }
if (!globalScope.window) globalScope.window = globalThis as unknown as Record<string, unknown>
globalScope.window.THREE = THREE

export default THREE
