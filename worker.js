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

const textModel = "gemini-3.8-flash";
const voiceModel = "gemini-3.8-flash-tts";

const RETRYABLE_PROVIDER_STATUSES = new Set([500,502,503,504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchWithTransientRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!RETRYABLE_PROVIDER_STATUSES.has(response.status) || attempt === 3)
        return {response, attempts: attempt};
      try { await response.body?.cancel(); } catch {}
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
    }
    await wait(attempt * 750);
  }
  throw lastError || new Error("AI provider unavailable");
}

async function gemini(env, model, payload) {
  let response, attempts = 0;
  try {
    const result = await fetchWithTransientRetry(
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
    response = result.response;
    attempts = result.attempts;
  } catch {
    return {error:"AI provider temporarily unavailable after three attempts",status:503,attempts:3};
  }

  let data;
  try { data = await response.json(); }
  catch { return {error:"Invalid AI provider response",status:502,attempts}; }

  if (!response.ok) {
    return {
      error: data?.error?.message?.slice(0, 250) || "AI provider error",
      status: response.status,
      attempts
    };
  }

  return {data,attempts};
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
            maxOutputTokens: 8192
          }
        });

        if (result.error) {
          return json({
            error: "Translation failed",
            status: result.status,
            detail: result.error,
            attempts: result.attempts,
            retryable: result.status >= 500
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
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      const language = languageNames[input?.language] ? input.language : "my";
      const gender = input?.gender === "female" ? "female" : "male";
      const age = ageNames[input?.age] ? input.age : "adult";
      const style = styles[input?.style] ? input.style : "cinematic";

      if (text.length < 2 || text.length > 2500)
        return json({error:"Voice text must be 2 to 2500 characters"},400);

      const voice = gender === "male"
        ? (age === "mature" ? "Fenrir" : "Charon")
        : (age === "young" ? "Aoede" : "Kore");
      const direction =
        `Read the exact text fluently in ${languageNames[language]} using a ${ageNames[age]}-sounding ${gender} narrator persona. ` +
        `Use ${styles[style]}. Speak clearly with natural pauses. Do not translate, add words, or add sound effects.`;

      try {
        const retried = await fetchWithTransientRetry("https://generativelanguage.googleapis.com/v1beta/interactions", {
          method:"POST",
          headers:{
            "Content-Type":"application/json",
            "x-goog-api-key":env.GEMINI_API_KEY
          },
          body:JSON.stringify({
            model:voiceModel,
            input:[{
              type:"user_input",
              content:[{
                type:"text",
                text,
                annotations:[{type:"speech_metadata",style:direction}]
              }]
            }],
            response_format:{type:"audio"},
            generation_config:{speech_config:[{voice}]}
          })
        });
        const response = retried.response;
        const attempts = retried.attempts;
        let data;
        try { data=await response.json(); }
        catch { return json({error:"Invalid Gemini TTS response",attempts},502); }
        if (response.status===429)
          return json({error:"Gemini Free Tier TTS quota/rate limit",retryable:true,retry_after_seconds:60,attempts},429);
        if (!response.ok)
          return json({error:"Gemini TTS failed (HTTP "+response.status+"): "+(data?.error?.message?.slice(0,250)||"Provider error"),
            provider_status:response.status,detail:data?.error?.message?.slice(0,250)||"Provider error",
            retryable:response.status>=500,attempts},502);

        // REST Interactions responses expose generated audio in steps[].content[].
        const stepAudio=(data?.steps||[])
          .filter(step=>step?.type==="model_output")
          .flatMap(step=>step.content||[])
          .filter(part=>part?.type==="audio"&&typeof part.data==="string")
          .at(-1);
        const audioData=stepAudio?.data;
        const audioMime=stepAudio?.mime_type||"audio/wav";
        if (!audioData) return json({error:"No voice audio returned"},502);

        const binary=atob(audioData);
        if(binary.length>8000000)return json({error:"Audio too long"},413);
        if(binary.slice(0,4)!=="RIFF"||binary.slice(8,12)!=="WAVE")
          return json({error:"Gemini did not return a WAV container",format:audioMime},502);

        const bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));
        return new Response(bytes,{
          status:200,
          headers:{
            "Content-Type":"audio/wav",
            "Cache-Control":"no-store",
            "Content-Disposition":"attachment; filename=whk-gemini-narration.wav"
          }
        });
      } catch {
        return json({error:"Gemini TTS service unavailable after retries",retryable:true,attempts:3,retry_after_seconds:15},502);
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
          maxOutputTokens: 8192
        }
      });

      if (result.error) {
        return json({
          error: "Gemini API failed",
          status: result.status,
          detail: result.error,
          attempts: result.attempts,
          retryable: result.status >= 500
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
