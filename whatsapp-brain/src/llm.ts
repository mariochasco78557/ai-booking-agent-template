/**
 * OpenRouter chat completions with tool calling (OpenAI format).
 *
 * - `provider.data_collection: "deny"`: only providers that do not store or
 *   train on prompts may serve these requests — they carry customers' names.
 * - For Anthropic models the static system prompt is marked `cache_control`,
 *   so its ~7k tokens are billed at the cached rate after the first message.
 */
import type { ToolDefinition } from "./tools.js";
import { requestJson, type FetchLike } from "./http.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export interface LlmApi {
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult>;
}

export class LlmError extends Error {}

export class OpenRouterClient implements LlmApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 45_000
  ) {}

  /** Static system prompt as a cacheable block when the model supports it. */
  systemMessage(text: string): ChatMessage {
    if (this.model.startsWith("anthropic/")) {
      return { role: "system", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
    }
    return { role: "system", content: text };
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const body = {
      model: this.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 700,
      provider: { data_collection: "deny" },
      usage: { include: true },
    };
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await requestJson(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "x-title": "Demo Salon WhatsApp",
        },
        body,
        timeoutMs: this.timeoutMs,
      });
      lastStatus = res.status;
      if (res.status === 200 && res.body && typeof res.body === "object") {
        const b = res.body as {
          choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
          usage?: ChatResult["usage"];
        };
        const msg = b.choices?.[0]?.message;
        if (!msg) throw new LlmError("empty completion");
        return {
          content: typeof msg.content === "string" ? msg.content : null,
          toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
          usage: b.usage,
        };
      }
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new LlmError(`OpenRouter answered HTTP ${lastStatus}`);
  }
}
