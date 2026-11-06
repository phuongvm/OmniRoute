/**
 * System One decisions registry (#13987) — pure backend resolution.
 *
 * Maps a client model id to the backend that serves it. No I/O; the route and
 * the proxy handler both live on top of this, mirroring rerankRegistry.
 *
 *   typesafe/jev-1.13            → native api.typesafe.ai   (model jev-1.13)
 *   jev-latest / (no model)      → native api.typesafe.ai   (default alias)
 *   openrouter/typesafe/jev-1.13 → openrouter alpha decisions (model typesafe/jev-1.13)
 *   openrouter/inception/…:free  → openrouter alpha decisions (model verbatim)
 *
 * Anything else is not a decisions model → null (the route 400s with guidance).
 */

export const TYPESAFE_SYSTEMONE_PROVIDER_ID = "typesafe";
export const TYPESAFE_SYSTEMONE_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEMONE_URL = `${TYPESAFE_SYSTEMONE_BASE_URL}/v1/systemone`;
/** TypeSafe answers a bare or missing model with its latest Jev alias. */
export const TYPESAFE_SYSTEMONE_DEFAULT_MODEL = "jev-latest";

export const OPENROUTER_DECISIONS_PROVIDER_ID = "openrouter";
export const OPENROUTER_DECISIONS_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_DECISIONS_URL = `${OPENROUTER_DECISIONS_BASE_URL}/api/alpha/decisions`;

export const LAYA_SYSTEMONE_PROVIDER_ID = "laya";
export const DEFAULT_LAYA_SYSTEMONE_URL = "http://192.168.100.130:8000/v1/systemone";
export const LAYA_SYSTEMONE_MODELS = [
  "laya-auto",
  "english",
  "multilingual",
  "typed-decisions",
] as const;
export type LayaSystemOneModel = (typeof LAYA_SYSTEMONE_MODELS)[number];
const LAYA_ALLOWED_MODEL_SET: ReadonlySet<string> = new Set<string>(LAYA_SYSTEMONE_MODELS);

export const OPENCODE_ZEN_SYSTEMONE_PROVIDER_ID = "opencode-zen";
export const DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone";
export const DEFAULT_LAYA_FALLBACK_MODEL = "jev-1.13-free";
export const DEFAULT_LAYA_TIMEOUT_MS = 5000;
export const LAYA_FAILOVER_STATUSES = [502, 503, 504] as const;

export type SystemOneBackend = "typesafe" | "openrouter" | "laya" | "opencode-zen";

export interface SystemOneCandidate {
  backend: SystemOneBackend;
  provider: string;
  upstreamModel: string;
  upstreamUrl: string;
  /** When true, no stored DB credential is required and no Authorization header is sent. */
  noAuth?: boolean;
  /** Optional public/free-lane token used when no stored credential is supplied. */
  defaultToken?: string;
  /** HTTP status codes from this candidate that trigger failover to the next candidate. */
  failoverStatuses?: readonly number[];
}

export interface SystemOneTarget extends SystemOneCandidate {
  /** Ordered failover ladder (index 0 is primary, index 1+ are fallback rungs). */
  candidates?: SystemOneCandidate[];
}

export function getLayaSystemOneUrl(): string {
  const configured = process.env.LAYA_SYSTEMONE_URL?.trim();
  return configured || DEFAULT_LAYA_SYSTEMONE_URL;
}

export function getLayaFallbackCandidate(): SystemOneCandidate {
  const rawFallback = process.env.LAYA_FALLBACK_MODEL?.trim() || "opencode-zen/jev-1.13-free";
  const slashIdx = rawFallback.indexOf("/");
  let upstreamModel = DEFAULT_LAYA_FALLBACK_MODEL;
  if (slashIdx > 0) {
    const prefix = rawFallback.slice(0, slashIdx).trim();
    const suffix = rawFallback.slice(slashIdx + 1).trim();
    if (prefix === OPENCODE_ZEN_SYSTEMONE_PROVIDER_ID && /^[A-Za-z0-9._:-]+$/.test(suffix)) {
      upstreamModel = suffix;
    }
  } else if (/^[A-Za-z0-9._:-]+$/.test(rawFallback)) {
    upstreamModel = rawFallback;
  }
  const upstreamUrl =
    process.env.OPENCODE_ZEN_SYSTEMONE_URL?.trim() || DEFAULT_OPENCODE_ZEN_SYSTEMONE_URL;
  return {
    backend: "opencode-zen",
    provider: OPENCODE_ZEN_SYSTEMONE_PROVIDER_ID,
    upstreamModel,
    upstreamUrl,
    defaultToken: "public",
  };
}

/**
 * Resolve the request model to a backend. Pure — unit-tested directly.
 *
 * `openrouter/…` explicitly picks the OpenRouter alpha decisions endpoint and
 * may name any decisions-capable vendor id (`typesafe/jev-1.13`,
 * `inception/mercury-decide:free`, …). `typesafe/…` and bare `jev-*` aliases
 * route natively; `laya/…` routes only the four approved models in
 * `LAYA_SYSTEMONE_MODELS` to the local Laya SystemOne server (`noAuth: true`)
 * with an ordered failover ladder to `opencode-zen/jev-1.13-free`.
 */
export function resolveSystemOneTarget(model: string | undefined): SystemOneTarget | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed || trimmed === TYPESAFE_SYSTEMONE_DEFAULT_MODEL) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed || TYPESAFE_SYSTEMONE_DEFAULT_MODEL,
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  if (trimmed.startsWith("laya/")) {
    const layaModel = trimmed.slice("laya/".length).trim();
    if (!LAYA_ALLOWED_MODEL_SET.has(layaModel)) {
      return null;
    }
    const primary: SystemOneCandidate = {
      backend: "laya",
      provider: LAYA_SYSTEMONE_PROVIDER_ID,
      upstreamModel: layaModel,
      upstreamUrl: getLayaSystemOneUrl(),
      noAuth: true,
      failoverStatuses: LAYA_FAILOVER_STATUSES,
    };
    const fallback = getLayaFallbackCandidate();
    return {
      ...primary,
      candidates: [primary, fallback],
    };
  }
  if (trimmed.startsWith("typesafe/")) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed.slice("typesafe/".length),
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  if (trimmed.startsWith("openrouter/")) {
    return {
      backend: "openrouter",
      provider: OPENROUTER_DECISIONS_PROVIDER_ID,
      upstreamModel: trimmed.slice("openrouter/".length),
      upstreamUrl: OPENROUTER_DECISIONS_URL,
    };
  }
  if (/^jev[-/]/i.test(trimmed)) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed,
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  return null;
}
