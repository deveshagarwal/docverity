import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Evidence } from "./types.js";

const execFileAsync = promisify(execFile);

// Directories never worth searching for evidence of documented behavior.
// NOTE: "vendor" is intentionally NOT ignored. Third-party deps live in
// node_modules (ignored); a committed `vendor/` (or `source/vendor/`, as in
// chalk) is code the project ships and is responsible for, so behavior it
// implements there — e.g. chalk's FORCE_COLOR / --color handling in
// source/vendor/supports-color — is real evidence, not noise.
const IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".venv",
];

// Documentation file types are excluded from evidence: a claim in the docs
// must be backed by the *code*, not by the docs restating it (otherwise a
// README that mentions a removed flag would cite itself as proof).
const DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc"];

function isDocFile(file: string): boolean {
  const lower = file.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// How a token is matched against the source:
//  - "literal": plain substring (used to gather evidence for the LLM engine)
//  - "word":    whole-token match for env vars and symbols (API_KEY != API_KEY_V2)
//  - "flag":    flag-token match where '-' is part of the token (--json != --json-output)
export type MatchMode = "literal" | "word" | "flag";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flagPattern(token: string): string {
  return `(^|[^A-Za-z0-9-])${escapeRegex(token)}([^A-Za-z0-9-]|$)`;
}

let rgChecked = false;
let rgAvailable = false;

async function hasRipgrep(): Promise<boolean> {
  if (rgChecked) return rgAvailable;
  rgChecked = true;
  try {
    await execFileAsync("rg", ["--version"]);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Plain substring search. Used to gather evidence for the LLM engine. */
export function searchLiteral(root: string, needle: string, limit = 8): Promise<Evidence[]> {
  return runSearch(root, needle, "literal", limit);
}

/** Boundary-aware search used by the deterministic verifier. */
export function searchToken(
  root: string,
  token: string,
  mode: MatchMode,
  limit = 8,
): Promise<Evidence[]> {
  return runSearch(root, token, mode, limit);
}

async function runSearch(
  root: string,
  needle: string,
  mode: MatchMode,
  limit: number,
): Promise<Evidence[]> {
  if (!needle.trim()) return [];
  if (await hasRipgrep()) return rgSearch(root, needle, mode, limit);
  return fallbackSearch(root, needle, mode, limit);
}

async function rgSearch(
  root: string,
  needle: string,
  mode: MatchMode,
  limit: number,
): Promise<Evidence[]> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(limit),
  ];
  for (const dir of IGNORE_DIRS) args.push("--glob", `!${dir}/`);
  for (const ext of DOC_EXTENSIONS) args.push("--glob", `!*${ext}`);

  if (mode === "flag") {
    args.push("--regexp", flagPattern(needle));
  } else if (mode === "word") {
    args.push("--fixed-strings", "--word-regexp", "--regexp", needle);
  } else {
    args.push("--fixed-strings", "--regexp", needle);
  }
  args.push("--", ".");

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseRgOutput(stdout, limit);
  } catch (err: any) {
    // rg exits 1 when there are no matches; that is not an error for us.
    if (err?.code === 1) return [];
    throw err;
  }
}

function parseRgOutput(stdout: string, limit: number): Evidence[] {
  const out: Evidence[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // format: path:line:content
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const file = raw.slice(0, first).replace(/^\.\//, "");
    const line = Number(raw.slice(first + 1, second));
    const snippet = raw.slice(second + 1).trim();
    out.push({ file, line, snippet: snippet.slice(0, 200) });
    if (out.length >= limit) break;
  }
  return out;
}

function matcherFor(needle: string, mode: MatchMode): (line: string) => boolean {
  if (mode === "literal") return (line) => line.includes(needle);
  const re =
    mode === "flag"
      ? new RegExp(flagPattern(needle))
      : new RegExp(`\\b${escapeRegex(needle)}\\b`);
  return (line) => re.test(line);
}

function fallbackSearch(
  root: string,
  needle: string,
  mode: MatchMode,
  limit: number,
): Evidence[] {
  const matches = matcherFor(needle, mode);
  const out: Evidence[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (IGNORE_DIRS.includes(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && st.size < 2 * 1024 * 1024 && !isDocFile(full)) {
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches(lines[i])) {
            out.push({
              file: path.relative(root, full),
              line: i + 1,
              snippet: lines[i].trim().slice(0, 200),
            });
            if (out.length >= limit) return;
          }
        }
      }
    }
  };
  walk(root);
  return out;
}

export interface SourceFile {
  file: string;
  content: string;
}

/** Read every non-doc source file under the repo (for code -> docs coverage). */
export function readSourceFiles(root: string, limitBytes = 2 * 1024 * 1024): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.includes(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && st.size < limitBytes && !isDocFile(full)) {
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue; // skip binary files
        out.push({ file: path.relative(root, full), content });
      }
    }
  };
  walk(root);
  return out;
}

/** Resolve a documented path claim against the filesystem, contained to the repo. */
export function fileExists(root: string, relPath: string): boolean {
  const clean = relPath.replace(/^\.\//, "").replace(/[`*]/g, "");
  const base = path.resolve(root);
  const target = path.resolve(base, clean);
  // Don't let "../../etc/passwd" style references probe outside the repo.
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  return existsSync(target);
}
