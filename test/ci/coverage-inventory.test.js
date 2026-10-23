"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { it } = require("node:test");
const { productionFiles, markupViolations, parseLcov, evaluateCoverage } = require("../../scripts/coverage-inventory.cjs");

const root = path.resolve(__dirname, "../..");
const policy = { minimum: 95, legacy: { "app.js": "original" } };
const full = { LF: 100, LH: 100, FNF: 20, FNH: 20, BRF: 20, BRH: 20 };

it("inventories all tracked runtime scripts, including root and future public files", () => {
  assert.deepEqual(productionFiles(["app.js", "server.js", "src/new.cjs", "public/client.mjs", "test/a.test.js", "scripts/runtime.cjs", "scripts/coverage-inventory.cjs", ".github/tool.js", "coverage/x.js", "README.md"]),
    ["app.js", "server.js", "src/new.cjs", "public/client.mjs", "scripts/runtime.cjs"]);
});

it("reads relative and absolute LCOV records", () => {
  const report = `SF:src/a.js\nLF:20\nLH:19\nFNF:1\nFNH:1\nBRF:0\nBRH:0\nend_of_record\nSF:${path.join(root, "src/b.js")}\nLF:2\nLH:2\nend_of_record\n`;
  const records = parseLcov(report, root);
  assert.equal(records.get("src/a.js").LH, 19);
  assert.equal(records.get("src/b.js").LF, 2);
  assert.throws(() => parseLcov("SF:src/a.js\n", root), /Incomplete/);
  assert.throws(() => parseLcov("SF:src/a.js\nend_of_record\nSF:src/a.js\nend_of_record", root), /Duplicate/);
});

it("fails when an unloaded new module is absent from the native coverage report", () => {
  const result = evaluateCoverage(["src/new.js"], new Map(), policy, () => "original");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /missing coverage/);
});

it("keeps the old demo visible as debt and blocks changes without coverage", () => {
  assert.deepEqual(evaluateCoverage(["app.js"], new Map(), policy, () => "original"), {
    failures: [], legacy: ["app.js"], covered: [],
  });
  assert.equal(evaluateCoverage(["app.js"], new Map(), policy, () => "changed").failures.length, 1);
  assert.deepEqual(evaluateCoverage(["app.js"], new Map([["app.js", full]]), policy, () => "changed"), {
    failures: [], legacy: [], covered: ["app.js"],
  });
});

it("requires 95 percent in every metric for every measured file", () => {
  for (const metric of ["LH", "FNH", "BRH"]) {
    const result = evaluateCoverage(["src/a.js"], new Map([["src/a.js", { ...full, [metric]: 0 }]]), policy, () => "unused");
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /< 95%/);
  }
  assert.equal(evaluateCoverage(["src/a.js"], new Map([["src/a.js", { ...full, LH: 95 }]]), policy, () => "unused").failures.length, 0);
});

it("rejects corrupt metric counts and lowered or extended coverage policy", () => {
  for (const broken of [{ LF: 0, LH: 0 }, { LH: 101 }, { LH: -1 }, { BRH: NaN }, { FNF: 0.5 }]) {
    assert.match(evaluateCoverage(["src/a.js"], new Map([["src/a.js", { ...full, ...broken }]]), policy, () => "unused").failures[0], /invalid/);
  }
  assert.throws(() => evaluateCoverage([], new Map(), { ...policy, minimum: 90 }, () => "unused"), /minimum/);
  assert.throws(() => evaluateCoverage([], new Map(), { minimum: 95, legacy: { "src/new.js": "hash" } }, () => "unused"), /exceptions/);
});

it("compares legacy hashes with the PR baseline instead of trusting an edited policy", () => {
  const rewritten = { minimum: 95, legacy: { "app.js": "changed" } };
  assert.throws(() => evaluateCoverage(["app.js"], new Map(), rewritten, () => "changed", policy), /rewritten/);
  assert.throws(() => evaluateCoverage([], new Map(), policy, () => "original", { legacy: {} }), /added/);
  const removed = { minimum: 95, legacy: {} };
  assert.equal(evaluateCoverage(["app.js"], new Map(), removed, () => "original", policy).failures.length, 1);
  assert.deepEqual(evaluateCoverage(["app.js"], new Map([["app.js", full]]), removed, () => "changed", policy), {
    failures: [], legacy: [], covered: ["app.js"],
  });
});

it("requires HTML to reference inventoried external scripts", () => {
  assert.deepEqual(markupViolations('<script src="./app.js" defer></script>', "index.html", ["app.js"]), []);
  assert.deepEqual(markupViolations("<script src='/app.js'></script>", "pages/index.html", ["app.js"]), []);
  assert.deepEqual(markupViolations("<script src=../app.js></script>", "pages/index.html", ["app.js"]), []);
  for (const html of ['<script>alert(1)</script>', '<script src="app.js">alert(1)</script>', '<script src="test/hidden.js"></script>']) {
    assert.equal(markupViolations(html, "index.html", ["app.js"]).length, 1);
  }
  assert.deepEqual(markupViolations('<!-- <script>example</script> -->', "index.html", []), []);
});

it("blocks inline handlers and javascript links in HTML", () => {
  for (const html of ['<button onclick="go()">', "<body ONLOAD='go()'>", '<a href="javascript:go()">']) {
    assert.equal(markupViolations(html, "index.html", []).length, 1);
  }
  assert.deepEqual(markupViolations('<button data-action="vote">投票</button>', "index.html", []), []);
});
