import hmsP1 from '../assets/devicehms_01S.json'
import hmsH2 from '../assets/devicehms_h2.json'

/** Serial prefixes that use the H2-series HMS table (merged from Bambu Studio) */
const H2_PREFIXES = new Set(['093', '094', '239', '31B'])

/**
 * Per-model HMS error table. H2 series (H2S/H2D/H2D Pro/H2C) has its own
 * merged table; every other model (P1/A1 series) uses the shared P1 table.
 */
export function hmsTableFor(serial?: string) {
  const prefix = (serial ?? '').slice(0, 3).toUpperCase()
  return H2_PREFIXES.has(prefix) ? hmsH2 : hmsP1
}
