import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '0s'
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 1) {
    return `${seconds.toFixed(2)}s`
  }
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`
  }
  return `${Math.round(seconds)}s`
}
