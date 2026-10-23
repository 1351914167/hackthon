"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { describe, it } = require("node:test");

const { ARCHIVE_KINDS, PersistenceError, createSqliteRepository } = require("../../src/persistence");

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-persistence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    database: path.join(directory, "rooms.sqlite"),
    backup: path.join(directory, "backup.sqlite"),
  };
}

function snapshot(label = "one") {
  return {
    schemaVersion: 1,
    rooms: [{ roomId: "ROOM1", seats: [{ seatId: "seat-1", seatToken: `private-${label}` }], label }],
    idempotency: [[`create:${label}`, { roomId: "ROOM1" }]],
  };
}

function archiveRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    recordId: "note-1",
    roomId: "ROOM1",
    gameId: "game-1",
    kind: "NOTE",
    createdAt: "2026-10-23T10:00:00.000Z",
    data: { seatId: "seat-1", label: "关键发言", text: "7号发言前后矛盾" },
    ...overrides,
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof PersistenceError, true);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("private-"), false);
    return true;
  });
}

async function expectCodeAsync(code, promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof PersistenceError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function raw(filename, callback) {
  const database = new DatabaseSync(filename);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("SQLite room snapshot lifecycle", () => {
  it("persists private room state with revisions and restrictive file modes", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database, now: () => 1_761_210_000_000 });
    t.after(() => repository.close());
    assert.equal(repository.load(), null);
    assert.equal(fs.statSync(files.database).mode & 0o777, 0o600);
    assert.equal(fs.statSync(`${files.database}.lock`).mode & 0o777, 0o600);

    assert.deepEqual(repository.save(snapshot("first"), { expectedRevision: 0 }), {
      revision: 1,
      savedAt: "2025-10-23T09:00:00.000Z",
    });
    const loaded = repository.load();
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.snapshot.rooms[0].seats[0].seatToken, "private-first");
    loaded.snapshot.rooms[0].label = "mutated";
    assert.equal(repository.load().snapshot.rooms[0].label, "first");

    assert.equal(repository.save(snapshot("second"), { expectedRevision: 1 }).revision, 2);
    assert.equal(repository.load().snapshot.rooms[0].label, "second");
  });

  it("survives close and reopen while preventing two repository writers", (t) => {
    const files = workspace(t);
    const first = createSqliteRepository({ filename: files.database });
    first.save(snapshot(), { expectedRevision: 0 });
    expectCode("PERSISTENCE_LOCKED", () => createSqliteRepository({ filename: files.database }));
    first.close();
    first.close();
    assert.equal(fs.existsSync(`${files.database}.lock`), false);
    expectCode("PERSISTENCE_CLOSED", () => first.load());

    const restarted = createSqliteRepository({ filename: files.database });
    assert.equal(restarted.load().snapshot.rooms[0].label, "one");
    restarted.close();
  });

  it("enforces optimistic revision checks without changing the stored snapshot", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    repository.save(snapshot("first"));
    expectCode("PERSISTENCE_REVISION_CONFLICT", () => repository.save(snapshot("stale"), { expectedRevision: 0 }));
    expectCode("PERSISTENCE_INVALID_REVISION", () => repository.save(snapshot("bad"), { expectedRevision: -1 }));
    expectCode("PERSISTENCE_INVALID_REVISION", () => repository.save(snapshot("bad"), { expectedRevision: 0.5 }));
    assert.equal(repository.load().snapshot.rooms[0].label, "first");
  });

  it("rolls back an interrupted save transaction", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    repository.save(snapshot("stable"));
    raw(files.database, (database) => database.exec(`
      CREATE TRIGGER reject_snapshot BEFORE UPDATE ON current_snapshot
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `));
    expectCode("PERSISTENCE_IO_ERROR", () => repository.save(snapshot("partial"), { expectedRevision: 1 }));
    assert.equal(repository.load().revision, 1);
    assert.equal(repository.load().snapshot.rooms[0].label, "stable");
  });
});

