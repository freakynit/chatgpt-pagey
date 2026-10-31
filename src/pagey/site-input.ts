import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".txt",
  ".xml",
  ".csv",
  ".webmanifest",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
  ".mp4",
  ".webm",
  ".ogg",
  ".mov",
  ".mp3",
  ".wav",
  ".aac",
  ".m4a",
  ".flac",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".pdf",
  ".md",
]);

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".txt",
  ".xml",
  ".csv",
  ".webmanifest",
  ".svg",
  ".md",
]);

const BLOCKED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "coverage",
  "__macosx",
  "thumbs.db",
  "desktop.ini",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

const BLOCKED_EXTENSIONS = new Set([".map", ".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"]);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp_|github_pat_|sk-(?:live|test|proj)-|xox[bpas]-)[A-Za-z0-9_-]{8,}\b/u,
];

export const DEFAULT_LIMITS = {
  maxFiles: 1000,
  maxBytes: 50 * 1024 * 1024,
};

export interface SiteFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface BuildSiteInput {
  html?: string;
  files?: SiteFileInput[];
}

export interface BuiltFile {
  path: string;
  bytes: number;
}

export interface BuiltSite {
  zip: Uint8Array;
  files: BuiltFile[];
  totalBytes: number;
  digest: string;
}

export class SiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInputError";
  }
}

/**
 * Turns a model-provided HTML string or file list into a Pagey-compatible ZIP.
 *
 * The ZIP is stored (no compression) so Pagey's compression-ratio bomb guard
 * can never reject ordinary, highly repetitive HTML. Content is still capped
 * by file count and total decoded size.
 */
export function buildSite(input: BuildSiteInput, limits = DEFAULT_LIMITS): BuiltSite {
  const files = new Map<string, { bytes: Uint8Array; text: boolean }>();
  const lowerPaths = new Set<string>();

  const addFile = (rawPath: string, content: string, encoding: "utf8" | "base64"): void => {
    const path = validatePath(rawPath, limits);
    if (files.has(path)) throw new SiteInputError(`Duplicate file path: ${path}`);
    const lower = path.toLowerCase();
    if (lowerPaths.has(lower)) {
      throw new SiteInputError(`Duplicate file path ignoring case: ${path}`);
    }
    lowerPaths.add(lower);

    const bytes = decodeContent(path, content, encoding);
    files.set(path, { bytes, text: encoding === "utf8" });
  };

  const html = input.html;
  if (html !== undefined) {
    if (typeof html !== "string" || html.trim() === "") {
      throw new SiteInputError("html must be a non-empty string of HTML.");
    }
    if (html.includes("\u0000")) throw new SiteInputError("html contains a NUL character.");
    addFile("index.html", html, "utf8");
  }

  for (const file of input.files ?? []) {
    if (file === null || typeof file !== "object") {
      throw new SiteInputError("Each entry in files must be an object with path and content.");
    }
    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new SiteInputError("Each file needs a non-empty path.");
    }
    if (typeof file.content !== "string") {
      throw new SiteInputError(`content for ${file.path} must be a string.`);
    }
    const encoding = file.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new SiteInputError(`encoding for ${file.path} must be "utf8" or "base64".`);
    }
    addFile(file.path, file.content, encoding);
  }

  if (files.size === 0) {
    throw new SiteInputError("Provide html, or files that include index.html at the site root.");
  }
  if (!files.has("index.html")) {
    throw new SiteInputError("The site must include index.html at its root. Add index.html to files or pass html.");
  }
  if (files.size > limits.maxFiles) {
    throw new SiteInputError(
      `A site can contain at most ${limits.maxFiles} ${limits.maxFiles === 1 ? "file" : "files"}.`,
    );
  }

  let totalBytes = 0;
  const manifest: BuiltFile[] = [];
  const zipRecord: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;

  for (const [path, entry] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > limits.maxBytes) {
      throw new SiteInputError(
        `Site content is larger than the ${formatBytes(limits.maxBytes)} limit. Reduce assets and try again.`,
      );
    }
    manifest.push({ path, bytes: entry.bytes.byteLength });
    zipRecord[path] = entry.bytes;
  }

  if (totalBytes === 0) throw new SiteInputError("The site is empty.");

  const zip = zipSync(zipRecord, { level: 0, mtime: new Date(1980, 0, 1) });
  const digest = createHash("sha256").update(zip).digest("hex");
  return { zip, files: manifest, totalBytes, digest };
}

