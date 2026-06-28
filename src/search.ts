import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Evidence } from "./types.js";

const execFileAsync = promisify(execFile);

// Directories never worth searching for evidence of documented behavior.
const IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".venv",
  "vendor",
];

// Documentation file types are excluded from evidence: a claim in the docs
// must be backed by the *code*, not by the docs restating it (otherwise a
// README that mentions a removed flag would cite itself as proof).
const DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc"];

function isDocFile(file: string): boolean {
  const lower = file.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
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

/**
 * Search the repo for a literal string. Returns up to `limit` evidence hits.
 * Uses ripgrep when available, falling back to a Node-based walk otherwise.
 */
export async function searchLiteral(
  root: string,
  needle: string,
  limit = 8,
): Promise<Evidence[]> {
  if (!needle.trim()) return [];

  if (await hasRipgrep()) {
    const args = [
      "--fixed-strings",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(limit),
    ];
    for (const dir of IGNORE_DIRS) args.push("--glob", `!${dir}/`);
    for (const ext of DOC_EXTENSIONS) args.push("--glob", `!*${ext}`);
    args.push("--", needle, ".");
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

  return fallbackSearch(root, needle, limit);
}

function parseRgOutput(stdout: string, limit: number): Evidence[] {
  const out: Evidence[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // format: path:line:content
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const file = raw.slice(0, first);
    const line = Number(raw.slice(first + 1, second));
    const snippet = raw.slice(second + 1).trim();
    out.push({ file, line, snippet: snippet.slice(0, 200) });
    if (out.length >= limit) break;
  }
  return out;
}

import { readdirSync, readFileSync, statSync } from "node:fs";

function fallbackSearch(root: string, needle: string, limit: number): Evidence[] {
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
          if (lines[i].includes(needle)) {
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

/** Resolve a documented path claim against the filesystem. */
export function fileExists(root: string, relPath: string): boolean {
  const clean = relPath.replace(/^\.\//, "").replace(/[`*]/g, "");
  return existsSync(path.join(root, clean));
}
