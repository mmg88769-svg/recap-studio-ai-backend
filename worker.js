import evidenceWorker from "./experimental/worker-v028-evidence.js";
import transcriptionWorker from "./experimental/transcribe-audio-v028.js";


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

    // v0.28 protected prototype endpoints; legacy routes remain unchanged.
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "online",
        version: "0.28-prototype",
        mode: "integrated-prototype",
        capabilities: ["audio-transcription", "transcript-plus-sampled-frames"],
        ai_configured: Boolean(env.APP_TOKEN && env.GEMINI_API_KEY)
      });
    }
    if (url.pathname === "/api/analyze-evidence") {
      return evidenceWorker.fetch(request, env);
    }
    if (url.pathname === "/api/transcribe-audio") {
      return transcriptionWorker.fetch(request, env);
    }

    if (request.method === "GET") {
      return json({
        status: "online",
        service: "Recap Studio AI Backend",
        version: "0.6"
      });
    }

    const tts = url.pathname === "/api/tts";
    const translate = url.pathname === "/api/translate";

    if (
      request.method !== "POST" ||
      (!tts && !translate && !scriptPaths.has(url.pathname))
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
