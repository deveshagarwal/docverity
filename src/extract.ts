import { existsSync, readFileSync } from "node:fs";
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

// Standard OS / shell / XDG environment variables. Docs reference these but
// they are provided by the platform, not the documented project, so a "missing
// in source" verdict is a false positive.
const STANDARD_ENV = new Set([
  "HOME", "PATH", "PWD", "OLDPWD", "USER", "LOGNAME", "SHELL", "TERM", "LANG",
  "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "HOSTNAME", "EDITOR",
  "VISUAL", "PAGER", "DISPLAY", "SSH_AUTH_SOCK", "MANPATH", "COLUMNS", "LINES",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS",
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME",
  "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PROGRAMFILES", "PROGRAMDATA",
  "NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "NODE_OPTIONS",
]);

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

// Shell tokens that precede the *real* command: env-var assignments, sudo,
// `$`/`>` prompts, time, env, npx, and so on. We skip these to find the
// program a fenced command actually invokes.
const COMMAND_PREFIXES = new Set([
  "sudo", "time", "env", "exec", "nohup", "xargs", "command", "npx", "pnpx",
  "bunx", "yarn", "dlx",
]);

/**
 * The set of command names the *project itself* exposes — the only commands
 * whose flags are legitimately the project's own. Built from package.json:
 *  - every `bin` name (and the package `name` if `bin` is a bare string),
 *  - plus the package `name` itself (often the published CLI name).
 *
 * A flag in a fenced `git clone`/`npm install`/`tsc` command belongs to that
 * third-party tool, not to the project, so we only mine flags from commands
 * whose program is one of these names (see extractFromCommand).
 */
