import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = "v1";

export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("pagey-mcp", "utf8"), Buffer.from(purpose, "utf8"), 32),
  );
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptToken(value: string, key: Buffer): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unsupported encrypted value");
  const [, ivPart, tagPart, ciphertextPart] = parts;
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error("Malformed encrypted value");
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export interface SignedValue {
  payload: string;
  signature: string;
}

export function signValue(payload: string, key: Buffer): string {
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(`${VERSION}.${encoded}`).digest("base64url");
  return `${VERSION}.${encoded}.${signature}`;
}

export function verifyValue(value: string, key: Buffer): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
  const [, encoded, signature] = parts;
  if (!encoded || !signature) return undefined;
  const expected = createHmac("sha256", key).update(`${VERSION}.${encoded}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return undefined;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  return Buffer.from(encoded, "base64url").toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
