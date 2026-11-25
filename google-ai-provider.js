// Shared Google AI provider routing for W.H.K Cloudflare Workers.
// Modes:
// - developer-api: legacy Gemini Developer API.
// - agent-platform: standard project-based Gemini Enterprise Agent Platform.
// - agent-platform-express: projectless, free-tier Agent Platform Express Mode.
export function getGoogleAiProviderMode(env) {
  return String(env?.GEMINI_PROVIDER || "developer-api").trim().toLowerCase();
}

export function isGoogleAiConfigured(env) {
  const mode = getGoogleAiProviderMode(env);
  if (mode === "agent-platform-express") {
    return Boolean(env?.APP_TOKEN && env?.AGENT_PLATFORM_API_KEY);
  }
  if (mode === "agent-platform") {
    return Boolean(env?.APP_TOKEN && env?.AGENT_PLATFORM_API_KEY && env?.GOOGLE_CLOUD_PROJECT_ID);
  }
  return Boolean(env?.APP_TOKEN && env?.GEMINI_API_KEY);
}

export function getGoogleAiProviderInfo(env) {
  const mode = getGoogleAiProviderMode(env);
  if (mode === "agent-platform-express") {
    return {
      provider: "gemini-enterprise-agent-platform-express",
      configured: isGoogleAiConfigured(env),
      location: "global",
      billing: "free-tier-when-eligible"
    };
  }
  if (mode === "agent-platform") {
    return {
      provider: "gemini-enterprise-agent-platform",
      configured: isGoogleAiConfigured(env),
      location: "global"
    };
  }
  return {
    provider: "gemini-developer-api",
    configured: isGoogleAiConfigured(env),
    location: null
  };
}

export function getGoogleAiRequest(env, requestedModel) {
  const mode = getGoogleAiProviderMode(env);
  const apiKey = String(
    mode === "developer-api" ? env?.GEMINI_API_KEY : env?.AGENT_PLATFORM_API_KEY
  || "").trim();
  if (!apiKey) {
    return {
      error: mode === "developer-api"
        ? "GEMINI_API_KEY is missing."
        : "AGENT_PLATFORM_API_KEY is missing."
    };
  }

  if (mode === "agent-platform-express") {
    // Express mode currently supports only its published model allowlist.
    // Map the application's normal Flash model tiers to supported Express models.
    const expressModelMap = {
      "gemini-3.8-flash": "gemini-3-flash-preview",
      "gemini-3.5-flash-lite": "gemini-2.5-flash-lite",
      "gemini-3.1-flash-lite": "gemini-2.5-flash-lite"
    };
    const model = expressModelMap[requestedModel] || requestedModel;
    const allowed = new Set([
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ]);
    if (!allowed.has(model)) {
      return {error: "The requested model is not available in Agent Platform Express Mode."};
    }
    return {
      provider: "gemini-enterprise-agent-platform-express",
      model,
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      }
    };
  }

  if (mode === "agent-platform") {
    const projectId = String(env?.GOOGLE_CLOUD_PROJECT_ID || "").trim();
    if (!projectId) {
      return {error: "Agent Platform is selected but GOOGLE_CLOUD_PROJECT_ID is missing."};
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
      return {error: "GOOGLE_CLOUD_PROJECT_ID is not a valid Google Cloud project ID."};
    }
    return {
      provider: "gemini-enterprise-agent-platform",
      model: requestedModel,
      url: `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${requestedModel}:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      }
    };
  }

  return {
    provider: "gemini-developer-api",
    model: requestedModel,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent`,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    }
  };
}
