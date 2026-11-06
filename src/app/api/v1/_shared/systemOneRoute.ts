/**
 * POST/GET handler for /v1/systemone (#13987). Credential selection, rate-limit
 * handling and usage logging mirror /v1/classify (Jina passthrough).
 */

import {
  handleSystemOneProxy,
  type SystemOneCredentials,
} from "@omniroute/open-sse/handlers/systemOne.ts";
import { resolveSystemOneTarget } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isKeyScopeBlockedCredentials,
  keylessProviderRejection,
  keyScopeBlockedResponse,
  resolveKeyConnectionScope,
  withoutKeyScopeBlocked,
} from "@/sse/services/keyConnectionScope";
import { v1SystemOneSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";

function optionsResponse() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** Decisions models advertised by the unified catalog (type "decisions"). */
export function systemOneModelsGet(pathname: string) {
  return (request?: Request) =>
    getSpecialtyModelsResponse(request, pathname, (model) => {
      if (model.type === "decisions") return true;
      const endpoints = model.supported_endpoints;
      return Array.isArray(endpoints) && endpoints.includes("decisions");
    });
}

export type CredentialLookupFn = typeof getProviderCredentialsWithQuotaPreflight;

export async function resolveSystemOneRouteAuth(
  target: NonNullable<ReturnType<typeof resolveSystemOneTarget>>,
  allowedConnections: string[] | null,
  lookupCredentials: CredentialLookupFn = getProviderCredentialsWithQuotaPreflight
): Promise<{
  credentials: SystemOneCredentials | null;
  fallbackCredentials: SystemOneCredentials | null;
  rawCredentials: Awaited<ReturnType<CredentialLookupFn>>;
  rejection: Response | null;
}> {
  if (target.noAuth) {
    // GHSA-3w2r / #9057: a connection-scoped key reaches a keyless local provider
    // only when its allowlist explicitly includes `noauth` or an in-scope connection
    // serves the provider.
    const keylessRejection = await keylessProviderRejection(
      target.provider,
      allowedConnections,
      () => lookupCredentials(target.provider, null, allowedConnections)
    );
    if (keylessRejection) {
      return {
        credentials: null,
        fallbackCredentials: null,
        rawCredentials: null,
        rejection: keylessRejection,
      };
    }

    let fallbackCredentials: SystemOneCredentials | null = null;
    const fallbackCandidate = target.candidates?.find((c) => !c.noAuth);
    if (fallbackCandidate) {
      try {
        const rawFallback = await lookupCredentials(
          fallbackCandidate.provider,
          null,
          allowedConnections
        );
        const usableFallback = withoutKeyScopeBlocked(rawFallback);
        if (usableFallback && !isAllRateLimitedCredentials(usableFallback)) {
          fallbackCredentials = usableFallback as SystemOneCredentials;
        }
      } catch {
        fallbackCredentials = null;
      }
    }

    return {
      credentials: null,
      fallbackCredentials,
      rawCredentials: null,
      rejection: null,
    };
  }

  const rawCredentials = await lookupCredentials(target.provider, null, allowedConnections);
  if (!rawCredentials) {
    return {
      credentials: null,
      fallbackCredentials: null,
      rawCredentials: null,
      rejection: errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No active credentials for provider: ${target.provider}`
      ),
    };
  }
  if (isKeyScopeBlockedCredentials(rawCredentials)) {
    return {
      credentials: null,
      fallbackCredentials: null,
      rawCredentials: null,
      rejection: keyScopeBlockedResponse(target.provider, rawCredentials),
    };
  }
  if (isAllRateLimitedCredentials(rawCredentials)) {
    return {
      credentials: null,
      fallbackCredentials: null,
      rawCredentials: null,
      rejection: rateLimitedProviderResponse(target.provider, rawCredentials),
    };
  }

  return {
    credentials: rawCredentials as SystemOneCredentials,
    fallbackCredentials: null,
    rawCredentials,
    rejection: null,
  };
}

async function postHandler(request: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1SystemOneSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;
  const model = typeof body.model === "string" ? body.model.trim() : undefined;

  const target = resolveSystemOneTarget(model);
  if (!target) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown decisions model: ${model ?? "(missing)"}. Use "typesafe/<model>", ` +
        `"laya/<model>", a bare jev-* alias, or "openrouter/<vendor>/<model>" for OpenRouter-hosted decisions models.`
    );
  }

  const policy = await enforceApiKeyPolicy(request, model ?? target.upstreamModel);
  if (policy.rejection) return policy.rejection;

  // GHSA-3w2r: credential selection stays inside the key's connection scope,
  // the same scope /v1/classify and chat apply.
  const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
  if (scope.rejection) return scope.rejection;

  const auth = await resolveSystemOneRouteAuth(target, scope.allowedConnections);
  if (auth.rejection) return auth.rejection;

  const response = await handleSystemOneProxy({
    path: new URL(request.url).pathname,
    target,
    body,
    // For noAuth targets (local Laya), credentials is null and no Authorization header is sent.
    credentials: auth.credentials,
    fallbackCredentials: auth.fallbackCredentials,
    requestedModel: model ?? null,
  });
  if (response.ok && auth.rawCredentials && !target.noAuth) {
    await clearRecoveredProviderState(auth.rawCredentials);
  }
  return response;
}

export function createSystemOneRouteHandlers(pathname: string) {
  return {
    OPTIONS: optionsResponse,
    GET: systemOneModelsGet(pathname),
    POST: withInjectionGuard(postHandler),
  };
}
