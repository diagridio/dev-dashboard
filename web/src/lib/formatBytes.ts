const UNITS = ['KiB', 'MiB', 'GiB', 'TiB']

/** Human-readable binary size: 512 -> "512 B", 131102 -> "128.0 KiB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  let v = n / 1024
  let i = 0
  // Compare the rounded value so 1048575 reads "1.0 MiB", not "1024.0 KiB".
  while (Number(v.toFixed(1)) >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${UNITS[i]}`
}
