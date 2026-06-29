import path from "node:path";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Verdict } from "./types.js";
import { extractClaims } from "./extract.js";
import { verifyReference } from "./verify-reference.js";
import { findUndocumented } from "./coverage.js";
import { verifyLlm } from "./verify-llm.js";
import { hasApiKey } from "./llm.js";
import { discoverDocs } from "./discover.js";
import { severityRank } from "./severity.js";
import { adjudicate, type Sampler, type Candidate } from "./adjudicate.js";

/** A few lines of context around a finding's location, for the adjudicator. */
function contextLines(root: string, file: string, line: number, radius = 3): string {
  try {
    const lines = readFileSync(path.join(root, file), "utf8").split("\n");
    const from = Math.max(0, line - 1 - radius);
    const to = Math.min(lines.length, line + radius);
    return lines.slice(from, to).join("\n");
  } catch {
    return "";
  }
}

// The description is the agent's selection signal: it must say *when* to call
// the tool, not just what it does. Recent models under-reach for tools, so the
// trigger conditions are load-bearing.
const CHECK_DESCRIPTION = `Check whether a project's documentation still matches its source code, and report the claims that have drifted (gone stale or wrong).

Call this AFTER you edit, rename, move, or delete source files, CLI flags, environment variables, or functions — to catch documentation you may have just made inaccurate. Also call it when the user asks whether the README or docs are still correct, before cutting a release, or when reviewing a pull request that changes code.

Returns each drifted documentation claim with its file and line, the exact stale text, supporting code evidence, a confidence score, and a suggested fix you can apply directly with an edit. Fast and free by default (deterministic checks, no API key required); pass llm=true to additionally verify prose-level claims such as default values, return types, and described behavior.`;

const CHECK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    root: {
      type: "string",
      description: "Repository root to check. Defaults to the current working directory.",
    },
    docs: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific doc files to check, relative to root. Defaults to README plus docs/**/*.md.",
    },
    llm: {
      type: "boolean",
      description:
        "Also run the LLM prose verifier (needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). Default false.",
    },
    coverage: {
      type: "boolean",
      description:
        "Also report flags/env vars the code uses but the docs never mention. Default true.",
    },
    failConfidence: {
      type: "number",
      description: "Minimum confidence (0..1) for a finding to be reported. Default 0.7.",
    },
  },
};

const MAX_FINDINGS = 50;

interface Finding {
  doc: string;
  line: number;
  kind: string;
  text: string;
  status: "drifted" | "undocumented";
  severity: string;
  confidence: number;
  engine: string;
  explanation: string;
  suggestedFix?: string;
  evidence?: string;
}

