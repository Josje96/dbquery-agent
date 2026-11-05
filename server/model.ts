// One client for any OpenAI-compatible API: OpenRouter, Requesty or a local server.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GeneratedQuery {
  sql: string;
  explanation: string;
}

export interface ModelProvider {
  generateQuery(messages: ChatMessage[]): Promise<GeneratedQuery>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** In US dollars, when the API reports it. */
  cost: number | null;
  provider: string | null;
}

export interface ModelConfig {
  onUsage?: (usage: ModelUsage) => void;
  baseUrl: string;
  apiKey: string;
  model: string;
  requireZdr: boolean;
  /** Left out of the request when undefined, for models that reject it. */
  temperature?: number;
  timeoutMs?: number;
}

const QUERY_SCHEMA = {
  name: "generated_query",
  strict: true,
  schema: {
    type: "object",
    properties: {
      sql: { type: "string" },
      explanation: { type: "string" },
    },
    required: ["sql", "explanation"],
    additionalProperties: false,
  },
};

export function parseGeneratedQuery(content: string): GeneratedQuery {
  // Some models wrap JSON in a code fence even when asked not to.
  const json = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const parsed = JSON.parse(json) as Partial<GeneratedQuery>;
  if (typeof parsed.sql !== "string" || typeof parsed.explanation !== "string") {
    throw new Error("Model response is missing sql or explanation");
  }
  return { sql: parsed.sql, explanation: parsed.explanation };
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  return {
    async generateQuery(messages) {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          max_tokens: 2000,
          response_format: { type: "json_schema", json_schema: QUERY_SCHEMA },
          ...(config.requireZdr
            ? { provider: { zdr: true, data_collection: "deny", require_parameters: true } }
            : {}),
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 90_000),
      });

      if (!response.ok) {
        throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
        provider?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      // Reported before the content check, because empty replies are still billed.
      config.onUsage?.({
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cost: body.usage?.cost ?? null,
        provider: body.provider ?? null,
      });
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("Model returned an empty response");
      return parseGeneratedQuery(content);
    },
  };
}