describe("archive records", () => {
  it("stores notes, voice references, and recaps without credentials or raw audio", (t) => {
    const files = workspace(t);
    let timestamp = Date.parse("2026-10-23T11:00:00.000Z");
    const repository = createSqliteRepository({ filename: files.database, now: () => timestamp });
    t.after(() => repository.close());
    assert.deepEqual(ARCHIVE_KINDS, ["NOTE", "VOICE_REF", "RECAP"]);
    repository.archive(archiveRecord());
    repository.archive(archiveRecord({
      recordId: "voice-1",
      kind: "VOICE_REF",
      createdAt: undefined,
      data: { segmentId: "segment-1", speakerSeatId: "seat-3", phaseKey: "round-1:speech-3", transcript: "发言" },
    }));
    repository.archive(archiveRecord({ recordId: "recap-1", gameId: null, kind: "RECAP", data: { evidenceIds: ["voice-1"] } }));

    assert.equal(repository.listArchives().length, 3);
    assert.deepEqual(repository.listArchives({ kind: "VOICE_REF" })[0].data, {
      segmentId: "segment-1",
      speakerSeatId: "seat-3",
      phaseKey: "round-1:speech-3",
      transcript: "发言",
    });
    assert.equal(repository.listArchives({ roomId: "ROOM1", gameId: "game-1" }).length, 2);
    assert.equal(repository.listArchives({ gameId: "missing" }).length, 0);
    timestamp += 1;
  });

  it("makes identical archive retries idempotent and rejects record rewriting", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    const first = repository.archive(archiveRecord());
    const retry = repository.archive(structuredClone(archiveRecord()));
    assert.deepEqual(retry, first);
    retry.data.text = "caller mutation";
    expectCode("PERSISTENCE_ARCHIVE_CONFLICT", () => repository.archive(archiveRecord({ data: { text: "updated" } })));
    assert.equal(repository.listArchives()[0].data.text, "7号发言前后矛盾");
    assert.equal(repository.listArchives().length, 1);
  });

  it("rejects unsafe archive schemas, filters, credentials, raw audio, and cycles", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    const cyclic = {};
    cyclic.self = cyclic;
    for (const value of [
      null,
      {},
      archiveRecord({ schemaVersion: 2 }),
      archiveRecord({ recordId: "bad id" }),
      archiveRecord({ roomId: "" }),
      archiveRecord({ gameId: "bad/id" }),
      archiveRecord({ kind: "AUDIO" }),
      archiveRecord({ createdAt: "not-a-time" }),
      archiveRecord({ data: { seatToken: "secret" } }),
      archiveRecord({ data: { nested: { Authorization: "secret" } } }),
      archiveRecord({ data: { audio: Buffer.from("raw") } }),
      archiveRecord({ data: cyclic }),
    ]) expectCode("PERSISTENCE_INVALID_ARCHIVE", () => repository.archive(value));

    for (const filter of [null, [], { unknown: true }, { roomId: "bad/id" }, { kind: "OTHER" }]) {
      expectCode("PERSISTENCE_INVALID_ARCHIVE", () => repository.listArchives(filter));
    }
  });
});

