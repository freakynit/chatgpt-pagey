import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptToken,
  deriveKey,
  encryptToken,
  safeEqual,
  sha256,
  signValue,
  verifyValue,
} from "../src/util/crypto.js";

const key = deriveKey("a".repeat(48), "test-purpose");

test("encrypts and decrypts tokens with AES-256-GCM", () => {
  const ciphertext = encryptToken("pagey-secret-token", key);
  assert.notEqual(ciphertext, "pagey-secret-token");
  assert.equal(decryptToken(ciphertext, key), "pagey-secret-token");
});

test("uses a fresh IV for every encryption", () => {
  const first = encryptToken("same", key);
  const second = encryptToken("same", key);
  assert.notEqual(first, second);
});

test("rejects tampered ciphertext and the wrong key", () => {
  const ciphertext = encryptToken("secret", key);
  const parts = ciphertext.split(".");
  const tampered = [...parts];
  tampered[3] = `${parts[3]?.slice(0, -2)}AA`;
  assert.throws(() => decryptToken(tampered.join("."), key));
  assert.throws(() => decryptToken(ciphertext, deriveKey("b".repeat(48), "test-purpose")));
});

test("signs and verifies cookie values", () => {
  const signed = signValue("hello", key);
  assert.equal(verifyValue(signed, key), "hello");
  assert.equal(verifyValue(`${signed}x`, key), undefined);
  assert.equal(verifyValue(signed, deriveKey("b".repeat(48), "test-purpose")), undefined);
});

test("derives different keys for different purposes", () => {
  assert.notDeepEqual(deriveKey("secret", "a"), deriveKey("secret", "b"));
});

test("hashes and compares safely", () => {
  assert.equal(sha256("abc").length, 64);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
