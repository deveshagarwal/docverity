import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUndocumented } from "../dist/coverage.js";

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-cov-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "app.ts"),
    [
      'const a = process.env.SECRET_TOKEN;',
      'const b = process.env.DOCUMENTED_VAR;',
      'const c = process.env.NODE_ENV;',
      'program.option("--frobnicate <x>", "do the thing");',
      'program.option("--known");',
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "README.md"),
    "# t\n\nSet `DOCUMENTED_VAR` and pass `--known` to run.\n",
  );
  return dir;
}

test("flags undocumented env vars and flags", () => {
  const v = findUndocumented(repo(), ["README.md"]);
  const texts = v.map((x) => x.claim.text);
  assert.ok(texts.includes("SECRET_TOKEN"), "undocumented env var");
  assert.ok(texts.includes("--frobnicate"), "undocumented flag");
});

test("does not flag documented or platform-standard items", () => {
  const texts = findUndocumented(repo(), ["README.md"]).map((x) => x.claim.text);
  assert.ok(!texts.includes("DOCUMENTED_VAR"), "documented env var ignored");
  assert.ok(!texts.includes("--known"), "documented flag ignored");
  assert.ok(!texts.includes("NODE_ENV"), "platform env var ignored");
});

test("coverage findings are undocumented warnings", () => {
  for (const v of findUndocumented(repo(), ["README.md"])) {
    assert.equal(v.status, "undocumented");
    assert.equal(v.severity, "warning");
    assert.equal(v.engine, "coverage");
  }
});
