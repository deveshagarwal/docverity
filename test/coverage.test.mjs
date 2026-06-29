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

function cliRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-cov2-"));
  mkdirSync(path.join(dir, "src"));
  // A genuine CLI entry file: .option() makes looksLikeCliFile() true.
  writeFileSync(
    path.join(dir, "src", "cli.ts"),
    [
      'program.option("--out <f>");',
      'program.command("deploy");',
      'program.command("rollback");',
      'program.command("help");', // auto command, ignored
      'opt.choices(["pretty", "lavish"]);',
    ].join("\n"),
  );
  // A non-CLI file that happens to call .command() (e.g. a redis client).
  mkdirSync(path.join(dir, "src", "db"));
  writeFileSync(
    path.join(dir, "src", "db", "client.ts"),
    'redis.command("GET", key); redis.command("SET", key, val);',
  );
  writeFileSync(
    path.join(dir, "README.md"),
    "# t\nRun `deploy` and pass `--out`. Format `pretty` is the default.\n",
  );
  return dir;
}

test("flags undocumented subcommands and choice values", () => {
  const texts = findUndocumented(cliRepo(), ["README.md"]).map((x) => x.claim.text);
  assert.ok(texts.includes("rollback"), "undocumented subcommand");
  assert.ok(texts.includes("lavish"), "undocumented choice value");
});

test("does not flag documented or auto subcommands/values", () => {
  const texts = findUndocumented(cliRepo(), ["README.md"]).map((x) => x.claim.text);
  assert.ok(!texts.includes("deploy"), "documented subcommand ignored");
  assert.ok(!texts.includes("pretty"), "documented value ignored");
  assert.ok(!texts.includes("help"), "auto-added help command ignored");
});

test("does not mine subcommands from non-CLI .command() calls", () => {
  const texts = findUndocumented(cliRepo(), ["README.md"]).map((x) => x.claim.text);
  assert.ok(!texts.includes("GET"), "redis .command() not a subcommand");
  assert.ok(!texts.includes("SET"), "redis .command() not a subcommand");
});

test("subcommand findings carry the right kind and phrasing", () => {
  const v = findUndocumented(cliRepo(), ["README.md"]).find((x) => x.claim.text === "rollback");
  assert.equal(v.claim.kind, "subcommand");
  assert.match(v.explanation, /defines the subcommand rollback/);
});
