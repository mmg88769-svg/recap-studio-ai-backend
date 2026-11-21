const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return reply({
        status: "online",
        service: "Recap Studio AI Backend"
      });
    }

    if (request.method !== "POST" ||
        !["/", "/generate", "/api/generate", "/generate-recap", "/api/recap"].includes(url.pathname)) {
      return reply({ error: "Not found" }, 404);
    }

    if (!env.GEMINI_API_KEY || !env.APP_TOKEN) {
      return reply({ error: "Server not configured" }, 503);
    }

    const auth = request.headers.get("Authorization");
    if (auth !== "Bearer " + env.APP_TOKEN) {
      return reply({ error: "Unauthorized" }, 401);
    }

    let input;
    try {
      const body = await request.text();
      if (body.length > 80000) {
        return reply({ error: "Text too long" }, 413);
      }
      input = JSON.parse(body);
    } catch {
      return reply({ error: "Invalid JSON" }, 400);
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
      return reply({ error: "Subtitle text required" }, 400);
    }

    const prompt =
      "Write a natural Myanmar-language movie recap script using ONLY the following source text. " +
      "Keep the story chronological. Do not invent scenes or details. Return only the Burmese script.\n\n" +
      source;

    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 8192
            }
          })
        }
      );

      const data = await res.json();
      if (!res.ok) {
        return reply({
          error: "Gemini API failed",
          status: res.status
        }, 502);
      }

      const script = (data.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || "").join("").trim();

      if (!script) {
        return reply({ error: "No script generated" }, 502);
      }

      return reply({
        script,
        recap: script,
        text: script,
        result: script
      });
    } catch {
      return reply({ error: "AI request failed" }, 502);
    }
  }
}; 
