"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync, backup: sqliteBackup } = require("node:sqlite");
const { isDeepStrictEqual } = require("node:util");

const SCHEMA_VERSION = 1;
const ARCHIVE_KINDS = Object.freeze(["NOTE", "VOICE_REF", "RECAP"]);
const openFiles = new Set();

class PersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PersistenceError(code, message);
}

function createSqliteRepository(options = {}) {
  const configuredFilename = resolveFilename(options.filename);
  const filename = fs.existsSync(configuredFilename) ? fs.realpathSync(configuredFilename) : configuredFilename;
  const maxSnapshotBytes = positiveInteger(options.maxSnapshotBytes, 32 * 1024 * 1024, "maxSnapshotBytes");
  const now = options.now || Date.now;
  if (typeof now !== "function") fail("PERSISTENCE_INVALID_CONFIG", "now must be a function");

  const lock = acquireLock(filename);
  let database;
  let closed = false;
  try {
    database = new DatabaseSync(filename);
    setPrivateMode(filename);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;");
    initializeSchema(database);
    database.enableDefensive(true);
  } catch (error) {
    tryClose(database);
    lock.release();
    throw normalizeError(error, "Could not open the persistence database");
  }

  const selectCurrent = database.prepare(
    "SELECT revision, saved_at AS savedAt, schema_version AS schemaVersion, payload, checksum FROM current_snapshot WHERE singleton = 1",
  );
  const upsertCurrent = database.prepare(`
    INSERT INTO current_snapshot (singleton, revision, saved_at, schema_version, payload, checksum)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      revision = excluded.revision,
      saved_at = excluded.saved_at,
      schema_version = excluded.schema_version,
      payload = excluded.payload,
      checksum = excluded.checksum
  `);
  const selectArchive = database.prepare(
    "SELECT record_id AS recordId, room_id AS roomId, game_id AS gameId, kind, created_at AS createdAt, schema_version AS schemaVersion, payload, checksum FROM archive_records WHERE record_id = ?",
  );
  const insertArchive = database.prepare(`
    INSERT INTO archive_records (record_id, room_id, game_id, kind, created_at, schema_version, payload, checksum)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function ensureOpen() {
    if (closed) fail("PERSISTENCE_CLOSED", "Persistence repository is closed");
  }

  function load() {
    ensureOpen();
    return decodeSnapshotRow(selectCurrent.get());
  }

  function save(snapshot, saveOptions = {}) {
    ensureOpen();
    const encoded = encodeSnapshot(snapshot, maxSnapshotBytes);
    const expectedRevision = validateExpectedRevision(saveOptions.expectedRevision);
    return transaction(database, () => {
      const current = selectCurrent.get();
      const currentRevision = current?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const revision = nextRevision(currentRevision);
      const savedAt = timestamp(now);
      upsertCurrent.run(revision, savedAt, SCHEMA_VERSION, encoded.payload, encoded.checksum);
      return { revision, savedAt };
    });
  }

  function archive(record) {
    ensureOpen();
    const encoded = encodeArchive(record, now, maxSnapshotBytes);
    return transaction(database, () => {
      const existing = selectArchive.get(encoded.record.recordId);
      if (existing) {
        const decoded = decodeArchiveRow(existing, maxSnapshotBytes);
        if (!isDeepStrictEqual(decoded, encoded.record)) {
          fail("PERSISTENCE_ARCHIVE_CONFLICT", "Archive record ID is already bound to different content");
        }
        return structuredClone(decoded);
      }
      insertArchive.run(
        encoded.record.recordId,
        encoded.record.roomId,
        encoded.record.gameId,
        encoded.record.kind,
        encoded.record.createdAt,
        SCHEMA_VERSION,
        encoded.payload,
        encoded.checksum,
      );
      return structuredClone(encoded.record);
    });
  }

  function listArchives(filter = {}) {
    ensureOpen();
    const query = validateArchiveFilter(filter);
    const clauses = [];
    const parameters = [];
    for (const [column, value] of [["room_id", query.roomId], ["game_id", query.gameId], ["kind", query.kind]]) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const sql = `SELECT record_id AS recordId, room_id AS roomId, game_id AS gameId, kind, created_at AS createdAt,
      schema_version AS schemaVersion, payload, checksum FROM archive_records${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at, record_id`;
    return database.prepare(sql).all(...parameters).map((row) => decodeArchiveRow(row, maxSnapshotBytes));
  }

  async function backup(destination) {
    ensureOpen();
    const target = resolveOtherFilename(destination, filename, "backup destination");
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await sqliteBackup(database, temporary);
      setPrivateMode(temporary);
      fs.renameSync(temporary, target);
      setPrivateMode(target);
      return { filename: target, revision: selectCurrent.get()?.revision ?? 0 };
    } catch (error) {
      removeIfExists(temporary);
      throw normalizeError(error, "Could not create the persistence backup");
    }
  }

  function restore(source, restoreOptions = {}) {
    ensureOpen();
    const sourceFilename = resolveOtherFilename(source, filename, "restore source");
    const expectedRevision = validateExpectedRevision(restoreOptions.expectedRevision);
    const restored = readBackup(sourceFilename, maxSnapshotBytes);
    return transaction(database, () => {
      const currentRevision = selectCurrent.get()?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const revision = nextRevision(currentRevision);
      const savedAt = timestamp(now);
      database.exec("DELETE FROM archive_records");
      for (const item of restored.archives) {
        insertArchive.run(item.recordId, item.roomId, item.gameId, item.kind, item.createdAt, SCHEMA_VERSION, item.payload, item.checksum);
      }
      upsertCurrent.run(revision, savedAt, SCHEMA_VERSION, restored.snapshot.payload, restored.snapshot.checksum);
      return { revision, savedAt, snapshot: structuredClone(restored.snapshot.value) };
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      database.close();
    } finally {
      lock.release();
    }
  }

  return Object.freeze({ archive, backup, close, listArchives, load, restore, save });
}

function initializeSchema(database) {
  const version = Number(database.prepare("PRAGMA user_version").get().user_version);
  if (version === 0) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE current_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL CHECK (revision > 0),
          saved_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          checksum TEXT NOT NULL
        );
        CREATE TABLE archive_records (
          record_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          game_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('NOTE', 'VOICE_REF', 'RECAP')),
          created_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          checksum TEXT NOT NULL
        );
        CREATE INDEX archive_scope ON archive_records (room_id, game_id, kind, created_at);
        PRAGMA user_version = 1;
      `);
    });
    return;
  }
  if (version !== SCHEMA_VERSION) fail("PERSISTENCE_SCHEMA_UNSUPPORTED", "Persistence schema version is not supported");
  try {
    database.prepare("SELECT revision, saved_at, schema_version, payload, checksum FROM current_snapshot LIMIT 1").get();
    database.prepare("SELECT record_id, room_id, game_id, kind, created_at, schema_version, payload, checksum FROM archive_records LIMIT 1").get();
  } catch {
    fail("PERSISTENCE_SCHEMA_INVALID", "Persistence schema is incomplete");
  }
}

