import type { DiffReport } from "../types.js";

export function renderJson(report: DiffReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
