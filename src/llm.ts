import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient(): Anthropic {
  if (client) return client;
  // Prefer an API key; otherwise fall back to a Bearer/OAuth token (e.g. from
  // `ant auth login`), which needs the oauth beta header on every request.
  if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN) {
    client = new Anthropic({
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  } else {
    client = new Anthropic();
  }
  return client;
}

/**
 * Call the model with a forced JSON schema and return the parsed object.
 * Uses output_config.format so the first text block is guaranteed valid JSON.
 */
export async function structuredCall<T>(
  model: string,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<T> {
  // Built as an untyped param: `adaptive` thinking and `output_config` are
  // supported by the API but newer than this SDK version's type definitions.
  const params: Record<string, unknown> = {
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };
  const res = await getClient().messages.create(params as never);

  const block = res.content.find((b) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (!block) throw new Error("Model returned no text content.");
  return JSON.parse(block.text) as T;
}
