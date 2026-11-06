/**
 * OMNIROUTE-INV-6 Part B — Ordered failover ladder from local Laya to opencode-zen/jev-1.13-free.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LAYA_SYSTEMONE_URL,
  DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL,
  resolveSystemOneTarget,
} from "../../open-sse/config/systemOneRegistry.ts";
import { handleSystemOneProxy } from "../../open-sse/handlers/systemOne.ts";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("1. primary laya returns 200 -> succeeds without calling fallback", async () => {
  const calls: string[] = [];
  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target: resolveSystemOneTarget("laya/laya-auto")!,
    body: { state: "ok", questions: { q: {} } },
    credentials: null,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(200, {
        model: "laya-auto",
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [DEFAULT_LAYA_SYSTEMONE_URL]);
  assert.equal(response.headers.get("x-omniroute-provider"), "laya");
});

test("2. primary laya returns 502/503/504 -> fails over to opencode-zen/jev-1.13-free with public Bearer token", async () => {
  for (const status of [502, 503, 504]) {
    const calls: Array<{ url: string; auth?: string; model?: string }> = [];
    const response = await handleSystemOneProxy({
      path: "/v1/systemone",
      target: resolveSystemOneTarget("laya/typed-decisions")!,
      body: { state: "failover", questions: { q: {} } },
      credentials: null,
      fetchImpl: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const parsedBody = JSON.parse(String(init?.body ?? "{}"));
        calls.push({
          url: String(url),
          auth: headers.Authorization,
          model: parsedBody.model,
        });
        if (String(url) === DEFAULT_LAYA_SYSTEMONE_URL) {
          return jsonResponse(status, { error: { message: `Laya upstream ${status}` } });
        }
        return jsonResponse(200, {
          model: "jev-1.13-free",
          answers: { q: { type: "choice", choice: "fallback" } },
          usage: { input_tokens: 12, output_tokens: 2 },
        });
      },
    });

    assert.equal(response.status, 200, `expected 200 on failover from HTTP ${status}`);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, DEFAULT_LAYA_SYSTEMONE_URL);
    assert.equal(calls[0].auth, undefined);
    assert.equal(calls[0].model, "typed-decisions");
    assert.equal(calls[1].url, DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL);
    assert.equal(calls[1].auth, "Bearer public");
    assert.equal(calls[1].model, "jev-1.13-free");
    assert.equal(response.headers.get("x-omniroute-provider"), "opencode-zen");
  }
});

test("3. primary laya throws network error/timeout -> fails over to opencode-zen/jev-1.13-free", async () => {
  const calls: string[] = [];
  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target: resolveSystemOneTarget("laya/english")!,
    body: { state: "timeout", questions: { q: {} } },
    credentials: null,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url) === DEFAULT_LAYA_SYSTEMONE_URL) {
        throw new Error("connect ECONNREFUSED 192.168.100.130:8000");
      }
      return jsonResponse(200, {
        model: "jev-1.13-free",
        answers: { q: { type: "noul", noul: 1 } },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [DEFAULT_LAYA_SYSTEMONE_URL, DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL]);
});

test("4. both primary laya and fallback fail -> returns 500 or upstream fallback error", async () => {
  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target: resolveSystemOneTarget("laya/multilingual")!,
    body: { state: "both-down", questions: { q: {} } },
    credentials: null,
    fetchImpl: async () => {
      throw new Error("network unreachable");
    },
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /network unreachable/);
});

test("5. primary laya 400 client error does NOT fail over", async () => {
  const calls: string[] = [];
  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target: resolveSystemOneTarget("laya/laya-auto")!,
    body: { state: "bad-question", questions: { q: {} } },
    credentials: null,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse(400, { error: { message: "Invalid question schema" } });
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(calls, [DEFAULT_LAYA_SYSTEMONE_URL]);
});

test("6. hanging primary laya upstream is aborted after timeoutMs and fails over to opencode-zen/jev-1.13-free", async () => {
  const calls: string[] = [];
  let primaryAborted = false;
  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target: resolveSystemOneTarget("laya/laya-auto")!,
    body: { state: "hanging-primary", questions: { q: {} } },
    credentials: null,
    timeoutMs: 30,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url) === DEFAULT_LAYA_SYSTEMONE_URL) {
        return await new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig?.aborted) {
            primaryAborted = true;
            reject(sig.reason ?? new Error("Aborted"));
            return;
          }
          sig?.addEventListener(
            "abort",
            () => {
              primaryAborted = true;
              reject(sig.reason ?? new Error("Aborted"));
            },
            { once: true }
          );
        });
      }
      return jsonResponse(200, {
        model: "jev-1.13-free",
        answers: { q: { type: "choice", choice: "timeout-fallback" } },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(primaryAborted, true);
  assert.deepEqual(calls, [DEFAULT_LAYA_SYSTEMONE_URL, DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL]);
  assert.equal(response.headers.get("x-omniroute-provider"), "opencode-zen");
});
