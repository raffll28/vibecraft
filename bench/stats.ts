/** Small helpers shared by the benchmarks */

export interface Summary {
  n: number
  mean: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

export function printTable(rows: ({ name: string } & Summary)[], unit: string): void {
  const fmt = (v: number) => v.toFixed(2).padStart(9)
  console.log(`${'case'.padEnd(22)}${['mean', 'p50', 'p95', 'p99', 'min', 'max'].map((h) => h.padStart(9)).join('')}  (${unit})`)
  for (const r of rows) {
    console.log(`${r.name.padEnd(22)}${[r.mean, r.p50, r.p95, r.p99, r.min, r.max].map(fmt).join('')}`)
  }
}

/** Resident memory of a process in MiB (Linux), or NaN if unavailable */
export async function rssMiB(pid: number): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf-8')
    const kb = parseInt(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? '', 10)
    return kb / 1024
  } catch {
    return NaN
  }
}
