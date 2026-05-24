import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a byte count as a short human-readable string (e.g. "12.3 KB").
 * Returns "—" for non-positive or non-finite values so callers can pipe
 * `asset.size` directly without guarding.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const value = n / Math.pow(1000, i);
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
