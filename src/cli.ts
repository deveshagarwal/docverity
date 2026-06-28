#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { existsSync } from "node:fs";
import kleur from "kleur";
import type { CheckOptions, Verdict } from "./types.js";
import { extractClaims } from "./extract.js";
import { verifyReference } from "./verify-reference.js";
import { findUndocumented } from "./coverage.js";
import { hasApiKey } from "./llm.js";
import type { Severity } from "./types.js";
import { printReport, printGithubAnnotations, toJson, summarize } from "./report.js";
import { discoverDocs } from "./discover.js";
// verify-llm and mcp pull in heavy SDKs; they are imported lazily, only when used.

const program = new Command();

program
  .name("docverity")
  .description("Catch documentation that lies about your code.")
  .version("0.3.0");

program
  .command("check", { isDefault: true })
  .description("Check docs for claims that no longer match the code.")
  .argument("[docs...]", "doc files to check (default: README + docs/**/*.md)")
  .option("-C, --root <dir>", "repo root", process.cwd())
  .option("--no-llm", "skip the LLM claim verifier (deterministic checks only)")
  .option("--model <id>", "model for the LLM engine", "claude-opus-4-8")
  .option("--no-coverage", "skip the code->docs check for undocumented flags/env vars")
  .option("--fail-confidence <n>", "min confidence to fail on (0..1)", "0.7")
  .option("--fail-on <level>", "lowest severity that fails the build: error|warning|info|none", "error")
  .option("--strict", "also fail on unverifiable claims", false)
  .option("--format <fmt>", "output format: pretty | json | github", "pretty")
  .action(async (docs: string[], rawOpts) => {
    const root = path.resolve(rawOpts.root);

    // A non-numeric threshold must never silently pass CI. Exit 2 = config error
    // (distinct from 1 = drift found).
    const failConfidence = Number(rawOpts.failConfidence);
    if (!Number.isFinite(failConfidence) || failConfidence < 0 || failConfidence > 1) {
      console.error(
        kleur.red(
          `Invalid --fail-confidence: ${rawOpts.failConfidence} (expected a number between 0 and 1).`,
        ),
      );
      process.exit(2);
    }

    // Resolve explicit doc args relative to root (path.resolve handles
    // absolute/cwd-relative); path.relative makes them root-relative for the
    // extractor and verifier, fixing the old root+arg double-join.
    const docFiles = docs.length
      ? docs.map((d) => path.relative(root, path.resolve(d)))
      : discoverDocs(root);

    if (docs.length) {
      const missing = docFiles.filter((d) => !existsSync(path.join(root, d)));
      if (missing.length) {
        console.error(kleur.red(`Doc file(s) not found: ${missing.join(", ")}`));
        process.exit(2);
      }
    }

    const failOn = String(rawOpts.failOn) as Severity | "none";
    if (!["error", "warning", "info", "none"].includes(failOn)) {
      console.error(
        kleur.red(`Invalid --fail-on: ${rawOpts.failOn} (expected error|warning|info|none).`),
      );
      process.exit(2);
    }

    if (!docFiles.length) {
      console.error(kleur.yellow("No documentation files found."));
      process.exit(0);
    }

    const useLlm = rawOpts.llm && hasApiKey();
    if (rawOpts.llm && !hasApiKey() && rawOpts.format === "pretty") {
      console.error(
        kleur.dim(
          "No ANTHROPIC_API_KEY set — running deterministic checks only. Set a key to verify prose claims.",
        ),
      );
    }

    const opts: CheckOptions = {
      root,
      docFiles,
      useLlm,
      model: rawOpts.model,
      coverage: rawOpts.coverage !== false,
      failConfidence,
      failOn,
      strict: Boolean(rawOpts.strict),
    };

    // Lazy-load the LLM engine (and its SDK) only when actually used.
    const verifyLlm = useLlm ? (await import("./verify-llm.js")).verifyLlm : null;

    const verdicts: Verdict[] = [];
    for (const doc of docFiles) {
      try {
        verdicts.push(...(await verifyReference(root, extractClaims(root, doc))));
      } catch (err: any) {
        console.error(kleur.yellow(`Cannot check ${doc}: ${err?.message ?? err}`));
        continue;
      }
      if (verifyLlm) {
        try {
          verdicts.push(...(await verifyLlm(root, doc, opts.model)));
        } catch (err: any) {
          console.error(
            kleur.yellow(`LLM engine failed on ${doc}: ${err?.message ?? err}`),
          );
        }
      }
    }

    // Coverage: flags/env vars the code uses but the docs never mention.
    if (opts.coverage) {
      try {
        verdicts.push(...findUndocumented(root, docFiles));
      } catch (err: any) {
        console.error(kleur.yellow(`Coverage check failed: ${err?.message ?? err}`));
      }
    }

    let shouldFail: boolean;
    if (rawOpts.format === "json") {
      console.log(toJson(verdicts, opts));
      shouldFail = summarize(verdicts, opts).failures.length > 0;
    } else if (rawOpts.format === "github") {
      printGithubAnnotations(verdicts, opts);
      shouldFail = summarize(verdicts, opts).failures.length > 0;
    } else {
      shouldFail = printReport(verdicts, opts);
    }

    process.exit(shouldFail ? 1 : 0);
  });

program
  .command("mcp")
  .description("Run as an MCP server (stdio) so agents can check docs as a tool.")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program.parseAsync();
