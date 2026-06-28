import path from "node:path";
import { readFileSync } from "node:fs";
import type { Verdict, ClaimKind } from "./types.js";
import { readSourceFiles } from "./search.js";

// Code that reads an environment variable, across common languages.
const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g, // JS/TS: process.env.NAME
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /os\.environ(?:\.get)?\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g, // Python
  /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /\bgetenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g, // Go/PHP/C
  /System\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g, // Java
  /ENV\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, // Ruby
];

// CLI flag declarations, restricted to high-signal arg-parser idioms so we
// don't flag every "--" string in the codebase.
const FLAG_PATTERNS: RegExp[] = [
  /\.option\(\s*["'`]([^"'`]*--[a-zA-Z][\w-]+[^"'`]*)["'`]/g, // commander
  /argv\.includes\(\s*["'`](--[a-zA-Z][\w-]+)["'`]/g,
  /add_argument\(\s*["'](--[a-zA-Z][\w-]+)["']/g, // argparse
];

// Platform/standard env vars that aren't app configuration worth documenting.
const ENV_IGNORE = new Set([
  "NODE_ENV", "CI", "HOME", "PATH", "PWD", "USER", "SHELL", "TERM", "LANG",
  "LC_ALL", "TMPDIR", "TEMP", "TMP", "NODE_OPTIONS", "COLUMNS", "LINES",
  "FORCE_COLOR", "NO_COLOR", "DEBUG", "PORT",
  // Generic placeholders that show up in code comments and examples.
  "NAME", "KEY", "VALUE", "VAR", "VARIABLE", "FOO", "BAR", "BAZ",
]);

// Flags arg parsers add automatically.
const FLAG_IGNORE = new Set(["--help", "--version"]);

// Directories that hold example/test/fixture code, not the app's real public
// surface. Their flags and env vars are illustrative, not things to document.
const COVERAGE_SKIP_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "e2e",
  "example", "examples", "fixture", "fixtures", "mocks", "__mocks__",
  "script", "scripts", "demo", "demos", "bench", "benchmarks",
]);

function inSkippedDir(file: string): boolean {
  return file.split(/[\\/]/).some((seg) => COVERAGE_SKIP_DIRS.has(seg));
}

interface Found {
  kind: ClaimKind;
  text: string;
  file: string;
  line: number;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Coverage engine (code -> docs): report flags and env vars the code uses that
 * the documentation never mentions. These are gaps, not lies, so they surface
 * as warnings and do not fail the build by default.
 */
export function findUndocumented(root: string, docFiles: string[]): Verdict[] {
  // What the docs mention, as one blob for membership checks.
  let docText = "";
  for (const doc of docFiles) {
    try {
      docText += "\n" + readFileSync(path.join(root, doc), "utf8");
    } catch {
      /* ignore unreadable docs */
    }
  }

  const found = new Map<string, Found>(); // key `${kind}:${text}` -> first hit
  const record = (kind: ClaimKind, text: string, file: string, line: number) => {
    const key = `${kind}:${text}`;
    if (!found.has(key)) found.set(key, { kind, text, file, line });
  };

  for (const { file, content } of readSourceFiles(root)) {
    if (inSkippedDir(file)) continue;
    for (const re of ENV_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const name = m[1];
        if (ENV_IGNORE.has(name) || name.startsWith("npm_")) continue;
        record("env", name, file, lineOf(content, m.index));
      }
    }
    for (const re of FLAG_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        // The capture may be a full option string ("-s, --long <x>"); pull flags.
        const flags = m[1].match(/--[a-zA-Z][\w-]+/g) ?? [];
        for (const flag of flags) {
          if (FLAG_IGNORE.has(flag)) continue;
          record("flag", flag, file, lineOf(content, m.index));
        }
      }
    }
  }

  const verdicts: Verdict[] = [];
  for (const f of found.values()) {
    if (docText.includes(f.text)) continue; // documented somewhere
    const noun = f.kind === "env" ? "environment variable" : "CLI flag";
    verdicts.push({
      claim: {
        id: `coverage:${f.kind}:${f.text}`,
        docFile: f.file,
        line: f.line,
        kind: f.kind,
        text: f.text,
        assertion: `${f.text} is documented`,
        searchHints: [f.text],
      },
      status: "undocumented",
      severity: "warning",
      confidence: 0.75,
      explanation: `The code uses the ${noun} ${f.text} (${f.file}:${f.line}), but no documentation mentions it.`,
      suggestedFix: `Document ${f.text}, or remove it if it is no longer used.`,
      evidence: [{ file: f.file, line: f.line, snippet: "" }],
      engine: "coverage",
    });
  }
  return verdicts;
}
