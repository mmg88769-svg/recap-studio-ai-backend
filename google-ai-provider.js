// Shared Google AI provider routing for W.H.K Cloudflare Workers.
// Default remains Gemini Developer API until Agent Platform credentials are configured.
// Set GEMINI_PROVIDER=agent-platform, GOOGLE_CLOUD_PROJECT_ID and AGENT_PLATFORM_API_KEY
// to use the officially supported Gemini Enterprise Agent Platform global endpoint.
export function getGoogleAiProviderMode(env) {
  return String(env?.GEMINI_PROVIDER || "developer-api").trim().toLowerCase();
}

export function isGoogleAiConfigured(env) {
  if (getGoogleAiProviderMode(env) === "agent-platform") {
    return Boolean(env?.APP_TOKEN && env?.AGENT_PLATFORM_API_KEY && env?.GOOGLE_CLOUD_PROJECT_ID);
  }
  return Boolean(env?.APP_TOKEN && env?.GEMINI_API_KEY);
}

export function getGoogleAiProviderInfo(env) {
  const mode = getGoogleAiProviderMode(env);
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

export function getGoogleAiRequest(env, model) {
  const mode = getGoogleAiProviderMode(env);
  if (mode === "agent-platform") {
    const projectId = String(env?.GOOGLE_CLOUD_PROJECT_ID || "").trim();
    const apiKey = String(env?.AGENT_PLATFORM_API_KEY || "").trim();
    if (!projectId || !apiKey) {
      return {
        error: "Agent Platform is selected but GOOGLE_CLOUD_PROJECT_ID or AGENT_PLATFORM_API_KEY is missing."
      };
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
      return {error: "GOOGLE_CLOUD_PROJECT_ID is not a valid Google Cloud project ID."};
    }
    return {
      provider: "gemini-enterprise-agent-platform",
      url: `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      }
    };
  }

  const apiKey = String(env?.GEMINI_API_KEY || "").trim();
  if (!apiKey) return {error: "GEMINI_API_KEY is missing."};
  return {
    provider: "gemini-developer-api",
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    }
  };
}
