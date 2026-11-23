// Isolated W.H.K audio transcription prototype. Not deployed or wired into Android.
// Short audio clips only. No persistent storage. Never put API keys in the app.
const MAX_BASE64=2_800_000;
const MODEL="gemini-3.8-flash";
const FALLBACK_MODELS=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const MIME=new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/mp4","audio/aac","audio/ogg","audio/webm"]);
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

export default {
 async fetch(request,env){
  if(new URL(request.url).pathname!=="/api/transcribe-audio"||request.method!=="POST")return json({error:"Not found"},404);
  if(!env.APP_TOKEN||!env.GEMINI_API_KEY)return json({error:"Server not configured"},503);
  if(request.headers.get("authorization")!==`Bearer ${env.APP_TOKEN}`)return json({error:"Unauthorized"},401);
  const length=Number(request.headers.get("content-length")||0);
  if(length>3_000_000)return json({error:"Audio request too large"},413);
  let input;
  try{const raw=await request.text();if(raw.length>3_000_000)return json({error:"Audio request too large"},413);input=JSON.parse(raw)}
  catch{return json({error:"Invalid JSON"},400)}
  if(!input||!MIME.has(input.mime_type)||typeof input.audio_base64!=="string"||input.audio_base64.length===0||input.audio_base64.length>MAX_BASE64||input.audio_base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio_base64))return json({error:"Invalid audio payload"},400);
  const instruction="Transcribe the spoken dialogue of this short audio clip in its original language. Include accurate clip-relative millisecond timestamps for each spoken segment. Do not invent speech. For non-speech clips, return an empty segments array. Output JSON object with segments array of {start_ms,end_ms,text,language} and uncertainties array of strings.";
  let response, attempts = 0, activeModel = MODEL, fallback_used = false;
  try{
   const result=await fetchWithTransientRetry(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,{
    method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction},{inline_data:{mime_type:input.mime_type,data:input.audio_base64}}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
   });
   response=result.response;
   attempts=result.attempts;
  }catch{return json({error:"AI provider unreachable after three attempts",retryable:true,attempts:3,retry_after_seconds:15},503)}
  // A persistent Gemini 3.8 503 is overload, not a quota/authentication error.
  // Try the official Free Tier multimodal Lite model only after primary retries fail.
  for(const fallbackModel of FALLBACK_MODELS){
   if(!RETRYABLE_PROVIDER_STATUSES.has(response.status))break;
   try{
    const secondary=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent`,{
     method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
     body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction},{inline_data:{mime_type:input.mime_type,data:input.audio_base64}}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
    });
    response=secondary;attempts++;activeModel=fallbackModel;fallback_used=true;
   }catch{
    attempts++;activeModel=fallbackModel;fallback_used=true;
    response=new Response(JSON.stringify({error:{message:"Fallback provider temporarily unreachable"}}),{status:503,headers:{"content-type":"application/json"}});
   }
  }
  if(response.status===429)return json({error:"AI quota exceeded",retryable:true,retry_after_seconds:60,attempts},429);
  if(!response.ok){
   let provider={};try{provider=await response.json()}catch{}
   const detail=String(provider?.error?.message||"").slice(0,240);
   return json({error:"AI provider failed (HTTP "+response.status+"): "+(detail||"Provider error"),
    provider_status:response.status,model:activeModel,fallback_used,detail,retryable:response.status>=500,attempts},502);
  }
  let body;try{body=await response.json()}catch{return json({error:"Invalid AI response"},502)}
  const text=(body?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").trim();
  try{
   const parsed=JSON.parse(text);
   if(!Array.isArray(parsed.segments)||!Array.isArray(parsed.uncertainties)||parsed.segments.length>500)throw Error("shape");
   for(const s of parsed.segments){
    if(!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.end_ms<=s.start_ms||typeof s.text!=="string"||typeof s.language!=="string")throw Error("segment");
   }
   return json({version:"0.28-prototype",model:activeModel,fallback_used,timestamp_basis:"clip-relative",transcript_segments:parsed.segments,uncertainties:parsed.uncertainties});
  }catch{return json({error:"Invalid transcription structure"},502)}
 }
};
