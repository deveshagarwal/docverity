import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { searchLiteral, fileExists } from "../dist/search.js";

const sampleRoot = path.resolve("examples/sample-project");

// Regression: docs must never be evidence for docs. A token that appears only
// in the README should not count as proof that the code still supports it.
test("excludes doc files from evidence (no self-citation)", async () => {
  const hits = await searchLiteral(sampleRoot, "--pretty");
  assert.equal(hits.length, 0, "--pretty lives only in README and must not be found");
});

test("finds real code references and never returns doc files", async () => {
  const hits = await searchLiteral(sampleRoot, "--json");
  assert.ok(hits.length > 0, "--json is in the source and should be found");
  assert.ok(
    hits.every((h) => !h.file.endsWith(".md")),
    "evidence must come from code, not markdown",
  );
});

test("fileExists resolves paths against the repo root", () => {
  assert.equal(fileExists(sampleRoot, "src/index.ts"), true);
  assert.equal(fileExists(sampleRoot, "src/legacy.ts"), false);
});
