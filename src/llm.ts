// The Anthropic SDK is imported lazily so the default deterministic path (and
// `npx docverity` cold start) never pays to load it.

let client: any = null;

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function getClient(): Promise<any> {
  if (client) return client;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
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
 * output_config.format guarantees the first text block is valid JSON.
 */
export async function structuredCall<T>(
  model: string,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<T> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };
  const c = await getClient();
  const res = await c.messages.create(params as never);

  const block = res.content.find((b: any) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (!block) throw new Error("Model returned no text content.");
  try {
    return JSON.parse(block.text) as T;
  } catch {
    throw new Error(
      "LLM returned truncated or non-JSON output (may have exceeded max_tokens).",
    );
  }
}
