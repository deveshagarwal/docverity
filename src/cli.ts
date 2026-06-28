#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import kleur from "kleur";
import type { CheckOptions, Verdict } from "./types.js";
import { extractClaims } from "./extract.js";
import { verifyReference } from "./verify-reference.js";
import { verifyLlm } from "./verify-llm.js";
import { hasApiKey } from "./llm.js";
import { printReport, printGithubAnnotations, toJson, summarize } from "./report.js";
import { discoverDocs } from "./discover.js";
import { runMcpServer } from "./mcp.js";

const program = new Command();

program
  .name("docverity")
  .description("Catch documentation that lies about your code.")
  .version("0.1.0");

program
  .command("check", { isDefault: true })
  .description("Check docs for claims that no longer match the code.")
  .argument("[docs...]", "doc files to check (default: README + docs/**/*.md)")
  .option("-C, --root <dir>", "repo root", process.cwd())
  .option("--no-llm", "skip the LLM claim verifier (deterministic checks only)")
  .option("--model <id>", "model for the LLM engine", "claude-opus-4-8")
  .option("--fail-confidence <n>", "min confidence to fail on (0..1)", "0.7")
  .option("--strict", "also fail on unverifiable claims", false)
  .option("--format <fmt>", "output format: pretty | json | github", "pretty")
  .action(async (docs: string[], rawOpts) => {
    const root = path.resolve(rawOpts.root);
    const docFiles = docs.length ? docs : discoverDocs(root);

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
      failConfidence: Number(rawOpts.failConfidence),
      strict: Boolean(rawOpts.strict),
    };

    const verdicts: Verdict[] = [];
    for (const doc of docFiles) {
      const claims = extractClaims(root, doc);
      verdicts.push(...(await verifyReference(root, claims)));
      if (useLlm) {
        try {
          verdicts.push(...(await verifyLlm(root, doc, opts.model)));
        } catch (err: any) {
          console.error(
            kleur.yellow(`LLM engine failed on ${doc}: ${err?.message ?? err}`),
          );
        }
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
    await runMcpServer();
  });

program.parseAsync();
