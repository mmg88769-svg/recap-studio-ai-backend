const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_REQUEST_CHARS = 500000;

function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonOutput({
    status: "online",
    service: "gemini-apps-script-proxy",
    version: "1.0.0"
  });
}

function doPost(e) {
  const raw = e && e.postData && e.postData.contents
    ? e.postData.contents
    : "";

  if (!raw || raw.length > MAX_REQUEST_CHARS) {
    return jsonOutput({ error: { code: 400, message: "Invalid or oversized request." } });
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch (_error) {
    return jsonOutput({ error: { code: 400, message: "Request body must be valid JSON." } });
  }

  const properties = PropertiesService.getScriptProperties();
  const expectedToken = String(properties.getProperty("GEMINI_PROXY_TOKEN") || "");
  const suppliedToken = String(request.proxyToken || "");

  if (!expectedToken || !constantTimeEquals(expectedToken, suppliedToken)) {
    return jsonOutput({ error: { code: 401, message: "Unauthorized proxy request." } });
  }

  const apiKey = String(properties.getProperty("GEMINI_API_KEY") || request.apiKey || "").trim();
  const model = String(request.model || "").trim();
  const payload = request.payload;

  if (!apiKey) {
    return jsonOutput({ error: { code: 503, message: "GEMINI_API_KEY is not configured in Script Properties." } });
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    return jsonOutput({ error: { code: 400, message: "Invalid Gemini model name." } });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.contents)) {
    return jsonOutput({ error: { code: 400, message: "Invalid Gemini generateContent payload." } });
  }

  const url = GEMINI_API_ROOT + encodeURIComponent(model) + ":generateContent";
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (_error) {
    return jsonOutput({ error: { code: 502, message: "Could not reach the Gemini API." } });
  }

  const responseText = response.getContentText();
  try {
    JSON.parse(responseText);
  } catch (_error) {
    return jsonOutput({ error: { code: 502, message: "Gemini returned a non-JSON response." } });
  }

  return ContentService
    .createTextOutput(responseText)
    .setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEquals(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
