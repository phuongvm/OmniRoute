/**
 * OMNIROUTE-INV-5 Part A — Hermes/Nous Antigravity identity prompt sanitizer.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAntigravitySystemInstruction,
  stripCompetitiveAgentPrompts,
} from "../../open-sse/executors/antigravity.ts";

test("strips exact Hermes Agent identity sentence while preserving following instructions", () => {
  const input = {
    parts: [
      {
        text:
          "You are Hermes Agent, an intelligent AI assistant created by Nous Research.\n" +
          "Follow all repository guardrails strictly.",
      },
    ],
  };
  const out = normalizeAntigravitySystemInstruction(input) as {
    parts: Array<{ text: string }>;
  };
  assert.equal(out.parts[0].text, "Follow all repository guardrails strictly.");
});

test("strips lowercase 'you are hermes agent' identity line case-insensitively", () => {
  const input = {
    parts: [{ text: "you are hermes agent operating in terminal mode" }],
  };
  const out = stripCompetitiveAgentPrompts(input) as {
    parts: Array<{ text: string }>;
  };
  assert.equal(out.parts[0].text, "");
});

test("preserves same-line non-identity instructions following the Hermes identity sentence", () => {
  const input = {
    parts: [
      {
        text: "You are Hermes Agent, an intelligent AI assistant created by Nous Research. Answer in Vietnamese.",
      },
    ],
  };
  const out = normalizeAntigravitySystemInstruction(input) as {
    parts: Array<{ text: string }>;
  };
  assert.equal(out.parts[0].text, "Answer in Vietnamese.");
});

test("leaves benign system instructions untouched (returns identical object reference)", () => {
  const input = {
    parts: [{ text: "You are a helpful assistant. Provide concise answers." }],
  };
  const out = normalizeAntigravitySystemInstruction(input);
  assert.strictEqual(out, input);
});
