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
  "NODE_ENV", "CI", "HOME", "PATH", "PWD", "OLDPWD", "USER", "LOGNAME", "SHELL",
  "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "HOSTNAME", "EDITOR", "VISUAL", "PAGER", "DISPLAY", "SSH_AUTH_SOCK", "MANPATH",
  "NODE_OPTIONS", "COLUMNS", "LINES", "FORCE_COLOR", "NO_COLOR", "CLICOLOR",
  "CLICOLOR_FORCE", "DEBUG", "PORT",
  // Windows / XDG platform variables.
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME",
  "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PROGRAMFILES", "PROGRAMDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS",
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

// Type-test / declaration-test / spec filenames hold illustrative option and
// env usage (e.g. commander's typings/index.test-d.ts), not the real surface.
function isTestLikeFile(file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? file;
  return /\.(test|test-d|spec)\.[cm]?[jt]sx?$/.test(base);
}

function inSkippedDir(file: string): boolean {
  const segs = file.split(/[\\/]/);
  if (segs.some((seg) => COVERAGE_SKIP_DIRS.has(seg))) return true;
  // Hand-written type declarations (typings/, *.d.ts) describe the API for
  // consumers; their example `.option()` calls are not the app's own flags.
  if (segs.includes("typings") || /\.d\.ts$/.test(file)) return true;
  return isTestLikeFile(file);
}

/**
 * Blank out block comments (slash-star … star-slash) and full-line // comments
 * while preserving newline count, so JSDoc `@example` snippets like
 * `* .option('--pt, --pizza-type <TYPE>')` are not mistaken for real flag
 * declarations. Line numbers of surviving code are unaffected.
 */
function stripComments(content: string): string {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/^[ \t]*\/\/.*$/gm, "");
  return out;
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

  for (const { file, content: rawContent } of readSourceFiles(root)) {
    if (inSkippedDir(file)) continue;
    // Mine declarations from real code only, not from commented-out examples.
    const content = stripComments(rawContent);
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