describe("backup and restore", () => {
  it("backs up a consistent snapshot and replaces state and archives on restore", async (t) => {
    const files = workspace(t);
    let timestamp = Date.parse("2026-10-23T12:00:00.000Z");
    const repository = createSqliteRepository({ filename: files.database, now: () => timestamp });
    t.after(() => repository.close());
    repository.save(snapshot("backup"));
    repository.archive(archiveRecord());
    const canonicalBackup = path.join(fs.realpathSync(files.directory), "backup.sqlite");
    assert.deepEqual(await repository.backup(files.backup), { filename: canonicalBackup, revision: 1 });
    assert.equal(fs.statSync(files.backup).mode & 0o777, 0o600);

    const fresh = createSqliteRepository({ filename: path.join(files.directory, "fresh.sqlite"), now: () => timestamp });
    assert.equal(fresh.restore(files.backup, { expectedRevision: 0 }).revision, 1);
    assert.equal(fresh.load().snapshot.rooms[0].label, "backup");
    fresh.close();

    repository.save(snapshot("newer"), { expectedRevision: 1 });
    repository.archive(archiveRecord({ recordId: "extra", kind: "RECAP", data: { text: "remove on restore" } }));
    timestamp += 1_000;
    const restored = repository.restore(files.backup, { expectedRevision: 2 });
    assert.equal(restored.revision, 3);
    assert.equal(restored.snapshot.rooms[0].label, "backup");
    restored.snapshot.rooms[0].label = "mutated result";
    assert.equal(repository.load().snapshot.rooms[0].label, "backup");
    assert.deepEqual(repository.listArchives().map((item) => item.recordId), ["note-1"]);
  });

  it("rolls back archive replacement when restore cannot update the snapshot", async (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    repository.save(snapshot("backup"));
    repository.archive(archiveRecord());
    await repository.backup(files.backup);
    repository.save(snapshot("current"));
    repository.archive(archiveRecord({ recordId: "current-note", data: { text: "must survive" } }));
    raw(files.database, (database) => database.exec(`
      CREATE TRIGGER reject_restore BEFORE UPDATE ON current_snapshot
      BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;
    `));

    expectCode("PERSISTENCE_IO_ERROR", () => repository.restore(files.backup));
    assert.equal(repository.load().snapshot.rooms[0].label, "current");
    assert.deepEqual(repository.listArchives().map((item) => item.recordId), ["current-note", "note-1"]);
  });

  it("rejects corrupt and incompatible backups without mutating current state", async (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    repository.save(snapshot("safe"));
    await repository.backup(files.backup);

    raw(files.backup, (database) => database.exec("UPDATE current_snapshot SET payload = '{bad json}'"));
    expectCode("PERSISTENCE_CORRUPT", () => repository.restore(files.backup));
    assert.equal(repository.load().snapshot.rooms[0].label, "safe");

    raw(files.backup, (database) => database.exec("PRAGMA user_version = 99"));
    expectCode("PERSISTENCE_SCHEMA_UNSUPPORTED", () => repository.restore(files.backup));
    assert.equal(repository.load().revision, 1);
  });

  it("rejects empty backups, active database paths, invalid revisions, and backup I/O errors", async (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database });
    t.after(() => repository.close());
    repository.save(snapshot());
    expectCode("PERSISTENCE_INVALID_CONFIG", () => repository.restore(files.database));
    await expectCodeAsync("PERSISTENCE_INVALID_CONFIG", repository.backup(files.database));

    const empty = path.join(files.directory, "empty.sqlite");
    const emptyRepository = createSqliteRepository({ filename: empty });
    assert.equal((await emptyRepository.backup(path.join(files.directory, "empty-copy.sqlite"))).revision, 0);
    emptyRepository.close();
    expectCode("PERSISTENCE_BACKUP_EMPTY", () => repository.restore(empty));
    expectCode("PERSISTENCE_INVALID_REVISION", () => repository.restore(empty, { expectedRevision: "1" }));
    await expectCodeAsync("PERSISTENCE_INVALID_CONFIG", repository.backup(path.join(files.directory, "missing", "backup.sqlite")));
    const directoryTarget = path.join(files.directory, "target-directory");
    fs.mkdirSync(directoryTarget);
    await expectCodeAsync("PERSISTENCE_IO_ERROR", repository.backup(directoryTarget));
  });
});

