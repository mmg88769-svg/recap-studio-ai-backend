
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}
});
const allowedPaths = ["/", "/generate", "/api/generate", "/generate-recap", "/api/recap"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return json({status:"online", service:"Recap Studio AI Backend", version:"0.5"});
    const tts = url.pathname === "/api/tts";
    if (request.method !== "POST" || (!tts && !allowedPaths.includes(url.pathname))) return json({error:"Not found"},404);
    if (!env.GEMINI_API_KEY || !env.APP_TOKEN) return json({error:"Server not configured"},503);
    if (request.headers.get("Authorization") !== "Bearer " + env.APP_TOKEN) return json({error:"Unauthorized"},401);

    let input;
    try {
      const raw = await request.text();
      if (raw.length > 80000) return json({error:"Request too large"},413);
      input = JSON.parse(raw);
    } catch { return json({error:"Invalid JSON"},400); }

    if (tts) {
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (text.length < 2 || text.length > 1400) return json({error:"Voice text must be 2 to 1400 characters. Split longer recaps into parts."},400);
      const voice = ["Kore","Puck","Aoede","Charon","Fenrir"].includes(input?.voice) ? input.voice : "Kore";
      try {
        const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent", {
          method:"POST",
          headers:{"Content-Type":"application/json", "x-goog-api-key":env.GEMINI_API_KEY},
          body:JSON.stringify({
            contents:[{role:"user",parts:[{text, speechMetadata:{style:"Natural, clear Burmese movie recap narration"}}]}],
            generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{voice}}}
          })
        });
        const payload = await resp.json();
        if (!resp.ok) return json({error:"Gemini TTS failed",status:resp.status, detail: payload?.error?.message?.slice(0,220) || "Provider returned an error"},502);
        const audio = payload?.candidates?.[0]?.content?.parts?.find(p=>p?.inlineData?.data)?.inlineData;
        if (!audio?.data) return json({error:"No voice audio returned"},502);
        if (audio.mimeType && !audio.mimeType.toLowerCase().startsWith("audio/wav")) {
          return json({error:"Unexpected TTS audio format",format:audio.mimeType},502);
        }
        const binary = atob(audio.data);
        if (binary.slice(0, 4) !== "RIFF" || binary.slice(8, 12) !== "WAVE") {
          return json({error:"TTS audio missing WAV header"},502);
        }
        if (binary.length > 8_000_000) return json({error:"Audio too long, try a shorter paragraph"},413);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, {status:200, headers:{"Content-Type":"audio/wav","Cache-Control":"no-store", "Content-Disposition":"attachment; filename=recap-voice.wav"}});
      } catch { return json({error:"Voice service request failed"},502); }
    }

    const source = [input?.subtitle_text,input?.subtitles,input?.transcript,input?.dialogue,input?.source_text,input?.text]
      .find(x=>typeof x === "string" && x.trim());
    if (!source || source.trim().length < 20) return json({error:"Subtitle text required"},400);
    const prompt = "Write a natural Myanmar-language movie recap script using ONLY the following source text. Keep the story chronological. Do not invent scenes or details. Return only the Burmese script.\n\n" + source;
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",{
        method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
        body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.4,maxOutputTokens:8192}})
      });
      const data = await res.json();
      if (!res.ok) return json({error:"Gemini API failed",status:res.status},502);
      const script=(data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
      if (!script) return json({error:"No script generated"},502);
      return json({script,recap:script,text:script,result:script});
    } catch { return json({error:"AI request failed"},502); }
  }
};
