import { DistributionPoint } from "./types";

export const BYTES_IN_GB = 1024 ** 3;

export function formatGb(bytes: number, decimals = 2) {
  return (bytes / BYTES_IN_GB).toFixed(decimals);
}

export function computeHourlyBurnGb(points: number[]) {
  if (!Array.isArray(points) || points.length < 2) return 0;

  const positiveDeltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i] - points[i - 1];
    if (Number.isFinite(delta) && delta > 0) {
      positiveDeltas.push(delta);
    }
  }

  if (positiveDeltas.length === 0) return 0;
  const averageBytesPerStep = positiveDeltas.reduce((sum, value) => sum + value, 0) / positiveDeltas.length;
  return averageBytesPerStep / BYTES_IN_GB;
}

export function createDistributionSparkline(points: DistributionPoint[]) {
  if (!points?.length) return [];
  return points.map((point) => point.value);
}

export function normalizeRingValue(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
