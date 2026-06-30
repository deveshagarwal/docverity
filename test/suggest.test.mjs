import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runSuggest,
  renderSuggestionsBlock,
  writeSuggestions,
} from "../dist/suggest.js";

function repo(readme = "# tool\n") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-sug-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "cli.ts"),
    'program.command("serve").option("--port <n>");\nconst k = process.env.API_TOKEN;\n',
  );
  writeFileSync(path.join(dir, "README.md"), readme);
  return dir;
}

const sampler = (reply) => async () => reply;

const REPLY = JSON.stringify({
  suggestions: [
    {
      title: "Document serve",
      action: "add",
      target: "README.md",
      markdown: "## serve\n\nServe the thing.",
      why: "It was undocumented.",
    },
  ],
});

test("parses model suggestions into structured items", async () => {
  const s = await runSuggest(repo(), ["README.md"], sampler(REPLY));
  assert.equal(s.length, 1);
  assert.equal(s[0].title, "Document serve");
  assert.equal(s[0].action, "add");
  assert.match(s[0].markdown, /## serve/);
});

test("drops suggestions with no markdown", async () => {
  const reply = JSON.stringify({ suggestions: [{ title: "x", action: "add", markdown: "" }] });
  assert.deepEqual(await runSuggest(repo(), ["README.md"], sampler(reply)), []);
});

test("survives unparseable model output", async () => {
  assert.deepEqual(await runSuggest(repo(), ["README.md"], sampler("nope")), []);
});

test("renders a readable block without em dashes", () => {
  const block = renderSuggestionsBlock([
    { title: "T", action: "add", target: "README.md", markdown: "body", why: "because" },
  ]);
  assert.match(block, /### T \[add\]/);
  assert.match(block, /body/);
  assert.ok(!block.includes("—"), "no em dash in docverity's own formatting");
});

test("--write inserts an additive, replaceable block", () => {
  const dir = repo("# tool\n\nExisting prose.\n");
  const sug = [{ title: "T", action: "add", target: "README.md", markdown: "## new\nbody", why: "w" }];

  writeSuggestions(dir, "README.md", sug);
  let txt = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(txt, /Existing prose\./, "original content preserved");
  assert.match(txt, /docverity:suggestions:start/);
  assert.match(txt, /## new/);

  // Re-running replaces the block instead of stacking a second one.
  writeSuggestions(dir, "README.md", sug);
  txt = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.equal(txt.match(/docverity:suggestions:start/g).length, 1, "single block");
});
