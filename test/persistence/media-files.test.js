"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");

const { MediaFileError, createMediaFileStore } = require("../../src/persistence/media-files");

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-media-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectCode(code, callback, statusCode) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof MediaFileError, true);
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

describe("content-addressed media files", () => {
  it("writes atomically with private permissions and survives store restart", (t) => {
    let now = 1_000;
    const folder = directory(t);
    const audio = Buffer.from("retained original voice");
    const sha256 = hash(audio);
    const first = createMediaFileStore({ directory: folder, clock: () => now, ttlMs: 10_000 });
    const stored = first.put({ sha256, audio });
    assert.deepEqual(stored, { sha256, size: audio.length, createdAt: 1_000, expiresAt: 11_000 });
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    const files = fs.readdirSync(folder);
    assert.deepEqual(files, [`${sha256}.audio`]);
    assert.equal(fs.statSync(path.join(folder, files[0])).mode & 0o777, 0o600);
    audio.fill(0);

    const restarted = createMediaFileStore({ directory: folder, clock: () => now, ttlMs: 10_000 });
    const loaded = restarted.get({ sha256 });
    assert.equal(loaded.audio.toString(), "retained original voice");
    loaded.audio.fill(0);
    assert.equal(restarted.get({ sha256 }).audio.toString(), "retained original voice");
    assert.deepEqual(restarted.stats(), { files: 1, totalBytes: 23, maxTotalBytes: 128 * 1024 * 1024 });
    now += 1;
  });

  it("makes duplicate content idempotent without extending retention", (t) => {
    let now = 5_000;
    const audio = Buffer.from("same");
    const store = createMediaFileStore({ directory: directory(t), clock: () => now, ttlMs: 100 });
    const first = store.put({ sha256: hash(audio), audio });
    now = 5_050;
    assert.deepEqual(store.put({ sha256: hash(audio), audio: Uint8Array.from(audio) }), first);
    assert.deepEqual(store.put({ sha256: hash(audio), audio: Uint8Array.from(audio).buffer }), first);
  });

  it("expires files by persisted mtime and removes abandoned temp files", (t) => {
    let now = 0;
    const folder = directory(t);
    fs.writeFileSync(path.join(folder, ".tmp-crashed"), "partial");
    const audio = Buffer.from("voice");
    const sha256 = hash(audio);
    const store = createMediaFileStore({ directory: folder, clock: () => now, ttlMs: 10 });
    assert.equal(fs.existsSync(path.join(folder, ".tmp-crashed")), false);
    store.put({ sha256, audio });
    now = 10;
    assert.equal(store.sweep(), 1);
    expectCode("MEDIA_NOT_FOUND", () => store.get({ sha256 }), 404);
    assert.deepEqual(store.stats(), { files: 0, totalBytes: 0, maxTotalBytes: 128 * 1024 * 1024 });
  });

  it("refuses an expired file on direct read and deletes it", (t) => {
    let now = 100;
    const folder = directory(t);
    const audio = Buffer.from("short lived");
    const sha256 = hash(audio);
    const store = createMediaFileStore({ directory: folder, clock: () => now, ttlMs: 5 });
    store.put({ sha256, audio });
    now = 105;
    expectCode("MEDIA_EXPIRED", () => store.get({ sha256 }), 404);
    assert.equal(fs.existsSync(path.join(folder, `${sha256}.audio`)), false);
  });

  it("removes media explicitly and treats a repeated removal as absent", (t) => {
    const audio = Buffer.from("delete me");
    const sha256 = hash(audio);
    const store = createMediaFileStore({ directory: directory(t) });
    store.put({ sha256, audio });
    assert.equal(store.remove(sha256), true);
    assert.equal(store.remove(sha256), false);
  });
});

describe("media validation and limits", () => {
  it("rejects invalid configuration", (t) => {
    const folder = directory(t);
    for (const options of [
      {},
      { directory: "" },
      { directory: folder, ttlMs: 0 },
      { directory: folder, maxFileBytes: 0 },
      { directory: folder, maxTotalBytes: 0 },
      { directory: folder, maxFileBytes: 2, maxTotalBytes: 1 },
      { directory: folder, clock: 4 },
    ]) expectCode("MEDIA_INVALID_CONFIG", () => createMediaFileStore(options));
    const badClock = createMediaFileStore({ directory: folder, clock: () => -1 });
    expectCode("MEDIA_INVALID_CONFIG", () => badClock.stats());
  });

  it("rejects invalid hashes, bytes, empty files, mismatches, and oversized files", (t) => {
    const store = createMediaFileStore({ directory: directory(t), maxFileBytes: 4, maxTotalBytes: 8 });
    for (const value of [null, "", "../voice", "A".repeat(64), "a".repeat(63)]) {
      expectCode("MEDIA_INVALID_REQUEST", () => store.get({ sha256: value }), 400);
    }
    expectCode("MEDIA_INVALID_REQUEST", () => store.put({ sha256: "a".repeat(64), audio: "voice" }), 400);
    expectCode("MEDIA_INVALID_REQUEST", () => store.put({ sha256: hash(Buffer.alloc(0)), audio: Buffer.alloc(0) }), 400);
    expectCode("MEDIA_HASH_MISMATCH", () => store.put({ sha256: "a".repeat(64), audio: Buffer.from("x") }), 400);
    expectCode("MEDIA_PAYLOAD_TOO_LARGE", () => store.put({ sha256: hash(Buffer.alloc(5)), audio: Buffer.alloc(5) }), 413);
  });

  it("enforces total capacity after accounting for files already on disk", (t) => {
    const store = createMediaFileStore({ directory: directory(t), maxFileBytes: 4, maxTotalBytes: 5 });
    const first = Buffer.from("1234");
    const second = Buffer.from("56");
    store.put({ sha256: hash(first), audio: first });
    expectCode("MEDIA_STORAGE_LIMIT", () => store.put({ sha256: hash(second), audio: second }), 507);
    assert.deepEqual(store.stats(), { files: 1, totalBytes: 4, maxTotalBytes: 5 });
  });

  it("detects content corruption instead of serving bytes under a false hash", (t) => {
    const folder = directory(t);
    const original = Buffer.from("original");
    const sha256 = hash(original);
    const store = createMediaFileStore({ directory: folder });
    store.put({ sha256, audio: original });
    fs.writeFileSync(path.join(folder, `${sha256}.audio`), "tampered");
    expectCode("MEDIA_CORRUPT", () => store.get({ sha256 }));
  });

  it("ignores unrelated directory entries when sweeping and counting", (t) => {
    const folder = directory(t);
    fs.mkdirSync(path.join(folder, "subdirectory"));
    fs.writeFileSync(path.join(folder, "readme.txt"), "ignore");
    const store = createMediaFileStore({ directory: folder });
    assert.equal(store.sweep(), 0);
    assert.deepEqual(store.stats(), { files: 0, totalBytes: 0, maxTotalBytes: 128 * 1024 * 1024 });
  });
});