function projectCommandNames(root: string): Set<string> {
  const names = new Set<string>();
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  if (pkg) {
    if (typeof pkg.name === "string" && pkg.name) {
      // Strip an npm scope: "@scope/foo" is invoked as "foo".
      names.add(pkg.name.replace(/^@[^/]+\//, ""));
    }
    if (typeof pkg.bin === "string" && typeof pkg.name === "string") {
      names.add(pkg.name.replace(/^@[^/]+\//, ""));
    } else if (pkg.bin && typeof pkg.bin === "object") {
      for (const k of Object.keys(pkg.bin)) names.add(k);
    }
  }
  return names;
}

/** The project's published package name (unscoped), if any. */
function projectPackageName(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
  } catch {
    /* no package.json */
  }
  return null;
}

/**
 * Whether the project exposes its *own* command-line surface at all. Only then
 * is a `--flag` mentioned in prose plausibly one of the project's own flags
 * rather than an illustrative example or a third-party tool's flag.
 *
 * True when either:
 *  - package.json declares a `bin`, or
 *  - a fenced command in the docs invokes the project's own entry point
 *    (e.g. `node dist/index.js` where dist/index.js is the package main /
 *    a conventional entry), as opposed to a demo script under examples/.
 *
 * Pure libraries (chalk, dotenv, commander, execa, express) are NOT CLIs by
 * this test, so their prose `--flag` mentions (which belong to git/npm/node/
 * the TS compiler, or are pedagogical examples) are not mined as flag claims.
 */
function projectIsCli(root: string, docText: string): boolean {
  let pkg: any = null;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    /* no package.json */
  }
  if (pkg && pkg.bin) return true;

  // Candidate entry points the project would invoke itself with.
  const entries = new Set<string>();
  const addEntry = (p?: unknown) => {
    if (typeof p !== "string" || !p) return;
    entries.add(p.replace(/^\.\//, ""));
  };
  if (pkg) {
    addEntry(pkg.main);
    addEntry(pkg.module);
    if (pkg.exports && typeof pkg.exports === "object") {
      const dot = (pkg.exports as any)["."] ?? pkg.exports;
      if (typeof dot === "string") addEntry(dot);
      else if (dot && typeof dot === "object")
        for (const v of Object.values(dot)) if (typeof v === "string") addEntry(v);
    }
  }
  // Conventional entries, used when there is no package.json (the sample repo).
  for (const c of ["index.js", "index.mjs", "index.ts", "dist/index.js", "src/index.ts", "src/index.js"]) {
    if (existsSync(path.join(root, c))) entries.add(c);
  }

  // Look for a self-invocation in a fenced command: `node <entry> ...`.
  // The script must resolve to a real repo file that is NOT a demo/example,
  // which is what separates `node dist/index.js` (the sample CLI) from
  // commander's `node ./examples/pizza` (an illustrative script).
  // Allow leading `$`/prompt and any number of `VAR=value` assignments before
  // `node` (e.g. `API_TOKEN=xxx node dist/index.js`).
  const re =
    /(?:^|\n)[ \t]*\$?[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*node[ \t]+(?:--[\w-]+[ \t]+)*\.?\/?([\w./-]+\.[mc]?js|[\w./-]+\.ts)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docText))) {
    const script = m[1].replace(/^\.\//, "");
    if (isExampleLike(script)) continue;
    const compiledFromSrc = script.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
    if (
      entries.has(script) ||
      existsSync(path.join(root, script)) ||
      existsSync(path.join(root, compiledFromSrc))
    ) {
      return true;
    }
  }
  return false;
}

// Directory segments that mark illustrative / non-published code.
const EXAMPLE_DIR_SEGMENTS = new Set([
  "example", "examples", "demo", "demos", "fixture", "fixtures",
  "test", "tests", "__tests__", "spec", "specs", "bench", "benchmarks",
]);

function isExampleLike(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => EXAMPLE_DIR_SEGMENTS.has(seg));
}

// Changelogs, migration guides, and upgrade notes intentionally name flags,
// env vars, and options that have been REMOVED ("the following flags are no
// longer supported: --no-eslintrc"). Extracting claims from them produces pure
// false positives, so they are not checked for drift.
function isHistoricalDoc(rel: string): boolean {
  const base = (rel.split(/[\\/]/).pop() ?? "").toLowerCase();
  return /(change-?log|migrat|migrate|upgrad|deprecat|breaking[-_]?change|whats-?new)/.test(base);
}

// Prose that explicitly frames the following token as illustrative ("like",
// "such as", "for example", "e.g."). When a path span sits on such a line it
// is a hypothetical, not a claim the repo contains that file — e.g. dotenv's
// "For monorepos with a structure like `apps/backend/app.js`". Scoped to file
// claims only (the lowest-risk kind): a flag/env/symbol can legitimately be
// introduced with "like", but a *path* example almost never names a real repo
// file. The sample project's `src/legacy.ts` drift carries no such framing.
const EXAMPLE_FRAMING_RE =
  /\b(?:like|such as|for example|for instance|e\.?g\.?)\b/i;

// Universal placeholder env names that appear in docs as stand-ins for "your
// own variable", not as configuration the documented project itself reads.
// dotenv's README shows `process.env.API_KEY` purely to illustrate that a
// user's arbitrary var "will be blank" — it is never dotenv's own surface.
// Kept deliberately small and unambiguous to avoid masking a real env var.
const PLACEHOLDER_ENV = new Set([
  "API_KEY",
  "API_SECRET",
  "SECRET_KEY",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "DATABASE_URL",
  "DB_URL",
  "REDIS_URL",
  "MY_VAR",
  "MY_KEY",
  "YOUR_KEY",
  "SOME_VAR",
]);

// JavaScript/Web runtime globals: documented as `foo()` but never *defined*
// in the project's own source, so a "missing symbol" verdict would be wrong.
const RUNTIME_GLOBALS = new Set([
  "structuredClone", "fetch", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "queueMicrotask", "btoa", "atob", "require", "import",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "JSON", "Math", "Object", "Array", "Promise",
]);

/** Extract deterministically-checkable claims from a single doc file. */
export function extractClaims(root: string, docFile: string): Claim[] {
  const abs = path.isAbsolute(docFile) ? docFile : path.join(root, docFile);
  const rel = path.relative(root, abs);
  // Migration guides / changelogs legitimately name removed things; skip them.
  if (isHistoricalDoc(rel)) return [];
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");

  // Project-level context that decides which flag mentions are authoritative.
  // Computed once per doc: the command names the project owns, and whether the
  // project exposes a CLI at all (so prose `--flag`s can be its own flags).
  const ownCommands = projectCommandNames(root);
  const isCli = projectIsCli(root, text);
  const pkgName = projectPackageName(root);

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
    weak = false,
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
      weak,
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

    // Inside a shell code block, capture commands as claims — but only when
    // the command invokes the *project's own* program. Flags/env in a fenced
    // `git clone`, `npm install`, `tsc`, or `dotenvx run` belong to that tool,
    // not to the project, so mining them produces pure false positives.
    if (inFence) {
      if (["bash", "sh", "shell", "console", "zsh"].includes(fenceLang)) {
        const cmd = line.replace(/^\s*[$>]\s?/, "").trim();
        if (cmd && !cmd.startsWith("#") && commandIsOwn(cmd, ownCommands, isCli, root)) {
          extractFromCommand(cmd, lineNo, push);
        }
      }
      continue;
    }

    // Strip the *label* of any markdown link that contains inline code —
    // `[`question()`](#anchor)`, `[`structuredClone()`](https://mdn…)`, or
    // `[Import from `commander/esm.mjs`](#anchor)` — because a linked
    // symbol/path/file documents an external API, an anchor, or a removed
    // feature, not a claim that *this* repo currently defines it. (chalk/execa
    // link zx utilities & Web globals; commander's TOC links a deprecated
    // import.) Plain inline code like `loadConfig()` is left intact.
    const lineSansLinks = line.replace(/\[([^\]]*`[^`]+`[^\]]*)\]\([^)]*\)/g, " ");

    // Flags are distinctive (the -- prefix), so they can be claimed from prose —
    // but only when the project actually has a CLI of its own. For a pure
    // library, a `--flag` in prose is always a third-party flag or a teaching
    // example, never the library's own option.
    // Env vars, paths, and symbols only count inside inline code spans — raw
    // prose has too many ALL_CAPS words and dotted phrases to scan safely.
    const inlineSpans = [...lineSansLinks.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    // Does this line frame its tokens as an illustrative example? Used below to
    // drop hypothetical *path* claims (see EXAMPLE_FRAMING_RE).
    const exampleFramed = EXAMPLE_FRAMING_RE.test(line);

    // Flags inside an inline-code command for a *different* program
    // (`git add --patch`, `npm install --save`) are that tool's flags, not the
    // documented project's, even though the project itself is a CLI.
    const foreignFlags = new Set<string>();
    for (const span of inlineSpans) {
      const t = span.trim();
      if (/^[\w./@-]+\s+\S/.test(t) && /--[a-zA-Z]/.test(t) && !commandIsOwn(t, ownCommands, isCli, root)) {
        for (const fm of t.matchAll(FLAG_RE)) foreignFlags.add(fm[2]);
      }
    }
    if (isCli) {
      for (const m of lineSansLinks.matchAll(FLAG_RE)) {
        const flag = m[2];
        if (foreignFlags.has(flag)) continue;
        push("flag", lineNo, flag, `the CLI flag ${flag} exists`, [flag]);
      }
    }

    for (const span of inlineSpans) {
      // An inline span demonstrating value/parsing syntax with example data is
      // not asserting the project reads env var NAME. Two shapes:
      //   `NAME=value`  (dotenv's `SINGLE_QUOTE='quoted'`)
      //   `{NAME: ...}` (its parsed-result `{SINGLE_QUOTE: "quoted"}`)
      // A bare backticked name (`LEGACY_KEY`, `REAL_ENV`) is still a claim.
      const trimmed = span.trim();
      const isExampleAssignment =
        /^[A-Z][A-Z0-9_]*\s*=/.test(trimmed) || /^\{\s*[A-Z][A-Z0-9_]*\s*:/.test(trimmed);
      for (const m of span.matchAll(ENV_RE)) {
        const env = m[1];
        if (ENV_STOPWORDS.has(env) || STANDARD_ENV.has(env)) continue;
        if (isExampleAssignment) continue;
        if (PLACEHOLDER_ENV.has(env)) continue; // user-supplied placeholder, not project surface
        // Env vars named only in inline prose are often examples; treat drift on
        // them as a warning. The strong `VAR=value` shell form (below) stays an error.
        push("env", lineNo, env, `the environment variable ${env} is used`, [env], true);
      }

      for (const m of span.matchAll(PATH_RE)) {
        const p = m[1];
        if (PATH_STOPWORDS.has(p)) continue;
        if (p.startsWith("--")) continue;
        if (p.startsWith("/")) continue; // absolute/home path, not a repo file
        // A path that points into a dependency dir (`./node_modules/.bin`) is
        // never one of the repo's own source files.
        if (p.split(/[\\/]/).some((seg) => seg === "node_modules")) continue;
        // A module-import specifier prefixed with the project's own package
        // name (`commander/esm.mjs`) resolves via package `exports`, not as a
        // repo-relative file — so a "missing file" verdict would be spurious.
        if (pkgName && p.startsWith(pkgName + "/")) continue;
        // A path introduced as an example ("a structure like `apps/backend/app.js`")
        // is hypothetical, not an assertion the repo contains this file.
        if (exampleFramed) continue;
        push("file", lineNo, p, `the path ${p} exists`, [p]);
      }

      // A bare identifier in backticks used like a function call.
      const callMatch = span.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(\)?$/);
      if (callMatch) {
        const sym = callMatch[1];
        // Runtime globals (structuredClone, fetch, …) are documented as calls
        // but defined by the platform, not the repo: never assert drift on them.
        if (sym.length > 2 && !RUNTIME_GLOBALS.has(sym)) {
          push("symbol", lineNo, sym, `the symbol ${sym} exists in the code`, [sym]);
        }
      }
    }
  }

  return claims;
}

/**
 * Decide whether a fenced shell command is the project invoking itself, so its
 * flags/env are the project's own. Skips leading env-assignments and prefixes
 * (sudo/time/npx/…) to find the real program, then accepts it when:
 *  - it is one of the project's declared command names, or
 *  - it is `node <project-entry>` (a self-invocation of the repo's own CLI).
 */
function commandIsOwn(
  cmd: string,
  ownCommands: Set<string>,
  isCli: boolean,
  root: string,
): boolean {
  const toks = cmd.split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip VAR=value assignments and known command prefixes.
  while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || COMMAND_PREFIXES.has(toks[i]))) {
    i++;
  }
  if (i >= toks.length) return false;
  const prog = toks[i].replace(/^\.?\//, "");
  if (ownCommands.has(prog)) return true;

  // `node <script>` where the script is the project's own (non-example) entry.
  if (prog === "node" && isCli) {
    let j = i + 1;
    while (j < toks.length && toks[j].startsWith("-")) j++; // skip node flags
    const script = (toks[j] ?? "").replace(/^\.?\//, "");
    if (script && !isExampleLike(script)) {
      const compiledFromSrc = script.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      if (
        existsSync(path.join(root, script)) ||
        existsSync(path.join(root, compiledFromSrc))
      ) {
        return true;
      }
    }
  }
  return false;
}

function extractFromCommand(
  cmd: string,
  lineNo: number,
  push: (kind: ClaimKind, line: number, tok: string, assertion: string, hints: string[]) => void,
): void {
  // Only the first command in a pipe/chain is the one we verified is the
  // project's own; flags after a |, ;, &&, or || belong to a different program
  // (e.g. `mytool ... | downstream --option`).
  const own = cmd.split(/\s*(?:&&|\|\||[|;])\s*/)[0];
  for (const m of own.matchAll(FLAG_RE)) {
    const flag = m[2];
    push("flag", lineNo, flag, `the CLI flag ${flag} exists`, [flag]);
  }
  // Only treat NAME=value *assignments* (e.g. `API_TOKEN=xxx node …`) as env
  // claims, not bare ALL_CAPS appearing in argument values or printed output.
  for (const m of cmd.matchAll(/(^|\s)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})=/g)) {
    const env = m[2];
    if (ENV_STOPWORDS.has(env) || STANDARD_ENV.has(env)) continue;
    // A `VAR=value` assignment in a shell command is a strong, non-example
    // signal that the project reads this env var: drift on it is an error.
    push("env", lineNo, env, `the environment variable ${env} is used`, [env]);
  }
}
