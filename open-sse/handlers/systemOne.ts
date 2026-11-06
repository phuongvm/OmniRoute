/**
 * System One decisions proxy (#13987).
 *
 * POST /v1/systemone forwards one typed-decision request — a `state` plus a
 * map of `questions` (`noul` / `choice` / `score`) — to the backend selected by
 * resolveSystemOneTarget. Both backends share the same request/response wire
 * shape, so the proxy is a model-rewriting passthrough: answers, calibrated
 * probabilities and usage (input/output tokens, cost) flow through untouched.
 * Decisions models are NOT chat models —
 * decisions-tagged models are excluded from chat pickers by the shared
 * classification (classifyModelSupportedEndpoints).
 *
 * Follows the same credential, rate-limit and call-log contract as
 * handleJinaFoundationProxy (POST /v1/classify).
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog } from "@/lib/usageDb";
import {
  DEFAULT_LAYA_TIMEOUT_MS,
  LAYA_FAILOVER_STATUSES,
  type SystemOneCandidate,
  type SystemOneTarget,
} from "../config/systemOneRegistry.ts";

export interface SystemOneCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
}

export interface SystemOneProxyOptions {
  /** Public path the client called ("/v1/systemone"). */
  path: string;
  target: SystemOneTarget;
  body: {
    state?: unknown;
    questions?: unknown;
  } & Record<string, unknown>;
  credentials: SystemOneCredentials | null;
  /** Optional credentials for fallback rungs (e.g., opencode-zen). */
  fallbackCredentials?: SystemOneCredentials | null;
  /** Optional provider-keyed credential map for multi-rung ladders. */
  credentialsByProvider?: Record<string, SystemOneCredentials | null | undefined>;
  /** Optional per-attempt timeout in milliseconds for noAuth/local candidates. */
  timeoutMs?: number;
  /** Client-requested model id (for logs when upstream reports none). */
  requestedModel?: string | null;
  fetchImpl?: typeof fetch;
}

interface SystemOneUpstreamResponse {
  model?: string;
  answers?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
  error?: { message?: string } | string;
  message?: string;
}

