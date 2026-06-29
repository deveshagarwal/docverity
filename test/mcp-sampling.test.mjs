import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "../dist/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Connect a host Client (declaring the sampling capability) to docverity's
// server over an in-memory transport, with a custom sampling handler.
async function connectHost(onSample) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "host", version: "1.0.0" }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, onSample);
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const idsIn = (req) =>
  [...req.params.messages[0].content.text.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
const reply = (verdicts) => ({
  role: "assistant",
  model: "mock-host",
  content: { type: "text", text: JSON.stringify({ verdicts }) },
});
const parseResult = (res) => {
  const text = res.content.map((c) => c.text).join("\n");
  return { text, result: JSON.parse(text.slice(text.indexOf("{"))) };
};
const SAMPLE = path.resolve("examples/sample-project");

test("the server delegates to the host model and dismisses what it rejects", async () => {
  let sampled = false;
  const client = await connectHost(async (req) => {
    sampled = true;
    return reply(idsIn(req).map((id) => ({ id, realProblem: false, reason: "mock dismissed" })));
  });
  const res = await client.callTool({ name: "check_docs", arguments: { root: SAMPLE, llm: false } });
  const { text, result } = parseResult(res);
  assert.ok(sampled, "server should request sampling from the host");
  assert.match(text, /dismissed as false positives/);
  assert.match(result.summary.engine, /host-llm/);
  assert.equal(result.findings.length, 0, "all candidates dismissed -> no findings");
  await client.close();
});

test("findings the host confirms survive; the rest are removed", async () => {
  const client = await connectHost(async (req) =>
    reply(idsIn(req).map((id) => ({ id, realProblem: id.includes("legacy"), reason: "" }))),
  );
  const res = await client.callTool({ name: "check_docs", arguments: { root: SAMPLE, llm: false } });
  const { result } = parseResult(res);
  const texts = result.findings.map((f) => f.text);
  assert.ok(texts.includes("src/legacy.ts"), "host-confirmed finding is kept");
  assert.ok(!texts.includes("--pretty"), "host-dismissed finding is removed");
  await client.close();
});
