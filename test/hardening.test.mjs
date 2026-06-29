import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractClaims } from "../dist/extract.js";
import { verifyReference } from "../dist/verify-reference.js";

// Build a throwaway repo from a {path: contents} map and return its root.
function repo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-hard-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}
const flags = (dir) => extractClaims(dir, "README.md").filter((c) => c.kind === "flag").map((c) => c.text);
const envs = (dir) => extractClaims(dir, "README.md").filter((c) => c.kind === "env").map((c) => c.text);
const filesOf = (dir) => extractClaims(dir, "README.md").filter((c) => c.kind === "file").map((c) => c.text);
const syms = (dir) => extractClaims(dir, "README.md").filter((c) => c.kind === "symbol").map((c) => c.text);

test("a pure library does not get prose --flags mined (they are never its own)", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mylib" }), // no bin, no self-invocation
    "README.md": "# mylib\n\nPass `--verbose` for more output.\n",
  });
  assert.ok(!flags(dir).includes("--verbose"));
});

test("a project with a bin does get prose --flags mined", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\nPass `--verbose` for more output.\n",
  });
  assert.ok(flags(dir).includes("--verbose"));
});

test("third-party commands in fences are not mined; the project's own command is", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\n```bash\ngit clone https://x --depth 1\nmytool build --watch\n```\n",
  });
  const f = flags(dir);
  assert.ok(!f.includes("--depth"), "git's --depth must not be claimed");
  assert.ok(f.includes("--watch"), "the project's own --watch should be claimed");
});

test("symbols/paths inside markdown link labels are not claimed", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "lib" }),
    "README.md": "# lib\n\nSee [`fancyHelper()`](#anchor) and [`pkg/esm.mjs`](#x) for details.\n",
  });
  assert.ok(!syms(dir).includes("fancyHelper"));
  assert.ok(!filesOf(dir).includes("pkg/esm.mjs"));
});

test("runtime globals are not treated as project symbols", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "lib" }),
    "README.md": "# lib\n\nWe call `structuredClone()` and `fetch()` internally.\n",
  });
  const s = syms(dir);
  assert.ok(!s.includes("structuredClone"));
  assert.ok(!s.includes("fetch"));
});

test("placeholder env names and example assignments are not env claims; real ones are", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "lib" }),
    "README.md": "# lib\n\nSet `API_KEY` and `DATABASE_URL`. Example: `SINGLE_QUOTE='x'`. We read `APP_DATABASE`.\n",
  });
  const e = envs(dir);
  assert.ok(!e.includes("API_KEY"), "placeholder ignored");
  assert.ok(!e.includes("DATABASE_URL"), "placeholder ignored");
  assert.ok(!e.includes("SINGLE_QUOTE"), "example assignment ignored");
  assert.ok(e.includes("APP_DATABASE"), "a real env var is still claimed");
});

test("standard OS / XDG env vars are not claimed", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "app" }),
    "README.md": "# app\n\nRespects `XDG_DATA_HOME`, `LOCALAPPDATA`, and `HOME`. Reads `MY_APP_TOKEN`.\n",
  });
  const e = envs(dir);
  assert.ok(!e.includes("XDG_DATA_HOME"));
  assert.ok(!e.includes("LOCALAPPDATA"));
  assert.ok(!e.includes("HOME"));
  assert.ok(e.includes("MY_APP_TOKEN"), "a real env var is still claimed");
});

test("env in prose is a warning; VAR=value in a command is an error", async () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\nSet `MY_APP_TOKEN` in your environment.\n\n```bash\nMY_APP_DEBUG=1 mytool run\n```\n",
  });
  const claims = extractClaims(dir, "README.md");
  assert.equal(claims.find((c) => c.text === "MY_APP_TOKEN").weak, true);
  assert.equal(claims.find((c) => c.text === "MY_APP_DEBUG").weak, false);
  const verdicts = await verifyReference(dir, claims);
  const sev = (t) => verdicts.find((v) => v.claim.text === t).severity;
  assert.equal(sev("MY_APP_TOKEN"), "warning", "prose env drift is a warning");
  assert.equal(sev("MY_APP_DEBUG"), "error", "VAR=value env drift is an error");
});

test("flags after a pipe belong to the downstream program", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\n```bash\nmytool build --watch | grep --color\n```\n",
  });
  const f = flags(dir);
  assert.ok(f.includes("--watch"), "the project's own flag is claimed");
  assert.ok(!f.includes("--color"), "the piped tool's flag is not");
});

test("another tool's flag in prose is not claimed", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "mytool", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\nStage with `git add --patch`, then run `mytool --check`.\n",
  });
  const f = flags(dir);
  assert.ok(f.includes("--check"), "the project's own flag is claimed");
  assert.ok(!f.includes("--patch"), "git's flag is not");
});

test("example-framed paths are skipped; ordinary path references are kept", () => {
  const dir = repo({
    "package.json": JSON.stringify({ name: "lib" }),
    "README.md": "# lib\n\nFor a structure like `apps/backend/app.js`, configure it.\n\nThe entry point is `src/index.ts`.\n",
  });
  const f = filesOf(dir);
  assert.ok(!f.includes("apps/backend/app.js"), "hypothetical example path skipped");
  assert.ok(f.includes("src/index.ts"), "real path reference kept");
});