function readBackup(filename, maxSnapshotBytes) {
  let database;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const version = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (version !== SCHEMA_VERSION) fail("PERSISTENCE_SCHEMA_UNSUPPORTED", "Backup schema version is not supported");
    const snapshotRow = database.prepare(
      "SELECT revision, saved_at AS savedAt, schema_version AS schemaVersion, payload, checksum FROM current_snapshot WHERE singleton = 1",
    ).get();
    if (!snapshotRow) fail("PERSISTENCE_BACKUP_EMPTY", "Backup does not contain a current snapshot");
    const snapshot = decodeSnapshotRow(snapshotRow, maxSnapshotBytes);
    const archives = database.prepare(
      "SELECT record_id AS recordId, room_id AS roomId, game_id AS gameId, kind, created_at AS createdAt, schema_version AS schemaVersion, payload, checksum FROM archive_records ORDER BY created_at, record_id",
    ).all().map((row) => ({ ...decodeArchiveRow(row, maxSnapshotBytes), payload: row.payload, checksum: row.checksum }));
    return {
      snapshot: { value: snapshot.snapshot, payload: snapshotRow.payload, checksum: snapshotRow.checksum },
      archives,
    };
  } catch (error) {
    throw normalizeError(error, "Could not read the persistence backup");
  } finally {
    tryClose(database);
  }
}

function encodeSnapshot(snapshot, maxBytes) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(snapshot.rooms) || !Array.isArray(snapshot.idempotency)) {
    fail("PERSISTENCE_INVALID_SNAPSHOT", "Room snapshot schema is invalid");
  }
  const payload = stringifyJson(snapshot, maxBytes, "snapshot");
  return { payload, checksum: digest(payload) };
}

