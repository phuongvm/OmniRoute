/**
 * OMNIROUTE-INV-5 Part B — Clamp OpenAI reasoning_effort="minimal" to "low" for Claude models.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";

test("clamps reasoning_effort='minimal' to 'low' on adaptive-thinking Claude 5.5 models", () => {
  const out = openaiToClaudeRequest(
    "claude-opus-5-5",
    {
      model: "claude-opus-5-5",
      reasoning_effort: "minimal",
      messages: [{ role: "user", content: "Solve this step by step." }],
    },
    false
  );
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.equal((out.output_config as Record<string, unknown>)?.effort, "low");
});

test("preserves reasoning_effort='high' unchanged on adaptive-thinking Claude 5.5 models", () => {
  const out = openaiToClaudeRequest(
    "claude-opus-5-5",
    {
      model: "claude-opus-5-5",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Deep analysis." }],
    },
    false
  );
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.equal((out.output_config as Record<string, unknown>)?.effort, "high");
});

test("clamps reasoning_effort='minimal' to 'low' budget (1024 tokens) on manual-thinking Claude 4.6 models", () => {
  const out = openaiToClaudeRequest(
    "claude-opus-4-6",
    {
      model: "claude-opus-4-6",
      reasoning_effort: "minimal",
      max_tokens: 8192,
      messages: [{ role: "user", content: "Quick check." }],
    },
    false
  );
  assert.equal((out.thinking as Record<string, unknown>)?.type, "enabled");
  assert.equal((out.thinking as Record<string, unknown>)?.budget_tokens, 1024);
});
