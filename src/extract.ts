import { readFileSync } from "node:fs";
import path from "node:path";
import type { Claim, ClaimKind } from "./types.js";

// Patterns for the kinds of token a doc can reference that we can check
// deterministically against the source tree.
const FLAG_RE = /(^|[\s(`"'])(--[a-zA-Z][a-zA-Z0-9-]+)/g;
const ENV_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})\b/g;
// Either a slash path (a/b.ext) or a (possibly multi-dot) filename (app.config.ts).
// The multi-dot form keeps whole filenames intact instead of fragmenting them.
const PATH_RE =
  /([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]+|[\w-]+(?:\.[\w-]+)*\.[a-zA-Z][a-zA-Z0-9]{0,8})\b/g;

// Common English ALL_CAPS that are not env vars.
const ENV_STOPWORDS = new Set([
  "NOTE",
  "TODO",
  "FIXME",
  "WARNING",
  "JSON",
  "HTTP",
  "HTTPS",
  "API",
  "URL",
  "CLI",
  "MIT",
  "README",
]);

// File-ish tokens that are usually prose, not real paths. Both the
// trailing-dot and bare forms, since PATH_RE can match either.
const PATH_STOPWORDS = new Set([
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "a.k.a.",
  "e.g",
  "i.e",
  "a.k.a",
  "vs",
]);

/** Extract deterministically-checkable claims from a single doc file. */
export function extractClaims(root: string, docFile: string): Claim[] {
  const abs = path.isAbsolute(docFile) ? docFile : path.join(root, docFile);
  const rel = path.relative(root, abs);
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");

  const claims: Claim[] = [];
  let inFence = false;
  let fenceLang = "";
  let counter = 0;
  const seen = new Set<string>();

  const push = (
    kind: ClaimKind,
    line: number,
    tok: string,
    assertion: string,
    hints: string[],
  ) => {
    const key = `${kind}:${tok}`;
    if (seen.has(key)) return; // one claim per distinct token keeps noise down
    seen.add(key);
    claims.push({
      id: `${rel}#${++counter}`,
      docFile: rel,
      line,
      kind,
      text: tok,
      assertion,
      searchHints: hints,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const fenceMatch = line.match(/^\s*```(\w+)?/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fenceMatch[1] ?? "").toLowerCase();
      } else {
        inFence = false;
        fenceLang = "";
      }
      continue;
    }

    // Inside a shell code block, capture commands as claims.
    if (inFence) {
      if (["bash", "sh", "shell", "console", "zsh"].includes(fenceLang)) {
        const cmd = line.replace(/^\s*\$\s?/, "").trim();
        if (cmd && !cmd.startsWith("#")) {
          extractFromCommand(cmd, lineNo, push);
        }
      }
      continue;
    }

    // Flags are distinctive (the -- prefix), so they can be claimed from prose.
    // Env vars, paths, and symbols only count inside inline code spans — raw
    // prose has too many ALL_CAPS words and dotted phrases to scan safely.
    const inlineSpans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    for (const m of line.matchAll(FLAG_RE)) {
      const flag = m[2];
      push("flag", lineNo, flag, `the CLI flag ${flag} exists`, [flag]);
    }

    for (const span of inlineSpans) {
      for (const m of span.matchAll(ENV_RE)) {
        const env = m[1];
        if (ENV_STOPWORDS.has(env)) continue;
        push("env", lineNo, env, `the environment variable ${env} is used`, [env]);
      }

      for (const m of span.matchAll(PATH_RE)) {
        const p = m[1];
        if (PATH_STOPWORDS.has(p)) continue;
        if (p.startsWith("--")) continue;
        if (p.startsWith("/")) continue; // absolute/home path, not a repo file
        push("file", lineNo, p, `the path ${p} exists`, [p]);
      }

      // A bare identifier in backticks used like a function call.
      const callMatch = span.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(\)?$/);
      if (callMatch) {
        const sym = callMatch[1];
        if (sym.length > 2) {
          push("symbol", lineNo, sym, `the symbol ${sym} exists in the code`, [sym]);
        }
      }
    }
  }

  return claims;
}

function extractFromCommand(
  cmd: string,
  lineNo: number,
  push: (kind: ClaimKind, line: number, tok: string, assertion: string, hints: string[]) => void,
): void {
  for (const m of cmd.matchAll(FLAG_RE)) {
    const flag = m[2];
    push("flag", lineNo, flag, `the CLI flag ${flag} exists`, [flag]);
  }
  for (const m of cmd.matchAll(ENV_RE)) {
    const env = m[1];
    if (ENV_STOPWORDS.has(env)) continue;
    push("env", lineNo, env, `the environment variable ${env} is used`, [env]);
  }
}
