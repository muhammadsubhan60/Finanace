import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatPKR, pctString } from "@delta/core";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const pkr = (m: number | null | undefined, exact = false) => (m == null ? "—" : formatPKR(m, { exact }));
export const pct = (r: number | null | undefined) => pctString(r ?? null);
export const dt = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "—";
export const day = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium" }).format(typeof d === "string" && d.length === 10 ? new Date(d + "T12:00:00+05:00") : new Date(d)) : "—";
export const maskPhone = (p?: string | null) => (p ? p.replace(/\d(?=\d{3})/g, "•") : "—");

export function qs(base: Record<string, string | undefined>, patch: Record<string, string | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
}