export function validateSubdomain(value: string): string {
  const subdomain = value.trim().toLowerCase();
  if (subdomain.length < 1 || subdomain.length > 63) {
    throw new SiteInputError("Subdomain must be 1 to 63 characters long.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(subdomain)) {
    throw new SiteInputError(
      "Subdomain can only contain lowercase letters, numbers, and single hyphens between them.",
    );
  }
  return subdomain;
}

export function validateExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new SiteInputError("expires_at must be an ISO 8601 date-time.");
  if (timestamp <= Date.now() + 60_000) throw new SiteInputError("expires_at must be in the future.");
  return new Date(timestamp).toISOString();
}

export function validatePassword(value: string): string {
  if (value.length < 6 || value.length > 200) {
    throw new SiteInputError("Password must be between 6 and 200 characters.");
  }
  return value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validatePath(rawPath: string, limits: { maxFiles: number }): string {
  const path = rawPath.trim();
  if (path.length === 0 || path.length > 240) {
    throw new SiteInputError("Each file path must be between 1 and 240 characters.");
  }
  if (path.includes("\\")) throw new SiteInputError(`Use forward slashes in file paths: ${path}`);
  if (path.startsWith("/") || path.startsWith("./")) {
    throw new SiteInputError(`File paths must be relative to the site root: ${path}`);
  }
  if (path.endsWith("/")) throw new SiteInputError(`File paths must name a file, not a directory: ${path}`);
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new SiteInputError(`File path contains control characters: ${path}`);

  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SiteInputError(`File path contains an unsafe segment: ${path}`);
  }
  for (const segment of segments) {
    if (segment.startsWith(".")) {
      throw new SiteInputError(`Hidden files and directories are not published: ${path}`);
    }
    if (BLOCKED_SEGMENTS.has(segment.toLowerCase())) {
      throw new SiteInputError(`Refusing to publish project or dependency file: ${path}`);
    }
  }

  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new SiteInputError(`Refusing to publish ${path}: source maps, keys, and databases are not site assets.`);
  }
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
    throw new SiteInputError(
      `Unsupported file type ${extension || "(none)"} for ${path}. Pagey accepts HTML, CSS, JS, JSON, images, fonts, media, and similar static assets.`,
    );
  }
  if (segments.length > 20) throw new SiteInputError(`File path is nested too deeply: ${path}`);
  if (limits.maxFiles < 1) throw new SiteInputError("Invalid file limit.");
  return path;
}

function decodeContent(path: string, content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") {
    return decodeBase64(path, content);
  }
  if (content.includes("\u0000")) throw new SiteInputError(`${path} contains a NUL character.`);
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        throw new SiteInputError(
          `Refusing to publish ${path}: it contains what looks like a private key or access token. Remove the secret first.`,
        );
      }
    }
  }
  const bytes = Buffer.from(content, "utf8");
  if (path === "index.html" && content.trim() === "") {
    throw new SiteInputError("index.html is empty. Provide the page HTML.");
  }
  return bytes;
}

function decodeBase64(path: string, content: string): Uint8Array {
  const compact = content.replace(/\s+/gu, "");
  if (compact === "") return Buffer.alloc(0);
  if (compact.startsWith("data:")) {
    throw new SiteInputError(`Pass raw base64 for ${path}, without a data: URL prefix.`);
  }
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) {
    throw new SiteInputError(`Invalid base64 content for ${path}.`);
  }
  const bytes = Buffer.from(compact, "base64");
  const expected = compact.replace(/=+$/u, "");
  if (bytes.toString("base64").replace(/=+$/u, "") !== expected) {
    throw new SiteInputError(`Invalid base64 content for ${path}.`);
  }
  return bytes;
}
