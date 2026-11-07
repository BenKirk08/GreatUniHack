import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (client) return client;
  client = new Anthropic({
    apiKey: serverEnv().ANTHROPIC_API_KEY,
    // Route budgets are 60s; callers on a deadline pass tighter per-request limits.
    timeout: 25_000,
    maxRetries: 1,
  });
  return client;
}

export function claudeModel(): string {
  return serverEnv().ANTHROPIC_MODEL;
}

export class ClaudeRefusalError extends Error {}

/**
 * Make Claude answer by calling one specific tool, and return that tool's input (validate it with zod).
 *
 * Claude Sonnet 5.5 rejects forced `tool_choice` ("tool"/"any") with a 400, so the call is forced the
 * supported way: the tool is `strict` (arguments always match its schema), `tool_choice` is `auto` with
 * parallel calls off, the prompt names the tool, and we retry once if no call comes back.
 * Server-side refusal fallbacks are on, so a safety-classifier decline is retried on a fallback model.
 */
export async function forcedToolCall(params: {
  system: string;
  user: string;
  tool: Anthropic.Beta.BetaTool;
  effort: "low" | "medium" | "high";
  maxTokens?: number;
  /** Per-request limits (default: the client's 25s / 1 retry). */
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<unknown> {
  const tool: Anthropic.Beta.BetaTool = { ...params.tool, strict: true };
  const content = `${params.user}\n\nRespond only by calling the ${tool.name} tool.`;

  let lastStop: string | null = null;
  const attempts = params.maxRetries === 0 ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await anthropic().beta.messages.create({
      model: claudeModel(),
      max_tokens: params.maxTokens ?? 16_000,
      system: params.system,
      tools: [tool],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: params.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    }, {
      ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
      ...(params.maxRetries !== undefined ? { maxRetries: params.maxRetries } : {}),
    });

    if (response.stop_reason === "refusal") {
      throw new ClaudeRefusalError(
        `Claude declined (${response.stop_details?.category ?? "unknown category"}) while running ${tool.name}`,
      );
    }
    const block = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === tool.name,
    );
    if (block) return block.input;
    lastStop = response.stop_reason;
  }
  throw new Error(`Claude did not call ${tool.name} after ${attempts} attempt(s) (last stop_reason=${lastStop})`);
}
