import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { extractClaims } from "../dist/extract.js";

const sampleRoot = path.resolve("examples/sample-project");

test("extracts flags, env vars, paths, and symbols", () => {
  const claims = extractClaims(sampleRoot, "README.md");
  const byText = (t) => claims.find((c) => c.text === t);
  assert.ok(byText("--pretty"), "should find --pretty flag");
  assert.ok(byText("--json"), "should find --json flag");
  assert.ok(byText("LEGACY_KEY"), "should find LEGACY_KEY env var");
  assert.ok(byText("src/legacy.ts"), "should find src/legacy.ts path");
  assert.ok(byText("loadConfig"), "should find loadConfig symbol");
});

test("dedupes repeated tokens", () => {
  const claims = extractClaims(sampleRoot, "README.md");
  const jsonFlags = claims.filter((c) => c.kind === "flag" && c.text === "--json");
  assert.equal(jsonFlags.length, 1, "--json appears twice in docs but should be one claim");
});

test("does not treat common ALL_CAPS words as env vars", () => {
  const claims = extractClaims(sampleRoot, "README.md");
  assert.equal(
    claims.find((c) => c.text === "JSON"),
    undefined,
    "JSON is a stopword, not an env var",
  );
});
