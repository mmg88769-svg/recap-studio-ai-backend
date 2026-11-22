
// Recap Studio AI v0.6
// Keep API keys only in Cloudflare Secrets.
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }
});

const scriptPaths = new Set([
  "/", "/generate", "/api/generate",
  "/generate-recap", "/api/recap"
]);

const languageNames = {
  my: "Burmese (Myanmar)",
  en: "English",
  zh: "Mandarin Chinese (Simplified)"
};

const ageNames = {
  young: "young adult",
  adult: "adult",
  mature: "mature"
};

const styles = {
  cinematic: "cinematic movie recap narration with expressive, controlled dramatic pacing",
  natural: "natural, friendly, conversational storytelling",
  dramatic: "dramatic, suspenseful movie narration, avoiding exaggerated acting"
};

const textModel = "gemini-3-flash-preview";
const voiceModel = "gemini-3.8-flash-tts";

async function gemini(env, model, payload) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await r.json();

  if (!r.ok) {
    return {
      error: data?.error?.message?.slice(0, 250) || "AI provider error",
      status: r.status
    };
  }

  return {data};
}

const outputText = (data) =>
  (data?.candidates?.[0]?.content?.parts || [])
    .map(x => x.text || "")
    .join("")
    .trim();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return json({
        status: "online",
        service: "Recap Studio AI Backend",
        version: "0.6"
      });
    }

    const analyzeLongVideo = url.pathname === "/api/analyze-long-video";
    const uploadSession = url.pathname === "/api/upload-session";
    const videoStatus = url.pathname === "/api/video-status";
    const tts = url.pathname === "/api/tts";
    const translate = url.pathname === "/api/translate";

    if (
      request.method !== "POST" ||
      (!tts && !translate && !analyzeLongVideo && !uploadSession && !videoStatus && !scriptPaths.has(url.pathname))
    ) {
      return json({error: "Not found"}, 404);
    }

    if (!env.GEMINI_API_KEY || !env.APP_TOKEN) {
      return json({error: "Server not configured"}, 503);
    }

    if (
      request.headers.get("Authorization") !==
      `Bearer ${env.APP_TOKEN}`
    ) {
      return json({error: "Unauthorized"}, 401);
    }

    let input;

    try {
      const body = await request.text();

      if (body.length > 80000) {
        return json({error: "Request too large"}, 413);
      }

      input = JSON.parse(body);
    } catch {
      return json({error: "Invalid JSON"}, 400);
    }




    // Start Gemini resumable file upload. Never return the Gemini API key to Android.
    // The temporary upload URL is a capability token; do not log or share it.
    if (uploadSession) {
      const size = Number(input?.size_bytes);
      const mime = input?.mime_type;
      if (!Number.isSafeInteger(size) || size < 1 || size > 500000000 ||
          !["video/mp4", "video/quicktime"].includes(mime)) {
        return json({error: "Beta supports MP4/MOV videos up to 500 MB"}, 400);
      }
      try {
        const start = await fetch(
          "https://generativelanguage.googleapis.com/upload/v1beta/files", {
          method: "POST",
          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(size),
            "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({file: {display_name: "whk-recap-video"}})
        });
        if (!start.ok) return json({
          error: "Upload session creation failed", status: start.status
        }, 502);
        const uploadUrl = start.headers.get("x-goog-upload-url");
        if (!uploadUrl ||
            !uploadUrl.startsWith("https://generativelanguage.googleapis.com/")) {
          return json({error: "Gemini did not return an upload session"}, 502);
        }
        return json({
          upload_url: uploadUrl,
          size_bytes: size,
          mime_type: mime,
          upload_headers: {
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
            "Content-Type": mime
          },
          note: "Upload video bytes directly to upload_url. Keep the URL private. The response contains file.name and file.uri."
        });
      } catch {
        return json({error: "Upload session request failed"}, 502);
      }
    }

    // Poll a previously uploaded Gemini file until ACTIVE, or return FAILED.
    if (videoStatus) {
      const name = input?.file_name;
      if (typeof name !== "string" ||
          !/^files\/[A-Za-z0-9_-]+$/.test(name)) {
        return json({error: "Invalid Gemini file name"}, 400);
      }
      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/" + name, {
          headers: {"x-goog-api-key": env.GEMINI_API_KEY}
        });
        if (!response.ok) return json({
          error: "File status unavailable", status: response.status
        }, 502);
        const data = await response.json();
        return json({
          state: data.state || "UNKNOWN",
          file_uri: data.state === "ACTIVE" ? data.uri : null,
          mime_type: data.mimeType || null,
          size_bytes: data.sizeBytes || null,
          error: data.error?.message || null
        });
      } catch {
        return json({error: "File status check failed"}, 502);
      }
    }

    // Stage 2: native video + audio understanding.
    // Requires a VIDEO file previously uploaded via Gemini Files API and ACTIVE.
    // Do not send video bytes/base64 to this JSON route.
    if (analyzeLongVideo) {
      const fileUri = typeof input?.file_uri === "string" ? input.file_uri : "";
      const mimeType = input?.mime_type === "video/quicktime"
        ? "video/quicktime" : "video/mp4";
      const language = languageNames[input?.language] ? input.language : "my";
      const match = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/.test(fileUri);
      if (!match) {
        return json({error: "Expected an ACTIVE Gemini Files API video file_uri"}, 400);
      }
      const prompt =
        "Analyze the supplied video with its AUDIO and VISUAL streams. " +
        "Follow the complete chronology. Make a timestamped list of key scenes " +
        "and spoken facts, then write a movie recap script in " + languageNames[language] + ". " +
        "Do not invent off-screen events, speakers or dialogue. State uncertainty " +
        "for unobserved story details. Return clearly labeled sections: " +
        "SCENE TIMELINE and RECAP SCRIPT. When the input exceeds the model's " +
        "context or video duration limit, return an explicit limitation rather than " +
        "pretending to cover the entire film.";
      try {
        const result = await gemini(env, textModel, {
          contents: [{role: "user", parts: [
            {fileData: {mimeType, fileUri}},
            {text: prompt}
          ]}],
          generationConfig: {temperature: 0.2, maxOutputTokens: 8192}
        });
        if (result.error) return json({
          error: "Long video analysis failed",
          detail: result.error,
          status: result.status
        }, 502);
        const script = outputText(result.data);
        return script ? json({
          script,
          language,
          source: "gemini_video_audio",
          limitation: "Accuracy and full-movie coverage depend on file, model and context limits"
        }) : json({error: "No video analysis generated"}, 502);
      } catch {
        return json({error: "Long video request failed"}, 502);
      }
    }

    if (translate) {
      const text =
        typeof input?.text === "string" ? input.text.trim() : "";

      const language = input?.language;

      if (!languageNames[language]) {
        return json({error: "Unsupported language"}, 400);
      }

      if (text.length < 2 || text.length > 14000) {
        return json({error: "Text must be 2 to 14000 characters"}, 400);
      }

      const prompt =
        `Translate the following movie recap accurately into ${languageNames[language]}. ` +
        "Preserve all plot events, character names, chronology and meaning. " +
        "Do not invent scenes. Return ONLY the translated narration, no commentary.\n\n" +
        text;

      try {
        const result = await gemini(env, textModel, {
          contents: [{parts: [{text: prompt}]}],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192
          }
        });

        if (result.error) {
          return json({
            error: "Translation failed",
            status: result.status,
            detail: result.error
          }, 502);
        }

        const translation = outputText(result.data);

        return translation
          ? json({translation, language})
          : json({error: "No translation generated"}, 502);

      } catch {
        return json({error: "Translation request failed"}, 502);
      }
    }

    if (tts) {
      const text =
        typeof input?.text === "string" ? input.text.trim() : "";

      const language = languageNames[input?.language]
        ? input.language : "my";

      const gender = input?.gender === "female"
        ? "female" : "male";

      const age = ageNames[input?.age]
        ? input.age : "adult";

      const style = styles[input?.style]
        ? input.style : "cinematic";

      if (text.length < 2 || text.length > 1400) {
        return json({
          error: "Voice text must be 2 to 1400 characters"
        }, 400);
      }

      const voice = gender === "male"
        ? (age === "mature" ? "Fenrir" : "Charon")
        : (age === "young" ? "Aoede" : "Kore");

      const direction =
        `Read the exact text fluently in ${languageNames[language]} ` +
        `using a ${ageNames[age]}-sounding ${gender} narrator persona. ` +
        `Use ${styles[style]}. Speak clearly with natural pauses. ` +
        "Do not translate, add words, or add sound effects.";

      try {
        const result = await gemini(env, voiceModel, {
          contents: [{
            role: "user",
            parts: [{
              text,
              speechMetadata: {
                style: direction
              }
            }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {voice}
            }
          }
        });

        if (result.error) {
          return json({
            error: "Gemini TTS failed",
            status: result.status,
            detail: result.error
          }, 502);
        }

        const inline = result.data?.candidates?.[0]?.content?.parts
          ?.find(p => p?.inlineData?.data)?.inlineData;

        if (!inline?.data) {
          return json({error: "No voice audio returned"}, 502);
        }

        const binary = atob(inline.data);

        if (binary.length > 8000000) {
          return json({error: "Audio too long"}, 413);
        }

        if (
          binary.slice(0, 4) !== "RIFF" ||
          binary.slice(8, 12) !== "WAVE"
        ) {
          return json({
            error: "Provider did not return WAV audio",
            format: inline.mimeType || "unknown"
          }, 502);
        }

        const bytes = Uint8Array.from(
          binary, c => c.charCodeAt(0)
        );

        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store",
            "Content-Disposition": "attachment; filename=recap-voice.wav"
          }
        });

      } catch {
        return json({error: "Voice service request failed"}, 502);
      }
    }

    const source = [
      input?.subtitle_text,
      input?.subtitles,
      input?.transcript,
      input?.dialogue,
      input?.source_text,
      input?.text
    ].find(x => typeof x === "string" && x.trim());

    if (!source || source.trim().length < 20) {
      return json({error: "Subtitle text required"}, 400);
    }

    const prompt =
      "Write a natural Myanmar-language movie recap script using ONLY the following source text. " +
      "Keep the story chronological. Do not invent scenes or details. " +
      "Return only the Burmese script.\n\n" + source;

    try {
      const result = await gemini(env, textModel, {
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192
        }
      });

      if (result.error) {
        return json({
          error: "Gemini API failed",
          status: result.status,
          detail: result.error
        }, 502);
      }

      const script = outputText(result.data);

      return script
        ? json({
            script,
            recap: script,
            text: script,
            result: script
          })
        : json({error: "No script generated"}, 502);

    } catch {
      return json({error: "AI request failed"}, 502);
    }
  }
};