async function runCheck(
  args: {
    root?: string;
    docs?: string[];
    llm?: boolean;
    coverage?: boolean;
    failConfidence?: number;
  },
  sampler?: Sampler,
): Promise<{ summary: Record<string, unknown>; findings: Finding[]; note?: string }> {
  const root = path.resolve(args.root ?? process.cwd());
  const docFiles = args.docs?.length ? args.docs : discoverDocs(root);
  const failConfidence = args.failConfidence ?? 0.7;
  const wantLlm = Boolean(args.llm);
  const useLlm = wantLlm && hasApiKey();
  const wantCoverage = args.coverage !== false;

  const verdicts: Verdict[] = [];
  let llmRan = false;
  let llmError: string | undefined;
  for (const doc of docFiles) {
    verdicts.push(...(await verifyReference(root, extractClaims(root, doc))));
    if (useLlm) {
      try {
        verdicts.push(...(await verifyLlm(root, doc, "claude-opus-4-8")));
        llmRan = true;
      } catch (err: any) {
        // Don't fail the whole tool call; surface it as a note so the agent
        // knows it got deterministic-only results, not a clean pass.
        llmError = err?.message ?? String(err);
      }
    }
  }
  if (wantCoverage) {
    try {
      verdicts.push(...findUndocumented(root, docFiles));
    } catch {
      /* coverage is best-effort */
    }
  }

  let ok = 0;
  let drifted = 0;
  let unverifiable = 0;
  let undocumented = 0;
  const findings: Finding[] = [];
  for (const v of verdicts) {
    if (v.status === "ok") ok++;
    else if (v.status === "drifted") drifted++;
    else if (v.status === "undocumented") undocumented++;
    else unverifiable++;

    // Surface actionable drift and coverage gaps; unverifiable claims stay in
    // the counts but would be noise for an agent to act on.
    if (
      !((v.status === "drifted" || v.status === "undocumented") &&
        v.confidence >= failConfidence)
    ) {
      continue;
    }

    findings.push({
      doc: v.claim.docFile,
      line: v.claim.line,
      kind: v.claim.kind,
      text: v.claim.text,
      status: v.status,
      severity: v.severity,
      confidence: Number(v.confidence.toFixed(2)),
      engine: v.engine,
      explanation: v.explanation,
      suggestedFix: v.suggestedFix,
      evidence: v.evidence[0] ? `${v.evidence[0].file}:${v.evidence[0].line}` : undefined,
    });
  }

  // Host-LLM adjudication: when the calling agent's model is reachable (MCP
  // sampling), let it dismiss the false positives a token matcher cannot tell
  // from real drift — examples, removed/deprecated mentions, third-party and
  // standard vars. No API key of our own; uses the caller's model.
  let dismissed = 0;
  let adjudicated = false;
  if (sampler && findings.length) {
    const idOf = (f: Finding) => `${f.doc}:${f.line}:${f.kind}:${f.text}`;
    const candidates: Candidate[] = findings.map((f) => ({
      id: idOf(f),
      kind: f.kind,
      text: f.text,
      status: f.status,
      location: `${f.doc}:${f.line}`,
      context: contextLines(root, f.doc, f.line),
      note: f.explanation,
    }));
    const rulings = await adjudicate(candidates, sampler);
    if (rulings.size) {
      adjudicated = true;
      const kept: Finding[] = [];
      for (const f of findings) {
        const r = rulings.get(idOf(f));
        if (r && !r.real) {
          dismissed++;
          continue;
        }
        if (r?.reason) f.explanation = `${f.explanation} (confirmed by host model: ${r.reason})`;
        kept.push(f);
      }
      findings.splice(0, findings.length, ...kept);
    }
  }

  // Errors first, then by confidence — the agent should act on these top-down.
  findings.sort(
    (a, b) =>
      severityRank(b.severity as any) - severityRank(a.severity as any) ||
      b.confidence - a.confidence,
  );

  const truncated = findings.length > MAX_FINDINGS;
  const shown = findings.slice(0, MAX_FINDINGS);

  let note: string | undefined;
  const addNote = (s: string) => {
    note = note ? `${note} ${s}` : s;
  };
  if (wantLlm && !hasApiKey()) {
    addNote(
      "llm=true was requested but no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is set; ran deterministic checks only.",
    );
  }
  if (llmError) {
    addNote(`LLM prose verifier failed: ${llmError}; reported deterministic results only.`);
  }
  if (truncated) {
    addNote(`Showing ${MAX_FINDINGS} of ${findings.length} findings.`);
  }
  if (adjudicated) {
    addNote(
      `Adjudicated by the host model via MCP sampling; ${dismissed} candidate(s) dismissed as false positives.`,
    );
  } else if (sampler) {
    addNote("Host-model adjudication returned no usable result; showing raw deterministic findings.");
  }

  const engineParts = ["reference"];
  if (useLlm && llmRan) engineParts.push("llm");
  if (adjudicated) engineParts.push("host-llm");

  return {
    summary: {
      docsChecked: docFiles,
      ok,
      drifted,
      undocumented,
      unverifiable,
      engine: engineParts.join("+"),
    },
    findings: shown,
    note,
  };
}

/** Build the MCP server with its handlers (transport-agnostic; reused by tests). */
export function createServer(): Server {
  const server = new Server(
    { name: "docverity", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "check_docs",
        description: CHECK_DESCRIPTION,
        inputSchema: CHECK_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "check_docs") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      // If the host supports MCP sampling, hand candidate findings to its model
      // (the user's own Claude) to adjudicate — no API key of our own.
      const caps = server.getClientCapabilities();
      const sampler: Sampler | undefined = caps?.sampling
        ? async (system, user) => {
            const res = await server.createMessage({
              systemPrompt: system,
              messages: [{ role: "user", content: { type: "text", text: user } }],
              maxTokens: 2000,
            });
            const c: any = res.content;
            return c && c.type === "text" ? c.text : "";
          }
        : undefined;
      const result = await runCheck((req.params.arguments ?? {}) as any, sampler);
      const headline =
        result.findings.length === 0
          ? "No doc drift detected."
          : `${result.findings.length} documentation claim(s) need attention.`;
      return {
        content: [
          { type: "text", text: `${headline}\n\n${JSON.stringify(result, null, 2)}` },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          { type: "text", text: `docverity check failed: ${err?.message ?? err}` },
        ],
      };
    }
  });

  return server;
}

/** Start the stdio MCP server. Only protocol messages go to stdout. */
export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
