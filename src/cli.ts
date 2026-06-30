#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { existsSync } from "node:fs";
import kleur from "kleur";
import type { CheckOptions, Verdict } from "./types.js";
import { extractClaims } from "./extract.js";
import { verifyReference } from "./verify-reference.js";
import { findUndocumented } from "./coverage.js";
import { findUndocumentedCapabilities } from "./coverage-llm.js";
import { enrichWithGitHistory, type GitStaleness } from "./git.js";
import { checkSelfCount, checkNarrative } from "./narrative.js";
import { runSuggest, renderSuggestionsBlock, writeSuggestions } from "./suggest.js";
import { hasApiKey, apiKeySampler, claudeCliSampler, hasClaudeCli } from "./llm.js";
import { adjudicateVerdicts } from "./adjudicate.js";
import type { Severity } from "./types.js";
import { printReport, printGithubAnnotations, toJson, summarize } from "./report.js";
import { discoverDocs } from "./discover.js";
// verify-llm and mcp pull in heavy SDKs; they are imported lazily, only when used.

const program = new Command();

program
  .name("docverity")
  .description("Catch documentation that lies about your code.")
  .version("0.5.0");

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
    if (rawOpts.llm && !hasApiKey() && !hasClaudeCli() && rawOpts.format === "pretty") {
      console.error(
        kleur.dim(
          "No ANTHROPIC_API_KEY or `claude` CLI found — running deterministic checks only.",
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

    let verdicts: Verdict[] = [];
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

    // Git history: elevate undocumented surface the code added after the docs
    // were last updated, and surface a staleness headline. Best-effort.
    let staleness: GitStaleness | null = null;
    if (opts.coverage) {
      try {
        staleness = enrichWithGitHistory(root, verdicts, docFiles);
        verdicts = staleness.verdicts;
      } catch {
        /* not a git repo, shallow clone, etc. — skip */
      }
    }

    // Narrative self-consistency: a section that says "three checks" but lists
    // four. Deterministic, no model.
    for (const doc of docFiles) {
      try {
        verdicts.push(...checkSelfCount(root, doc));
      } catch {
        /* best-effort */
      }
    }

    // Adjudicate candidate findings with a model when one is reachable — our own
    // key, or the user's `claude` CLI (Claude Code), no key required — dismissing
    // examples, removed-flag mentions, and third-party references the
    // deterministic engine cannot tell from real drift.
    if (rawOpts.llm) {
      const sampler = apiKeySampler(opts.model) ?? claudeCliSampler();
      if (sampler) {
        try {
          const adj = await adjudicateVerdicts(root, verdicts, sampler);
          verdicts = adj.kept;
          if (adj.dismissed && rawOpts.format === "pretty") {
            console.error(
              kleur.dim(`${adj.dismissed} finding(s) dismissed by the model as false positives.`),
            );
          }
        } catch (err: any) {
          console.error(kleur.yellow(`Adjudication failed: ${err?.message ?? err}`));
        }

        // Behavioral coverage: capabilities the code exposes (a mode, a
        // subcommand's behavior, an output format) that the docs never mention.
        // The token scanner can't see these; the model can.
        if (opts.coverage) {
          try {
            verdicts.push(...(await findUndocumentedCapabilities(root, sampler)));
          } catch (err: any) {
            console.error(kleur.yellow(`Capability coverage failed: ${err?.message ?? err}`));
          }
        }

        // Narrative faithfulness: descriptive sections (a pipeline, an
        // enumeration) that omit a step the code actually runs.
        try {
          verdicts.push(...(await checkNarrative(root, docFiles, sampler)));
        } catch (err: any) {
          console.error(kleur.yellow(`Narrative check failed: ${err?.message ?? err}`));
        }
      }
    }

    if (
      rawOpts.format === "pretty" &&
      staleness?.baseline &&
      staleness.commitsSince > 0
    ) {
      console.error(
        kleur.dim(
          `Docs last changed ${staleness.baseline.date}; ${staleness.commitsSince} commit(s) to the repo since.`,
        ),
      );
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

program
  .command("suggest")
  .description("Draft documentation for everything the code exposes but the docs don't cover.")
  .argument("[docs...]", "doc files to consider (default: README + docs/**/*.md)")
  .option("-C, --root <dir>", "repo root", process.cwd())
  .option("--model <id>", "model used to draft the docs", "claude-opus-4-8")
  .option("--write", "append the suggestions to a doc file instead of only printing", false)
  .option("--into <file>", "file to append to with --write (default: first doc, else README.md)")
  .action(async (docs: string[], rawOpts) => {
    const root = path.resolve(rawOpts.root);
    const docFiles = docs.length
      ? docs.map((d) => path.relative(root, path.resolve(d)))
      : discoverDocs(root);

    // Drafting needs a model. Same resolution order as the check command.
    const sampler = apiKeySampler(rawOpts.model) ?? claudeCliSampler();
    if (!sampler) {
      console.error(
        kleur.red(
          "`suggest` needs a model. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or install the `claude` CLI.",
        ),
      );
      process.exit(2);
    }

    const suggestions = await runSuggest(root, docFiles, sampler);
    if (!suggestions.length) {
      console.log(
        kleur.green("Nothing to suggest — the docs already cover the code's surface."),
      );
      process.exit(0);
    }

    if (rawOpts.write) {
      const into = rawOpts.into
        ? path.relative(root, path.resolve(rawOpts.into))
        : docFiles[0] ?? "README.md";
      const written = writeSuggestions(root, into, suggestions);
      console.log(
        kleur.green(
          `Wrote ${suggestions.length} suggestion(s) to ${written} between docverity markers. Review, edit, then remove the markers.`,
        ),
      );
    } else {
      console.log(
        kleur.bold(`\n${suggestions.length} documentation suggestion(s):\n`),
      );
      console.log(renderSuggestionsBlock(suggestions));
      console.log(kleur.dim("Re-run with --write to append these to a doc file."));
    }
  });

program.parseAsync();
