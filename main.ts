// polymarket-nvidia-ceo-forecast-01 entry: per-market empirical forecaster.
// Reads one case file from the input directory, writes five quantiles for every
// market and every minute of the horizon to the output directory.
// Model: persistence median. The spread averages two members: (1) empirical
// quantiles of the market's own recent h-minute price changes, blended with
// the pooled quantiles of all the case's markets and widened at the outer
// levels, and (2) a normal model whose scale is the market's robust mean
// absolute minute change, blended with the pooled scale, widening with the
// square root of the horizon.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

/** Model constants (fit on the kit's six practice cases only). */
const ANCHORS = [1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180, 240];
/** Empirical change quantiles come from each market's last 8 hours. */
const WIN_MIN = 480;
/** Weight of a market's own change quantiles against the pooled ones. */
const BLEND_W = 0.5;
/** Per-level multiplier on the empirical offsets: outer levels widened. */
const TAIL_K = [1.15, 1, 1, 1, 1.15];
/** The normal ensemble member: scale gain and its 24-hour scale window. */
const NORM_G = 1.4;
const NORM_WIN = 1440;

/** The h-minute price changes of a series, sampled every second window. */
function changesAt(prices: number[], h: number, fromIdx: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, fromIdx); i + h < prices.length; i += 2) out.push(prices[i + h] - prices[i]);
  return out;
}

/** Empirical quantiles of a change sample at the five levels, or null. */
function empQuantiles(changes: number[]): number[] | null {
  if (changes.length === 0) return null;
  const a = Float64Array.from(changes).sort();
  return QUANTILES.map((t) => a[Math.min(a.length - 1, Math.floor(t * a.length))] as number);
}

/** Mean absolute one-minute change over prices[fromIdx..]. */
function meanAbsDiff(prices: number[], fromIdx: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(1, fromIdx); i < prices.length; i++) {
    s += Math.abs(prices[i] - prices[i - 1]);
    n++;
  }
  return n > 0 ? s / n : 0;
}

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** The whole case's forecast: empirical change quantiles ensembled with a normal model. */
function forecastAll(c: Case): { id: string; q: number[][] }[] {
  const horizon = c.horizon_minutes;
  const fromOf = (p: number[]) => p.length - WIN_MIN;
  // Pooled empirical quantiles per anchor horizon, over every market's last 8 hours.
  const pooled = ANCHORS.map((h) => {
    const all: number[] = [];
    for (const m of c.markets) all.push(...changesAt(m.prices, h, fromOf(m.prices)));
    return empQuantiles(all);
  });
  // Normal ensemble member: per-market robust scale, blended with the pooled scale.
  const scales = c.markets.map((m) => meanAbsDiff(m.prices, m.prices.length - NORM_WIN));
  const pooledScale = scales.reduce((a, b) => a + b, 0) / Math.max(1, scales.length);
  return c.markets.map((m, mi) => {
    if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
    const x = m.prices[m.prices.length - 1] as number;
    const mine = ANCHORS.map((h) => empQuantiles(changesAt(m.prices, h, fromOf(m.prices))));
    const scale = (BLEND_W * (scales[mi] as number) + (1 - BLEND_W) * pooledScale) * NORM_G;
    const empAt = (h: number, j: number): number => {
      let lo = 0;
      while (lo < ANCHORS.length - 1 && (ANCHORS[lo + 1] as number) < h) lo++;
      const hi = Math.min(ANCHORS.length - 1, lo + 1);
      const span = (ANCHORS[hi] as number) - (ANCHORS[lo] as number);
      const f = span === 0 ? 0 : (h - (ANCHORS[lo] as number)) / span;
      const pick = (arr: (number[] | null)[], idx: number): number => {
        const row = arr[idx] ?? pooled[idx];
        return row ? (row[j] as number) : (Z[j] as number) * 0.0025 * Math.sqrt(ANCHORS[idx] as number);
      };
      const oLo = BLEND_W * pick(mine, lo) + (1 - BLEND_W) * pick(pooled, lo);
      const oHi = BLEND_W * pick(mine, hi) + (1 - BLEND_W) * pick(pooled, hi);
      return oLo + (oHi - oLo) * f;
    };
    const rows: number[][] = [];
    for (let h = 1; h <= horizon; h++) {
      const row = QUANTILES.map((tau, j) => {
        const emp = tau === 0.5 ? x : x + empAt(h, j) * (TAIL_K[j] as number);
        const norm = x + (Z[j] as number) * scale * Math.sqrt(h);
        return price6((emp + norm) / 2);
      });
      row.sort((a, b) => a - b);
      rows.push(row);
    }
    return { id: m.id, q: rows };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = forecastAll(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
