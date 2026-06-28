import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/cli.js", "mcp"],
  });
  const client = new Client({ name: "docverity-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("exposes the check_docs tool with a trigger-rich description", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "check_docs");
    assert.ok(tool, "check_docs tool should be listed");
    assert.match(tool.description, /Call this AFTER/i, "description should state triggers");
    assert.ok(tool.inputSchema.properties.llm, "should expose the llm option");
  });
});

test("check_docs reports drift in the sample project", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "check_docs",
      arguments: { root: path.resolve("examples/sample-project"), llm: false },
    });
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /need attention/i);
    assert.match(text, /src\/legacy\.ts/, "should flag the missing file reference");
    assert.match(text, /"engine": "reference"/, "deterministic engine by default");
  });
});