describe("schema and corruption defenses", () => {
  it("rejects invalid repository configuration and unsupported database schemas", (t) => {
    const files = workspace(t);
    expectCode("PERSISTENCE_INVALID_CONFIG", () => createSqliteRepository({}));
    expectCode("PERSISTENCE_INVALID_CONFIG", () => createSqliteRepository({ filename: ":memory:" }));
    expectCode("PERSISTENCE_INVALID_CONFIG", () => createSqliteRepository({ filename: files.database, maxSnapshotBytes: 0 }));
    expectCode("PERSISTENCE_INVALID_CONFIG", () => createSqliteRepository({ filename: files.database, now: 4 }));

    const badClock = createSqliteRepository({ filename: path.join(files.directory, "bad-clock.sqlite"), now: () => -1 });
    expectCode("PERSISTENCE_INVALID_CONFIG", () => badClock.save(snapshot()));
    badClock.close();

    raw(files.database, (database) => database.exec("PRAGMA user_version = 7"));
    expectCode("PERSISTENCE_SCHEMA_UNSUPPORTED", () => createSqliteRepository({ filename: files.database }));

    const incomplete = path.join(files.directory, "incomplete.sqlite");
    raw(incomplete, (database) => database.exec("PRAGMA user_version = 1"));
    expectCode("PERSISTENCE_SCHEMA_INVALID", () => createSqliteRepository({ filename: incomplete }));
  });

  it("rejects non-JSON, oversized, or malformed room snapshots", (t) => {
    const files = workspace(t);
    const repository = createSqliteRepository({ filename: files.database, maxSnapshotBytes: 200 });
    t.after(() => repository.close());
    const cyclic = snapshot();
    cyclic.self = cyclic;
    class Custom { constructor() { this.value = 1; } }
    const invalids = [
      null,
      {},
      { ...snapshot(), schemaVersion: 2 },
      { ...snapshot(), rooms: null },
      { ...snapshot(), idempotency: null },
      { ...snapshot(), extra: undefined },
      { ...snapshot(), extra: NaN },
      { ...snapshot(), extra: 1n },
      { ...snapshot(), extra: new Custom() },
      cyclic,
      { ...snapshot(), extra: "x".repeat(500) },
    ];
    for (const value of invalids) assert.throws(() => repository.save(value), PersistenceError);
    assert.equal(repository.load(), null);
  });

  it("detects stored checksum, JSON, schema, and revision corruption", (t) => {
    const variants = [
      (database) => database.exec("UPDATE current_snapshot SET checksum = 'wrong'"),
      (database) => {
        const payload = "{bad";
        database.prepare("UPDATE current_snapshot SET payload = ?, checksum = ?").run(payload, checksum(payload));
      },
      (database) => {
        const payload = JSON.stringify({ schemaVersion: 2, rooms: [], idempotency: [] });
        database.prepare("UPDATE current_snapshot SET payload = ?, checksum = ?").run(payload, checksum(payload));
      },
      (database) => database.exec("UPDATE current_snapshot SET schema_version = 2"),
      (database) => database.exec(`UPDATE current_snapshot SET revision = ${Number.MAX_SAFE_INTEGER}`),
    ];
    for (const [index, mutate] of variants.entries()) {
      const filename = path.join(workspace(t).directory, `corrupt-${index}.sqlite`);
      const repository = createSqliteRepository({ filename });
      repository.save(snapshot());
      raw(filename, mutate);
      if (index === variants.length - 1) {
        expectCode("PERSISTENCE_CORRUPT", () => repository.save(snapshot("next")));
      } else {
        expectCode("PERSISTENCE_CORRUPT", () => repository.load());
      }
      repository.close();
    }
  });

  it("detects corrupt archive records", (t) => {
    const mutations = [
      (database) => database.exec("UPDATE archive_records SET checksum = 'wrong'"),
      (database) => {
        const payload = "{bad";
        database.prepare("UPDATE archive_records SET payload = ?, checksum = ?").run(payload, checksum(payload));
      },
      (database) => database.exec("UPDATE archive_records SET room_id = 'OTHER'"),
      (database) => {
        const payload = JSON.stringify({ ...archiveRecord(), data: { seatToken: "secret" } });
        database.prepare("UPDATE archive_records SET payload = ?, checksum = ?").run(payload, checksum(payload));
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const filename = path.join(workspace(t).directory, `archive-${index}.sqlite`);
      const repository = createSqliteRepository({ filename });
      repository.archive(archiveRecord());
      raw(filename, mutate);
      expectCode("PERSISTENCE_CORRUPT", () => repository.listArchives());
      repository.close();
    }
  });

  it("rejects an external lock file without deleting it", (t) => {
    const files = workspace(t);
    fs.writeFileSync(`${files.database}.lock`, "external-owner", { mode: 0o600 });
    expectCode("PERSISTENCE_LOCKED", () => createSqliteRepository({ filename: files.database }));
    assert.equal(fs.readFileSync(`${files.database}.lock`, "utf8"), "external-owner");
  });

  it("recovers a well-formed lock owned by a dead process", (t) => {
    const files = workspace(t);
    fs.writeFileSync(`${files.database}.lock`, "2147483647:00000000-0000-4000-8000-000000000000", { mode: 0o600 });
    const repository = createSqliteRepository({ filename: files.database });
    assert.notEqual(fs.readFileSync(`${files.database}.lock`, "utf8").split(":")[0], "2147483647");
    repository.close();
  });

  it("does not reclaim a lock owned by a live process", (t) => {
    const files = workspace(t);
    fs.writeFileSync(`${files.database}.lock`, `${process.pid}:00000000-0000-4000-8000-000000000000`, { mode: 0o600 });
    expectCode("PERSISTENCE_LOCKED", () => createSqliteRepository({ filename: files.database }));
  });

  it("closes safely when its lock was removed or replaced externally", (t) => {
    const removedFiles = workspace(t);
    const removed = createSqliteRepository({ filename: removedFiles.database });
    fs.unlinkSync(`${removedFiles.database}.lock`);
    removed.close();

    const replacedFiles = workspace(t);
    const replaced = createSqliteRepository({ filename: replacedFiles.database });
    fs.writeFileSync(`${replacedFiles.database}.lock`, "replacement-owner");
    replaced.close();
    assert.equal(fs.readFileSync(`${replacedFiles.database}.lock`, "utf8"), "replacement-owner");
  });
});
