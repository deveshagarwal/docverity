import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { extractClaims } from "../dist/extract.js";
import { verifyReference } from "../dist/verify-reference.js";

const sampleRoot = path.resolve("examples/sample-project");

test("drifts on missing references, confirms real ones", async () => {
  const claims = extractClaims(sampleRoot, "README.md");
  const verdicts = await verifyReference(sampleRoot, claims);
  const v = (t) => verdicts.find((x) => x.claim.text === t);

  // Planted drifts in the fixture.
  assert.equal(v("src/legacy.ts").status, "drifted", "missing file should drift");
  assert.equal(v("--pretty").status, "drifted", "missing flag should drift");
  assert.equal(v("LEGACY_KEY").status, "drifted", "missing env var should drift");

  // Valid claims must not be flagged.
  assert.equal(v("--json").status, "ok", "real flag should be ok");
  assert.equal(v("API_TOKEN").status, "ok", "real env var should be ok");
  assert.equal(v("src/index.ts").status, "ok", "real file should be ok");
});

test("every verdict carries the reference engine tag", async () => {
  const claims = extractClaims(sampleRoot, "README.md");
  const verdicts = await verifyReference(sampleRoot, claims);
  assert.ok(verdicts.length > 0);
  assert.ok(verdicts.every((v) => v.engine === "reference"));
});
