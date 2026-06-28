import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractClaims } from "../dist/extract.js";
import { verifyReference } from "../dist/verify-reference.js";
import { searchToken } from "../dist/search.js";
import { summarize, printGithubAnnotations } from "../dist/report.js";

function tmpRepo() {
  return mkdtempSync(path.join(os.tmpdir(), "docverity-test-"));
}

// --- Extraction false positives (ranks 2 & 3) ---

test("ALL_CAPS prose words are not extracted as env vars", () => {
  const dir = tmpRepo();
  writeFileSync(
    path.join(dir, "README.md"),
    "# T\nGET_STARTED and READ_MORE and CI_CD are prose.\nBut `REAL_ENV` is backticked.\n",
  );
  const claims = extractClaims(dir, "README.md");
  const envTexts = claims.filter((c) => c.kind === "env").map((c) => c.text);
  assert.ok(!envTexts.includes("GET_STARTED"));
  assert.ok(!envTexts.includes("READ_MORE"));
  assert.ok(!envTexts.includes("CI_CD"));
  assert.ok(envTexts.includes("REAL_ENV"), "backticked env var should still be claimed");
});

test("multi-dot filenames stay whole and absolute paths are skipped", () => {
  const dir = tmpRepo();
  writeFileSync(
    path.join(dir, "README.md"),
    "See `app.config.ts` and `tsconfig.build.json`.\nLogs at `/var/log/app.log` or `~/.config/app.toml`.\n",
  );
  const fileTexts = extractClaims(dir, "README.md")
    .filter((c) => c.kind === "file")
    .map((c) => c.text);
  assert.ok(fileTexts.includes("app.config.ts"), "whole multi-dot filename");
  assert.ok(fileTexts.includes("tsconfig.build.json"));
  assert.ok(!fileTexts.includes("app.conf"), "no fragment");
  assert.ok(!fileTexts.includes("ig.ts"), "no fragment");
  assert.ok(!fileTexts.some((t) => t.includes("/var/log")), "absolute path skipped");
  assert.ok(!fileTexts.some((t) => t.includes("app.toml")), "home path skipped");
});

// --- Verdict precision (ranks 3 & 4) ---

test("bare framework-name filename is unverifiable, not drifted", async () => {
  const dir = tmpRepo();
  const claim = {
    id: "x#1",
    docFile: "README.md",
    line: 1,
    kind: "file",
    text: "Node.js",
    assertion: "Node.js exists",
    searchHints: ["Node.js"],
  };
  const [v] = await verifyReference(dir, [claim]);
  assert.equal(v.status, "unverifiable");
});

test("a removed symbol drifts at a confidence that fails CI", async () => {
  const dir = tmpRepo();
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export function keep() {}\n");
  const claim = {
    id: "x#1",
    docFile: "README.md",
    line: 1,
    kind: "symbol",
    text: "loadConfig",
    assertion: "loadConfig exists",
    searchHints: ["loadConfig"],
  };
  const [v] = await verifyReference(dir, [claim]);
  assert.equal(v.status, "drifted");
  assert.ok(v.confidence >= 0.7, `expected >=0.7, got ${v.confidence}`);
});

// --- Boundary-aware search (rank 4) ---

test("boundary search does not let suffixed tokens satisfy a claim", async () => {
  const dir = tmpRepo();
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "a.ts"),
    'const x = "--json-output";\nconst API_KEY_V2 = 1;\nfunction parseConfigDeep() {}\n',
  );
  assert.equal((await searchToken(dir, "--json", "flag")).length, 0);
  assert.equal((await searchToken(dir, "API_KEY", "word")).length, 0);
  assert.equal((await searchToken(dir, "parseConfig", "word")).length, 0);

  writeFileSync(
    path.join(dir, "src", "b.ts"),
    'run("--json");\nprocess.env.API_KEY;\nparseConfig();\n',
  );
  assert.ok((await searchToken(dir, "--json", "flag")).length >= 1);
  assert.ok((await searchToken(dir, "API_KEY", "word")).length >= 1);
  assert.ok((await searchToken(dir, "parseConfig", "word")).length >= 1);
});

// --- Report safety (ranks 1 & 6) ---

test("a non-numeric fail-confidence does not silently pass drift", () => {
  const verdict = {
    claim: { docFile: "README.md", line: 1, text: "x" },
    status: "drifted",
    confidence: 0.9,
    explanation: "",
    evidence: [],
    engine: "reference",
  };
  const s = summarize([verdict], { failConfidence: NaN, strict: false });
  assert.equal(s.failures.length, 1, "NaN threshold must fall back, not pass everything");
});

test("github annotations escape workflow-command metacharacters", () => {
  const verdict = {
    claim: { docFile: "a:b,c.md", line: 7, text: "x%y" },
    status: "drifted",
    confidence: 0.9,
    explanation: "default is z",
    evidence: [],
    engine: "reference",
  };
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    printGithubAnnotations([verdict], { failConfidence: 0.7 });
  } finally {
    console.log = orig;
  }
  const out = lines.join("\n");
  assert.match(out, /file=a%3Ab%2Cc\.md/, "colon and comma escaped in file property");
  assert.match(out, /x%25y/, "percent escaped in message");
  assert.match(out, /line=7/);
});
