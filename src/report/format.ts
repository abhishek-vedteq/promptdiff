export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "unknown";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(4)}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "+12.5%" / "-3.0%" / "±0%"; empty when the base is zero or a value is missing. */
export function formatPercentChange(base: number | undefined, head: number | undefined): string {
  if (base === undefined || head === undefined || base === 0) return "";
  const pct = ((head - base) / base) * 100;
  if (Math.abs(pct) < 0.05) return "±0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
