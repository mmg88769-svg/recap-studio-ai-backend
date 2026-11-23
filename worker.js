
// Recap Studio AI v0.7
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
        version: "0.7"
      });
    }

    const tts = url.pathname === "/api/tts";
    const translate = url.pathname === "/api/translate";
    const uploadSession = url.pathname === "/api/upload-session";
    const videoStatus = url.pathname === "/api/video-status";
    const analyzeVideo = url.pathname === "/api/analyze-long-video";

    if (
      request.method !== "POST" ||
      (!tts && !translate && !uploadSession && !videoStatus && !analyzeVideo && !scriptPaths.has(url.pathname))
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

    if (uploadSession) {
      const size = Number(input?.size_bytes), mime = input?.mime_type;
      if (!Number.isSafeInteger(size) || size < 1 || size > 500000000) return json({error:"Video size must be 1 byte to 500 MB"},400);
      if (!["video/mp4","video/quicktime"].includes(mime)) return json({error:"Unsupported video MIME type"},400);
      try {
        const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
          method:"POST",
          headers:{"x-goog-api-key":env.GEMINI_API_KEY,"X-Goog-Upload-Protocol":"resumable","X-Goog-Upload-Command":"start","X-Goog-Upload-Header-Content-Length":String(size),"X-Goog-Upload-Header-Content-Type":mime,"Content-Type":"application/json"},
          body:JSON.stringify({file:{display_name:"WHK_MovieRecap_"+Date.now()}})
        });
        if (!start.ok) return json({error:"Gemini upload session failed",detail:(await start.text()).slice(0,300)},502);
        const uploadUrl = start.headers.get("x-goog-upload-url");
        if (!uploadUrl || !uploadUrl.startsWith("https://generativelanguage.googleapis.com/")) return json({error:"Gemini did not return a valid upload URL"},502);
        return json({upload_url:uploadUrl});
      } catch { return json({error:"Could not create Gemini upload session"},502); }
    }

    if (videoStatus) {
      const name = typeof input?.file_name === "string" ? input.file_name : "";
      if (!/^files\/[A-Za-z0-9_-]+$/.test(name)) return json({error:"Invalid Gemini file name"},400);
      try {
        const r = await fetch("https://generativelanguage.googleapis.com/v1beta/"+name,{headers:{"x-goog-api-key":env.GEMINI_API_KEY}});
        const data = await r.json();
        if (!r.ok) return json({error:"Gemini file status failed",detail:data?.error?.message?.slice(0,250)},502);
        return json({state:data.state || "PROCESSING",file_uri:data.uri || "",error:data.error?.message || ""});
      } catch { return json({error:"Could not check Gemini video status"},502); }
    }

    if (analyzeVideo) {
      const fileUri = typeof input?.file_uri === "string" ? input.file_uri : "";
      const mime = input?.mime_type;
      const language = languageNames[input?.language] ? input.language : "my";
      if (!fileUri.startsWith("https://generativelanguage.googleapis.com/") || !["video/mp4","video/quicktime"].includes(mime)) return json({error:"Invalid Gemini video reference or MIME type"},400);
      const prompt = `Analyze the complete supplied movie video, including visible scenes, actions, chronology, character relationships and intelligible dialogue. Write an engaging, natural ${languageNames[language]} movie recap in chronological order. Use connected storytelling, not a shot list or report. Only describe events supported by the video; do not invent names, motives, dialogue or scenes. Return only the narration script.`;
      try {
        const result = await gemini(env,textModel,{contents:[{parts:[{fileData:{mimeType:mime,fileUri}},{text:prompt}]}],generationConfig:{temperature:0.35,maxOutputTokens:12000}});
        if (result.error) return json({error:"Video analysis failed",status:result.status,detail:result.error},502);
        const script = outputText(result.data);
        return script ? json({script}) : json({error:"No recap script generated"},502);
      } catch { return json({error:"Video analysis request failed"},502); }
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
