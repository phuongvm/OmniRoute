/**
 * OMNIROUTE-INV-6 Part A — Local Laya SystemOne registry and noAuth credential bypass.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LAYA_SYSTEMONE_URL,
  LAYA_SYSTEMONE_MODELS,
  resolveSystemOneTarget,
} from "../../open-sse/config/systemOneRegistry.ts";
import { handleSystemOneProxy } from "../../open-sse/handlers/systemOne.ts";
import { resolveSystemOneRouteAuth } from "../../src/app/api/v1/_shared/systemOneRoute.ts";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("resolves all four normative laya/* models with noAuth=true and ordered failover candidates", () => {
  for (const modelSuffix of LAYA_SYSTEMONE_MODELS) {
    const target = resolveSystemOneTarget(`laya/${modelSuffix}`);
    assert.ok(target, `expected target for laya/${modelSuffix}`);
    assert.equal(target.backend, "laya");
    assert.equal(target.provider, "laya");
    assert.equal(target.upstreamModel, modelSuffix);
    assert.equal(target.upstreamUrl, DEFAULT_LAYA_SYSTEMONE_URL);
    assert.equal(target.noAuth, true);
    assert.equal(target.candidates?.length, 2);
    assert.equal(target.candidates?.[0].provider, "laya");
    assert.equal(target.candidates?.[1].provider, "opencode-zen");
    assert.equal(target.candidates?.[1].upstreamModel, "jev-1.13-free");
  }
});

test("dispatches laya/laya-auto without credentials and omits Authorization header", async () => {
  let capturedHeaders: Record<string, string> | null = null;
  let capturedUrl = "";
  const target = resolveSystemOneTarget("laya/laya-auto")!;

  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target,
    body: {
      model: "laya/laya-auto",
      state: "agent state",
      questions: { route: { type: "choice", options: ["a", "b"] } },
    },
    credentials: null,
    requestedModel: "laya/laya-auto",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(200, {
        model: "laya-auto",
        answers: { route: { type: "choice", choice: "a", confidence: 0.99 } },
        usage: { input_tokens: 18, output_tokens: 2, cost: 0 },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(capturedUrl, DEFAULT_LAYA_SYSTEMONE_URL);
  assert.ok(capturedHeaders);
  assert.equal("Authorization" in capturedHeaders!, false);
});

test("non-laya targets still fail closed with 401 when credentials are null", async () => {
  let called = false;
  const target = resolveSystemOneTarget("typesafe/jev-latest")!;

  const response = await handleSystemOneProxy({
    path: "/v1/systemone",
    target,
    body: { state: "s", questions: { q: {} } },
    credentials: null,
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("rejects unregistered laya/* model suffixes and bare laya/ prefix with null", () => {
  assert.equal(resolveSystemOneTarget("laya/unregistered-model"), null);
  assert.equal(resolveSystemOneTarget("laya/"), null);
  assert.equal(resolveSystemOneTarget("laya/   "), null);
});

test("enforces connection-scope admission for noAuth Laya targets at the route boundary", async () => {
  const target = resolveSystemOneTarget("laya/laya-auto")!;

  // 1. Unscoped key (allowedConnections = null) -> admitted without DB credential
  const unscoped = await resolveSystemOneRouteAuth(target, null, async () => null);
  assert.equal(unscoped.rejection, null);
  assert.equal(unscoped.credentials, null);

  // 2. Scoped key explicitly granting synthetic 'noauth' -> admitted
  const noauthScoped = await resolveSystemOneRouteAuth(target, ["noauth"], async () => null);
  assert.equal(noauthScoped.rejection, null);
  assert.equal(noauthScoped.credentials, null);

  // 3. Scoped key without 'noauth' and no in-scope laya connection -> rejected (404)
  const denied = await resolveSystemOneRouteAuth(target, ["conn-only-1"], async () => null);
  assert.ok(denied.rejection);
  assert.equal(denied.rejection?.status, 404);

  // 4. Scoped key where laya connections exist but are blocked by key policy -> rejected (403)
  const blocked = await resolveSystemOneRouteAuth(
    target,
    ["conn-only-1"],
    async () => ({ blockedByKeyPolicy: true, blockedCount: 1 }) as never
  );
  assert.ok(blocked.rejection);
  assert.equal(blocked.rejection?.status, 403);
});