function parseUpstreamBody(text: string): SystemOneUpstreamResponse | null {
  try {
    return text ? (JSON.parse(text) as SystemOneUpstreamResponse) : null;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function upstreamErrorMessage(parsed: SystemOneUpstreamResponse | null): string | undefined {
  const { message, error } = parsed ?? {};
  return message || (typeof error === "string" ? error : error?.message);
}

function buildSuccessResponse(
  parsed: SystemOneUpstreamResponse | null,
  meta: { provider: string; model: string; cost: unknown; startTime: number }
): Response {
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(headers, {
    provider: meta.provider,
    model: meta.model,
    costUsd: typeof meta.cost === "number" ? meta.cost : 0,
    latencyMs: Date.now() - meta.startTime,
    requestId: generateRequestId(),
  });
  return new Response(JSON.stringify(parsed), { status: 200, headers });
}

async function postDecision(
  options: SystemOneProxyOptions,
  candidate: SystemOneCandidate,
  token: string | null
): Promise<Response> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (!candidate.noAuth && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const timeoutMs =
    typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : candidate.noAuth
        ? Number(process.env.LAYA_SYSTEMONE_TIMEOUT_MS) || DEFAULT_LAYA_TIMEOUT_MS
        : 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      : null;
  try {
    return await fetchImpl(candidate.upstreamUrl, {
      method: "POST",
      headers,
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        model: candidate.upstreamModel,
        state: options.body.state,
        questions: options.body.questions,
      }),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logDecisionCall(
  options: SystemOneProxyOptions,
  candidate: SystemOneCandidate,
  connectionId: string | null,
  outcome: {
    status: number;
    ok: boolean;
    model: string;
    usage: SystemOneUpstreamResponse["usage"];
    error: string;
    startTime: number;
  }
): void {
  saveCallLog({
    method: "POST",
    path: options.path,
    status: outcome.status,
    model: outcome.model,
    provider: candidate.provider,
    duration: Date.now() - outcome.startTime,
    tokens: {
      prompt_tokens: outcome.usage?.input_tokens ?? 0,
      completion_tokens: outcome.usage?.output_tokens ?? 0,
    },
    connectionId,
    ...(outcome.ok ? {} : { error: outcome.error }),
  }).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[SYSTEMONE] saveCallLog warning for ${candidate.provider}: ${detail}`);
  });
}

function resolveAnsweredModel(
  parsed: SystemOneUpstreamResponse | null,
  options: SystemOneProxyOptions,
  candidate: SystemOneCandidate
): string {
  const upstreamModel = typeof parsed?.model === "string" ? parsed.model : "";
  return upstreamModel || options.requestedModel || candidate.provider;
}

function resolveCandidateToken(
  candidate: SystemOneCandidate,
  index: number,
  options: SystemOneProxyOptions
): { token: string | null; connectionId: string | null } {
  if (candidate.noAuth) {
    return { token: null, connectionId: null };
  }
  const byProvider = options.credentialsByProvider?.[candidate.provider];
  const creds =
    byProvider !== undefined
      ? byProvider
      : index === 0
        ? options.credentials
        : (options.fallbackCredentials ?? null);
  const token = creds?.apiKey || creds?.accessToken || candidate.defaultToken || null;
  return { token, connectionId: creds?.connectionId || null };
}

function shouldFailoverOnStatus(candidate: SystemOneCandidate, status: number, hasNext: boolean): boolean {
  if (!hasNext) return false;
  const statuses = candidate.failoverStatuses ?? (candidate.noAuth ? LAYA_FAILOVER_STATUSES : []);
  return statuses.includes(status);
}

export async function handleSystemOneProxy(options: SystemOneProxyOptions): Promise<Response> {
  const candidates: SystemOneCandidate[] =
    Array.isArray(options.target.candidates) && options.target.candidates.length > 0
      ? options.target.candidates
      : [options.target];

  const primary = candidates[0];
  const primaryAuth = resolveCandidateToken(primary, 0, options);
  if (!primary.noAuth && !primaryAuth.token) {
    return errorResponse(401, `No active credentials for provider: ${primary.provider}`);
  }

  let lastFailureResponse: Response | null = null;
  let lastErrorMessage = "";

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const hasNext = i < candidates.length - 1;
    const startTime = Date.now();
    const { token, connectionId } = resolveCandidateToken(candidate, i, options);

    if (!candidate.noAuth && !token) {
      lastFailureResponse = errorResponse(
        401,
        `No active credentials for provider: ${candidate.provider}`
      );
      continue;
    }

    try {
      const res = await postDecision(options, candidate, token);
      const text = await res.text();
      const parsed = parseUpstreamBody(text);
      const usage = res.ok ? parsed?.usage : undefined;
      const answeredModel = resolveAnsweredModel(parsed, options, candidate);
      const upstreamError = upstreamErrorMessage(parsed);

      logDecisionCall(options, candidate, connectionId, {
        status: res.status,
        ok: res.ok,
        model: answeredModel,
        usage,
        error: upstreamError || text.slice(0, 500),
        startTime,
      });

      if (!res.ok) {
        if (shouldFailoverOnStatus(candidate, res.status, hasNext)) {
          lastErrorMessage = upstreamError || `Provider ${candidate.provider} returned HTTP ${res.status}`;
          continue;
        }
        return errorResponse(res.status, upstreamError || `Provider returned HTTP ${res.status}`);
      }

      return buildSuccessResponse(parsed, {
        provider: candidate.provider,
        model: answeredModel,
        cost: usage?.cost,
        startTime,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErrorMessage = message;
      logDecisionCall(options, candidate, connectionId, {
        status: 502,
        ok: false,
        model: options.requestedModel || candidate.upstreamModel,
        usage: undefined,
        error: message,
        startTime,
      });
      if (hasNext) {
        continue;
      }
      return errorResponse(500, `System One request failed: ${message}`);
    }
  }

  if (lastFailureResponse) {
    return lastFailureResponse;
  }
  return errorResponse(500, `System One request failed: ${lastErrorMessage || "All candidates failed"}`);
}
