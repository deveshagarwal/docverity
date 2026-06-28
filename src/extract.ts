import { readFileSync } from "node:fs";
import path from "node:path";
import type { Claim, ClaimKind } from "./types.js";

// Patterns for the kinds of token a doc can reference that we can check
// deterministically against the source tree.
const FLAG_RE = /(^|[\s(`"'])(--[a-zA-Z][a-zA-Z0-9-]+)/g;
const ENV_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})\b/g;
const PATH_RE = /([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]+|[\w-]+\.[a-zA-Z]{2,4})/g;

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

// File-ish tokens that are usually prose, not real paths.
const PATH_STOPWORDS = new Set(["e.g.", "i.e.", "etc.", "vs.", "a.k.a."]);

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

    // Outside code: scan inline code spans plus the raw line for tokens.
    const inlineSpans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const scanText = line;

    for (const m of scanText.matchAll(FLAG_RE)) {
      const flag = m[2];
      push("flag", lineNo, flag, `the CLI flag ${flag} exists`, [flag]);
    }

    for (const m of scanText.matchAll(ENV_RE)) {
      const env = m[1];
      if (ENV_STOPWORDS.has(env)) continue;
      push("env", lineNo, env, `the environment variable ${env} is used`, [env]);
    }

    // Only treat path-looking tokens inside inline code as path claims, to
    // avoid matching ordinary prose words with dots.
    for (const span of inlineSpans) {
      for (const m of span.matchAll(PATH_RE)) {
        const p = m[1];
        if (PATH_STOPWORDS.has(p)) continue;
        if (p.startsWith("--")) continue;
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
