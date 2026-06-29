import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUndocumentedCapabilities } from "../dist/coverage-llm.js";

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-capcov-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "cli.ts"),
    [
      'program.command("check");',
      'program.command("serve").option("--port <n>");', // an undocumented mode
      'program.parse();',
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "README.md"), "# tool\nRun `tool check` to check.\n");
  return dir;
}

// A stub sampler stands in for the caller's model: it receives (system, user)
// and returns whatever JSON the test wants, so the pass is exercised offline.
const sampler = (reply) => async () => reply;

test("maps model-reported capabilities to undocumented warnings", async () => {
  const reply = JSON.stringify({
    undocumented: [
      { capability: "serve mode", evidence: "src/cli.ts:2", reason: "Starts a server; docs omit it." },
    ],
  });
  const v = await findUndocumentedCapabilities(repo(), sampler(reply));
  assert.equal(v.length, 1);
  assert.equal(v[0].claim.text, "serve mode");
  assert.equal(v[0].claim.kind, "capability");
  assert.equal(v[0].status, "undocumented");
  assert.equal(v[0].severity, "warning");
  assert.equal(v[0].engine, "coverage-llm");
  assert.equal(v[0].claim.docFile, "src/cli.ts");
  assert.equal(v[0].claim.line, 2);
});

test("returns nothing when the model reports a clean repo", async () => {
  const v = await findUndocumentedCapabilities(repo(), sampler('{"undocumented":[]}'));
  assert.equal(v.length, 0);
});

test("survives unparseable model output", async () => {
  const v = await findUndocumentedCapabilities(repo(), sampler("not json at all"));
  assert.deepEqual(v, []);
});

test("survives a sampler that throws", async () => {
  const throwing = async () => {
    throw new Error("sampling unavailable");
  };
  const v = await findUndocumentedCapabilities(repo(), throwing);
  assert.deepEqual(v, []);
});

test("dedupes and caps repeated capabilities", async () => {
  const undocumented = Array.from({ length: 20 }, () => ({
    capability: "serve mode",
    evidence: "src/cli.ts:2",
    reason: "dup",
  }));
  const v = await findUndocumentedCapabilities(repo(), sampler(JSON.stringify({ undocumented })));
  assert.equal(v.length, 1, "identical capabilities collapse to one");
});
