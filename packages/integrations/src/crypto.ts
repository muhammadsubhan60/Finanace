import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM for third-party credentials at rest. Key: APP_ENCRYPTION_KEY (32 bytes, base64 or hex). */
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set");
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptJson<T = Record<string, string>>(blob: string): T {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8")) as T;
}