function decodeSnapshotRow(row, maxBytes = 32 * 1024 * 1024) {
  if (!row) return null;
  if (!Number.isSafeInteger(row.revision) || row.revision <= 0 || row.schemaVersion !== SCHEMA_VERSION ||
      typeof row.savedAt !== "string" || !Number.isFinite(Date.parse(row.savedAt)) || typeof row.payload !== "string" ||
      Buffer.byteLength(row.payload) > maxBytes || typeof row.checksum !== "string" || digest(row.payload) !== row.checksum) {
    fail("PERSISTENCE_CORRUPT", "Stored snapshot metadata or checksum is invalid");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(row.payload);
  } catch {
    fail("PERSISTENCE_CORRUPT", "Stored snapshot JSON is invalid");
  }
  try {
    encodeSnapshot(snapshot, maxBytes);
  } catch {
    fail("PERSISTENCE_CORRUPT", "Stored snapshot schema is invalid");
  }
  return { revision: row.revision, savedAt: row.savedAt, snapshot };
}

function encodeArchive(record, now, maxBytes) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.schemaVersion !== SCHEMA_VERSION) {
    fail("PERSISTENCE_INVALID_ARCHIVE", "Archive record schema is invalid");
  }
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    recordId: safeId(record.recordId, "recordId"),
    roomId: safeId(record.roomId, "roomId"),
    gameId: record.gameId === null || record.gameId === undefined ? null : safeId(record.gameId, "gameId"),
    kind: ARCHIVE_KINDS.includes(record.kind) ? record.kind : fail("PERSISTENCE_INVALID_ARCHIVE", "Archive kind is invalid"),
    createdAt: record.createdAt === undefined ? timestamp(now) : validTimestamp(record.createdAt, "createdAt"),
    data: record.data,
  };
  rejectSensitiveArchiveFields(normalized.data);
  const payload = stringifyJson(normalized, maxBytes, "archive record");
  return { record: normalized, payload, checksum: digest(payload) };
}

function decodeArchiveRow(row, maxBytes = 32 * 1024 * 1024) {
  if (!row || row.schemaVersion !== SCHEMA_VERSION || !ARCHIVE_KINDS.includes(row.kind) ||
      typeof row.payload !== "string" || Buffer.byteLength(row.payload) > maxBytes ||
      typeof row.checksum !== "string" || digest(row.payload) !== row.checksum) {
    fail("PERSISTENCE_CORRUPT", "Stored archive metadata or checksum is invalid");
  }
  let value;
  try {
    value = JSON.parse(row.payload);
    rejectSensitiveArchiveFields(value.data);
  } catch {
    fail("PERSISTENCE_CORRUPT", "Stored archive JSON is invalid");
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.recordId !== row.recordId || value.roomId !== row.roomId ||
      value.gameId !== row.gameId || value.kind !== row.kind || value.createdAt !== row.createdAt) {
    fail("PERSISTENCE_CORRUPT", "Stored archive fields do not match their index");
  }
  return value;
}

function validateArchiveFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) fail("PERSISTENCE_INVALID_ARCHIVE", "Archive filter is invalid");
  const allowed = new Set(["roomId", "gameId", "kind"]);
  if (Object.keys(filter).some((key) => !allowed.has(key))) fail("PERSISTENCE_INVALID_ARCHIVE", "Archive filter contains an unknown field");
  return {
    roomId: filter.roomId === undefined ? undefined : safeId(filter.roomId, "roomId"),
    gameId: filter.gameId === undefined ? undefined : safeId(filter.gameId, "gameId"),
    kind: filter.kind === undefined ? undefined : (ARCHIVE_KINDS.includes(filter.kind) ? filter.kind : fail("PERSISTENCE_INVALID_ARCHIVE", "Archive kind is invalid")),
  };
}

function rejectSensitiveArchiveFields(value, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("PERSISTENCE_INVALID_ARCHIVE", "Archive data must not be cyclic");
  seen.add(value);
  const forbidden = new Set(["token", "seattoken", "authorization", "apikey", "audio", "bytes"]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) fail("PERSISTENCE_INVALID_ARCHIVE", "Archive data contains credentials or raw audio");
    rejectSensitiveArchiveFields(child, seen);
  }
  seen.delete(value);
}

function stringifyJson(value, maxBytes, label) {
  validateJson(value);
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > maxBytes) fail("PERSISTENCE_PAYLOAD_TOO_LARGE", `${label} exceeds the size limit`);
  return payload;
}

function validateJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("PERSISTENCE_INVALID_JSON", "JSON numbers must be finite");
    return;
  }
  if (typeof value !== "object" || depth > 100) fail("PERSISTENCE_INVALID_JSON", "Value is not safe JSON data");
  if (seen.has(value)) fail("PERSISTENCE_INVALID_JSON", "JSON data must not be cyclic");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail("PERSISTENCE_INVALID_JSON", "JSON objects must be plain objects");
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) validateJson(child, seen, depth + 1);
  seen.delete(value);
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw normalizeError(error, "Persistence transaction failed");
  }
}

function acquireLock(filename, mayRecover = true) {
  if (openFiles.has(filename)) fail("PERSISTENCE_LOCKED", "Persistence database is already open by this process");
  const lockFilename = `${filename}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockFilename, "wx", 0o600);
    fs.writeFileSync(descriptor, owner, { encoding: "utf8" });
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === "EEXIST") {
      if (mayRecover && removeStaleLock(lockFilename)) return acquireLock(filename, false);
      fail("PERSISTENCE_LOCKED", "Persistence database is locked by another service");
    }
    throw normalizeError(error, "Could not acquire the persistence lock");
  }
  openFiles.add(filename);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        fs.closeSync(descriptor);
      } finally {
        openFiles.delete(filename);
        try {
          if (fs.readFileSync(lockFilename, "utf8") === owner) fs.unlinkSync(lockFilename);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    },
  };
}

function removeStaleLock(lockFilename) {
  let owner;
  try {
    owner = fs.readFileSync(lockFilename, "utf8");
  } catch {
    return false;
  }
  const match = /^(\d+):[0-9a-f-]+$/i.exec(owner);
  if (!match) return false;
  try {
    process.kill(Number(match[1]), 0);
    return false;
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  try {
    if (fs.readFileSync(lockFilename, "utf8") !== owner) return false;
    fs.unlinkSync(lockFilename);
    return true;
  } catch {
    return false;
  }
}

function resolveFilename(value) {
  if (typeof value !== "string" || !value.trim() || value === ":memory:") fail("PERSISTENCE_INVALID_CONFIG", "A filesystem SQLite filename is required");
  const candidate = path.resolve(value);
  const parent = path.dirname(candidate);
  try {
    if (!fs.statSync(parent).isDirectory()) fail("PERSISTENCE_INVALID_CONFIG", "Persistence parent must be a directory");
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    fail("PERSISTENCE_INVALID_CONFIG", "Persistence parent must be an existing directory");
  }
  return path.join(fs.realpathSync(parent), path.basename(candidate));
}

function resolveOtherFilename(value, current, label) {
  const filename = resolveFilename(value);
  if (filename === current || filename === `${current}.lock`) fail("PERSISTENCE_INVALID_CONFIG", `${label} must differ from the active database`);
  return filename;
}

function setPrivateMode(filename) {
  fs.chmodSync(filename, 0o600);
}

function removeIfExists(filename) {
  fs.rmSync(filename, { force: true });
}

function tryClose(database) {
  database?.close();
}

function normalizeError(error, message) {
  if (error instanceof PersistenceError) return error;
  return new PersistenceError("PERSISTENCE_IO_ERROR", message);
}

function validateExpectedRevision(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) fail("PERSISTENCE_INVALID_REVISION", "expectedRevision must be a non-negative safe integer");
  return value;
}

function assertExpectedRevision(expected, actual) {
  if (expected !== undefined && expected !== actual) fail("PERSISTENCE_REVISION_CONFLICT", "Persistence revision changed before the write");
}

function nextRevision(current) {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) fail("PERSISTENCE_CORRUPT", "Persistence revision is invalid");
  return current + 1;
}

function timestamp(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) fail("PERSISTENCE_INVALID_CONFIG", "Clock returned an invalid time");
  return new Date(value).toISOString();
}

function validTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("PERSISTENCE_INVALID_ARCHIVE", `${name} must be an ISO timestamp`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail("PERSISTENCE_INVALID_ARCHIVE", `${name} is invalid`);
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) fail("PERSISTENCE_INVALID_CONFIG", `${name} must be a positive integer`);
  return resolved;
}

module.exports = { ARCHIVE_KINDS, PersistenceError, SCHEMA_VERSION, createSqliteRepository };
