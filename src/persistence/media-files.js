"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const HASH_PATTERN = /^[a-f0-9]{64}$/;

class MediaFileError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "MediaFileError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new MediaFileError(code, message, statusCode);
}

function createMediaFileStore(options = {}) {
  if (typeof options.directory !== "string" || !options.directory.trim()) {
    fail("MEDIA_INVALID_CONFIG", "A media directory is required");
  }
  const ttlMs = positiveInteger(options.ttlMs, 2 * 60 * 60_000, "ttlMs");
  const maxFileBytes = positiveInteger(options.maxFileBytes, 16 * 1024 * 1024, "maxFileBytes");
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, 128 * 1024 * 1024, "maxTotalBytes");
  if (maxFileBytes > maxTotalBytes) fail("MEDIA_INVALID_CONFIG", "maxFileBytes cannot exceed maxTotalBytes");
  const clock = options.clock || Date.now;
  if (typeof clock !== "function") fail("MEDIA_INVALID_CONFIG", "clock must be a function");

  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(options.directory);
  fs.chmodSync(directory, 0o700);
  sweepTemporaryFiles(directory);

  function put(input = {}) {
    const sha256 = validHash(input.sha256);
    const audio = copyBytes(input.audio);
    if (!audio.length) fail("MEDIA_INVALID_REQUEST", "Media bytes must not be empty", 400);
    if (audio.length > maxFileBytes) fail("MEDIA_PAYLOAD_TOO_LARGE", "Media file exceeds the size limit", 413);
    if (digest(audio) !== sha256) fail("MEDIA_HASH_MISMATCH", "Media hash does not match its content", 400);
    sweep();

    const filename = fileFor(directory, sha256);
    if (fs.existsSync(filename)) {
      const existing = readVerified(filename, sha256, ttlMs, readClock(clock));
      if (!existing.audio.equals(audio)) fail("MEDIA_HASH_COLLISION", "Existing media content does not match", 409);
      return existing.metadata;
    }
    const inventory = scan(directory);
    if (inventory.totalBytes + audio.length > maxTotalBytes) fail("MEDIA_STORAGE_LIMIT", "Media storage is full", 507);

    const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, audio);
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, 0o600);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const seconds = readClock(clock) / 1000;
      fs.utimesSync(temporary, seconds, seconds);
      fs.renameSync(temporary, filename);
      fs.chmodSync(filename, 0o600);
      return readVerified(filename, sha256, ttlMs, readClock(clock)).metadata;
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
      if (error instanceof MediaFileError) throw error;
      fail("MEDIA_IO_ERROR", "Could not store media file");
    }
  }

  function get(input = {}) {
    const sha256 = validHash(input.sha256);
    const filename = fileFor(directory, sha256);
    if (!fs.existsSync(filename)) fail("MEDIA_NOT_FOUND", "Media file was not found", 404);
    return readVerified(filename, sha256, ttlMs, readClock(clock));
  }

  function remove(sha256Value) {
    const sha256 = validHash(sha256Value);
    const filename = fileFor(directory, sha256);
    if (!fs.existsSync(filename)) return false;
    fs.unlinkSync(filename);
    return true;
  }

  function sweep() {
    const now = readClock(clock);
    let removed = 0;
    sweepTemporaryFiles(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const match = /^([a-f0-9]{64})\.audio$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const filename = path.join(directory, entry.name);
      if (expiry(fs.statSync(filename), ttlMs) <= now) {
        fs.unlinkSync(filename);
        removed += 1;
      }
    }
    return removed;
  }

  function stats() {
    sweep();
    const inventory = scan(directory);
    return { files: inventory.files, totalBytes: inventory.totalBytes, maxTotalBytes };
  }

  return Object.freeze({ directory, get, put, remove, stats, sweep });
}

function readVerified(filename, sha256, ttlMs, now) {
  const stat = fs.statSync(filename);
  const expiresAt = expiry(stat, ttlMs);
  if (expiresAt <= now) {
    fs.unlinkSync(filename);
    fail("MEDIA_EXPIRED", "Media file has expired", 404);
  }
  const audio = fs.readFileSync(filename);
  if (digest(audio) !== sha256) fail("MEDIA_CORRUPT", "Media content hash is invalid");
  return {
    audio,
    metadata: { sha256, size: audio.length, createdAt: Math.round(stat.mtimeMs), expiresAt },
  };
}

function scan(directory) {
  let files = 0;
  let totalBytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !HASH_PATTERN.test(entry.name.replace(/\.audio$/, "")) || !entry.name.endsWith(".audio")) continue;
    files += 1;
    totalBytes += fs.statSync(path.join(directory, entry.name)).size;
  }
  return { files, totalBytes };
}

function sweepTemporaryFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(".tmp-")) fs.unlinkSync(path.join(directory, entry.name));
  }
}

function fileFor(directory, sha256) {
  const filename = path.join(directory, `${sha256}.audio`);
  if (path.dirname(filename) !== directory) fail("MEDIA_INVALID_REQUEST", "Media path is invalid", 400);
  return filename;
}

function validHash(value) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail("MEDIA_INVALID_REQUEST", "A SHA-256 identifier is required", 400);
  return value;
}

function copyBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  fail("MEDIA_INVALID_REQUEST", "Media bytes are required", 400);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expiry(stat, ttlMs) {
  return Math.round(stat.mtimeMs) + ttlMs;
}

function readClock(clock) {
  const value = Number(clock());
  if (!Number.isSafeInteger(value) || value < 0) fail("MEDIA_INVALID_CONFIG", "Clock returned an invalid time");
  return value;
}

function positiveInteger(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0) fail("MEDIA_INVALID_CONFIG", `${name} must be a positive integer`);
  return result;
}

module.exports = { MediaFileError, createMediaFileStore };
