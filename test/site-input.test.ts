import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import {
  buildSite,
  formatBytes,
  SiteInputError,
  validateExpiry,
  validatePassword,
  validateSubdomain,
} from "../src/pagey/site-input.js";

const limits = { maxFiles: 1000, maxBytes: 50 * 1024 * 1024 };

test("builds a single-file site and produces a deterministic zip", () => {
  const html = "<!doctype html><html><body><h1>Hello</h1></body></html>";
  const first = buildSite({ html }, limits);
  const second = buildSite({ html }, limits);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files, [{ path: "index.html", bytes: Buffer.byteLength(html) }]);
  assert.equal(first.totalBytes, Buffer.byteLength(html));
  const unzipped = unzipSync(first.zip);
  assert.equal(Buffer.from(unzipped["index.html"] as Uint8Array).toString("utf8"), html);
});

test("builds a multi-file site with base64 assets", () => {
  const png = Buffer.from("not-really-a-png").toString("base64");
  const built = buildSite(
    {
      html: "<!doctype html><link rel=stylesheet href=style.css>",
      files: [
        { path: "style.css", content: "body { color: #141a10; }" },
        { path: "assets/pixel.png", content: png, encoding: "base64" },
      ],
    },
    limits,
  );
  assert.equal(built.files.length, 3);
  assert.deepEqual(
    built.files.map((file) => file.path),
    ["assets/pixel.png", "index.html", "style.css"],
  );
  const unzipped = unzipSync(built.zip);
  assert.equal(Buffer.from(unzipped["assets/pixel.png"] as Uint8Array).toString("utf8"), "not-really-a-png");
});

test("requires index.html at the root", () => {
  assert.throws(() => buildSite({ files: [{ path: "about.html", content: "<h1>About</h1>" }] }, limits), SiteInputError);
  assert.throws(() => buildSite({ files: [{ path: "nested/index.html", content: "x" }] }, limits), /index.html at its root/);
  assert.throws(() => buildSite({}, limits), /Provide html/);
});

test("rejects unsafe and unsupported paths", () => {
  const cases: Array<[string, RegExp]> = [
    ["../index.html", /unsafe segment/],
    ["/index.html", /relative/],
    ["assets\\app.js", /forward slashes/],
    [".env", /Hidden/],
    ["assets/.hidden.js", /Hidden/],
    ["node_modules/pkg/index.html", /dependency/],
    ["assets/app.js.map", /source maps/],
    ["assets/key.pem", /source maps/],
    ["assets/app.exe", /Unsupported file type/],
    ["index", /Unsupported file type/],
  ];
  for (const [path, pattern] of cases) {
    assert.throws(() => buildSite({ html: "x", files: [{ path, content: "x" }] }, limits), pattern, path);
  }
});

test("rejects duplicate paths, including case-only duplicates", () => {
  assert.throws(
    () =>
      buildSite(
        {
          files: [
            { path: "index.html", content: "x" },
            { path: "index.html", content: "y" },
          ],
        },
        limits,
      ),
    /Duplicate file path/,
  );
  assert.throws(
    () =>
      buildSite(
        {
          files: [
            { path: "index.html", content: "x" },
            { path: "INDEX.html", content: "y" },
          ],
        },
        limits,
      ),
    /ignoring case/,
  );
});

test("rejects secrets in text files", () => {
  assert.throws(
    () =>
      buildSite(
        {
          html: '<script>const key = "ghp_abcdefghijklmnop";</script>',
        },
        limits,
      ),
    /private key or access token/,
  );
  assert.throws(
    () =>
      buildSite(
        {
          html: '<pre>-----BEGIN RSA PRIVATE KEY-----</pre>',
        },
        limits,
      ),
    /private key or access token/,
  );
});

test("enforces size and file limits", () => {
  assert.throws(
    () => buildSite({ html: "<p>hello</p>" }, { maxFiles: 1000, maxBytes: 5 }),
    /larger than the 5 B limit/,
  );
  assert.throws(
    () =>
      buildSite(
        {
          files: [
            { path: "index.html", content: "x" },
            { path: "two.html", content: "x" },
          ],
        },
        { maxFiles: 1, maxBytes: 100 },
      ),
    /at most 1 file/,
  );
});

test("validates base64 strictly", () => {
  assert.throws(
    () =>
      buildSite(
        { html: "x", files: [{ path: "a.png", content: "data:image/png;base64,AAAA", encoding: "base64" }] },
        limits,
      ),
    /raw base64/,
  );
  assert.throws(
    () => buildSite({ html: "x", files: [{ path: "a.png", content: "!!!!", encoding: "base64" }] }, limits),
    /Invalid base64/,
  );
});

test("validates subdomains, expiry, and passwords", () => {
  assert.equal(validateSubdomain("My-Site"), "my-site");
  assert.throws(() => validateSubdomain("-bad"), SiteInputError);
  assert.throws(() => validateSubdomain("bad--name"), SiteInputError);
  assert.throws(() => validateSubdomain("bad_name"), SiteInputError);
  assert.throws(() => validateExpiry("not-a-date"), SiteInputError);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(validateExpiry(future), future);
  assert.throws(() => validateExpiry(new Date(Date.now() - 1000).toISOString()), /future/);
  assert.equal(validatePassword("secret1"), "secret1");
  assert.throws(() => validatePassword("short"), /between 6 and 200/);
});

test("formats byte counts", () => {
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
});
