"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function productionFiles(trackedFiles) {
  return trackedFiles.filter((file) => /\.(?:c|m)?js$/.test(file) &&
    file !== "scripts/coverage-inventory.cjs" &&
    !/^(?:test|tests|node_modules|coverage|artifacts|\.github)\//.test(file));
}

function markupViolations(html, file, production) {
  const violations = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = match[1].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!src || match[2].trim()) {
      violations.push(`${file}: inline scripts are forbidden; use an inventoried external file`);
      continue;
    }
    const location = src[1] ?? src[2] ?? src[3];
    const relative = path.posix.normalize(location.startsWith("/") ? location.slice(1) : path.posix.join(path.posix.dirname(file), location));
    if (!production.includes(relative)) violations.push(`${file}: script ${location} is outside the production coverage inventory`);
  }
  for (const tag of source.matchAll(/<[^>]+>/g)) {
    if (/\son[a-z]+\s*=/i.test(tag[0]) || /\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript\s*:/i.test(tag[0])) {
      violations.push(`${file}: inline event handlers and javascript URLs are forbidden`);
    }
  }
  return violations;
}

function parseLcov(text, root) {
  const records = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const file = path.relative(root, path.resolve(root, line.slice(3))).split(path.sep).join("/");
      current = { file, LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };
    } else if (current && /^(LF|LH|FNF|FNH|BRF|BRH):/.test(line)) {
      const [key, value] = line.split(":");
      current[key] = Number(value);
    } else if (current && line === "end_of_record") {
      if (records.has(current.file)) throw new Error(`Duplicate coverage record: ${current.file}`);
      records.set(current.file, current);
      current = undefined;
    }
  }
  if (current) throw new Error("Incomplete LCOV record");
  return records;
}

function evaluateCoverage(files, records, policy, hashFile, baseline = policy) {
  if (policy.minimum !== 95 || Object.keys(policy.legacy).some((file) => !["app.js", "server.js"].includes(file))) {
    throw new Error("Coverage minimum is 95%; legacy exceptions cannot be extended");
  }
  for (const [file, hash] of Object.entries(policy.legacy)) {
    if (baseline.legacy[file] !== hash) throw new Error(`Legacy baseline cannot be added or rewritten: ${file}`);
  }
  const failures = [];
  const legacy = [];
  const covered = [];
  for (const file of files) {
    const record = records.get(file);
    if (!record) {
      if (policy.legacy[file] && hashFile(file) === policy.legacy[file]) legacy.push(file);
      else failures.push(`${file}: missing coverage (new or modified production code must be measured)`);
      continue;
    }
    covered.push(file);
    for (const [metric, found, hit] of [["lines", "LF", "LH"], ["functions", "FNF", "FNH"], ["branches", "BRF", "BRH"]]) {
      const total = record[found];
      const used = record[hit];
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(used) || total < 0 || used < 0 || used > total ||
          (metric === "lines" && total === 0)) {
        failures.push(`${file}: invalid ${metric} coverage counts`);
      } else if (total > 0 && used * 100 < total * policy.minimum) {
        failures.push(`${file}: ${metric} ${(used * 100 / total).toFixed(2)}% < ${policy.minimum}%`);
      }
    }
  }
  return { failures, legacy, covered };
}

function main(root = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const files = productionFiles(tracked);
  const records = parseLcov(fs.readFileSync(path.join(root, "coverage/lcov.info"), "utf8"), root);
  const policy = JSON.parse(fs.readFileSync(path.join(root, "ci/coverage-policy.json"), "utf8"));
  const base = process.env.COVERAGE_BASE && !/^0+$/.test(process.env.COVERAGE_BASE)
    ? process.env.COVERAGE_BASE : git(["merge-base", "HEAD", "origin/main"]).trim();
  const baseline = git(["ls-tree", "--name-only", base, "--", "ci/coverage-policy.json"]).trim()
    ? JSON.parse(git(["show", `${base}:ci/coverage-policy.json`]))
    : { legacy: Object.fromEntries(["app.js", "server.js"].map((file) => [file,
      createHash("sha256").update(execFileSync("git", ["show", `${base}:${file}`], { cwd: root })).digest("hex")])) };
  const result = evaluateCoverage(files, records, policy,
    (file) => createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"), baseline);
  for (const file of tracked.filter((entry) => entry.endsWith(".html") && !/^(?:test|tests|node_modules)\//.test(entry))) {
    result.failures.push(...markupViolations(fs.readFileSync(path.join(root, file), "utf8"), file, files));
  }
  const summary = [
    "# Coverage inventory",
    "",
    `Measured production files: ${result.covered.length}. Per-file minimum: 95% lines/functions/branches.`,
    "",
    ...result.covered.map((file) => `- Measured: ${file}`),
    ...result.legacy.map((file) => `- Uncovered legacy baseline (unchanged only): ${file}`),
    "",
    result.legacy.length ? "Whole-project 95% is NOT achieved while legacy baselines remain." : "No uncovered legacy baselines remain.",
    "",
    ...result.failures.map((message) => `- FAILURE: ${message}`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, "coverage/summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  if (result.failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { productionFiles, markupViolations, parseLcov, evaluateCoverage };
