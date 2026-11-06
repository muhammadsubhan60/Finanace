import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** FileStore: local disk by default. Swap point for S3/R2 (only metadata goes to MongoDB). */
export interface FileStore {
  put(name: string, data: Buffer, contentType: string): Promise<{ path: string; size: number }>;
}

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/csv"]);

export const localStore: FileStore = {
  async put(name, data, contentType) {
    if (!ALLOWED.has(contentType)) throw new Error("Only JPG, PNG, WebP, PDF or CSV files are allowed");
    if (data.length > 10 * 1024 * 1024) throw new Error("Max 10 MB per file");
    const dir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads", new Date().toISOString().slice(0, 7));
    await mkdir(dir, { recursive: true });
    const safe = `${randomUUID()}-${name.replace(/[^\w.-]/g, "_").slice(-80)}`;
    await writeFile(path.join(dir, safe), data);
    return { path: path.join(new Date().toISOString().slice(0, 7), safe), size: data.length };
  },
};
