// W.H.K v0.28 isolated prototype. NOT deployed. Does not replace worker.js.
// Accepts timestamped transcript and optional sampled JPEG frames; no claim of full-video listening.
const MAX_BODY=3500000, MAX_TRANSCRIPT=100000, MAX_FRAMES=8, MODEL="gemini-3.8-flash";
const FALLBACK_MODELS=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const RETRYABLE_PROVIDER_STATUSES = new Set([500,502,503,504,524]);
// Cap upstream latency: at most five provider attempts, 18 seconds each.
const PROVIDER_FETCH_TIMEOUT_MS = 18000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function retryAfterSeconds(provider) {
  const details = Array.isArray(provider?.error?.details) ? provider.error.details : [];
  const retryInfo = details.find(x => String(x?.["@type"] || "").includes("RetryInfo"));
  const delay = String(retryInfo?.retryDelay || "").match(/(\d+(?:\.\d+)?)s/i);
  if (delay) return Math.max(1, Math.ceil(Number(delay[1])));
  const message = String(provider?.error?.message || "").match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  return message ? Math.max(1, Math.ceil(Number(message[1]))) : null;
}
function quotaViolations(provider) {
  const details = Array.isArray(provider?.error?.details) ? provider.error.details : [];
  const failure = details.find(x => String(x?.["@type"] || "").includes("QuotaFailure"));
  return (Array.isArray(failure?.violations) ? failure.violations : []).slice(0, 8).map(v => ({
    metric: String(v?.quotaMetric || "").slice(0, 120),
    quota_id: String(v?.quotaId || "").slice(0, 120),
    model: String(v?.quotaDimensions?.model || "").slice(0, 80),
    quota_value: String(v?.quotaValue || "").slice(0, 30)
  }));
}
async function fetchWithTransientRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {...options,signal:AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)});
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

function validate(input){
  if(!input || typeof input!=="object")return "JSON object required";
  if(!Array.isArray(input.transcript_segments)||input.transcript_segments.length<1||input.transcript_segments.length>2000)return "1-2000 transcript_segments required";
  let previous=-1,total=0;
  for(const s of input.transcript_segments){
    if(!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.end_ms<=s.start_ms||s.start_ms<previous||typeof s.text!=="string"||s.text.length>2000)return "Invalid or unsorted transcript segment";
    previous=s.start_ms;total+=s.text.length;
  }
  if(total>MAX_TRANSCRIPT)return "Transcript too long";
  if(input.frames!==undefined){
    if(!Array.isArray(input.frames)||input.frames.length>MAX_FRAMES)return "Maximum eight sampled frames";
    for(const f of input.frames){
      if(!Number.isFinite(f.time_ms)||f.time_ms<0||typeof f.jpeg_base64!=="string"||f.jpeg_base64.length>450000||f.jpeg_base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(f.jpeg_base64))return "Invalid JPEG frame";
    }
  }
  return null;
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method==="GET"&&path==="/health")return reply({status:"online",version:"0.28-prototype",mode:"integrated-prototype",capabilities:["audio-transcription","transcript-plus-sampled-frames"],ai_configured:Boolean(env.APP_TOKEN&&env.GEMINI_API_KEY)});
    if(request.method!=="POST"||path!=="/api/analyze-evidence")return reply({error:"Not found"},404);
    if(!env.APP_TOKEN||!env.GEMINI_API_KEY)return reply({error:"Server not configured"},503);
    if(request.headers.get("authorization")!==`Bearer ${env.APP_TOKEN}`)return reply({error:"Unauthorized"},401);
    const length=Number(request.headers.get("content-length")||0);
    if(length>MAX_BODY)return reply({error:"Request too large"},413);
    let input;
    try{const raw=await request.text();if(raw.length>MAX_BODY)return reply({error:"Request too large"},413);input=JSON.parse(raw);}
    catch{return reply({error:"Invalid JSON"},400);}
    const error=validate(input);if(error)return reply({error},400);
    const transcript=input.transcript_segments.map(s=>`[${s.start_ms}-${s.end_ms} ms] ${s.text}`).join("\n");
    const instructions=[
      "Write a coherent chronological Burmese movie recap grounded ONLY in the evidence.",
      "Transcript is audio/dialogue evidence. Frames are sparse visual evidence, not the whole movie.",
      "Never invent unseen plot details. Identify ambiguous events as uncertain.",
      "Avoid frame-by-frame captions; write natural connected storytelling.",
      "Keep narration suitable for a 45–60 second voiceover and at most 2500 Unicode characters.",
      "Return 6–16 chronological key story events when the evidence supports them; do not invent events to reach a count.",
      "Return JSON with keys narration_my (string), events (array of {start_ms,end_ms,summary_my,evidence}), uncertainties (array of strings).",
      "Use event timestamps supported by the supplied evidence.",
      "Timestamped transcript:\n"+transcript
    ].join("\n");
    const parts=[{text:instructions}];
    for(const frame of input.frames||[]){
      parts.push({text:`Sampled frame at ${frame.time_ms} ms (visual context only):`});
      parts.push({inline_data:{mime_type:"image/jpeg",data:frame.jpeg_base64}});
    }
    let response, attempts = 0, activeModel = MODEL, fallback_used = false;
    try{
      const result=await fetchWithTransientRetry(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,{
        method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
        body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
      });
      response=result.response;
      attempts=result.attempts;
    }catch{
      attempts=3;
      response=new Response(JSON.stringify({error:{message:"Primary model timed out"}}),{status:504,headers:{"content-type":"application/json"}});
    }
    // Model-specific 429 quota limits and transient 5xx overload can use bounded Lite fallbacks.
    const fallback_models_tried=[];
    for(const fallbackModel of FALLBACK_MODELS){
      if(response.status!==429&&!RETRYABLE_PROVIDER_STATUSES.has(response.status))break;
      try{
        try{await response.body?.cancel();}catch{}
        const secondary=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent`,{
          method:"POST",signal:AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
          headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
          body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
        });
        response=secondary;attempts++;activeModel=fallbackModel;fallback_used=true;fallback_models_tried.push(fallbackModel);
      }catch{
        attempts++;activeModel=fallbackModel;fallback_used=true;fallback_models_tried.push(fallbackModel);
        response=new Response(JSON.stringify({error:{message:"Fallback provider temporarily unreachable"}}),{status:503,headers:{"content-type":"application/json"}});
      }
    }
    if(response.status===429){
      let provider={};try{provider=await response.json();}catch{}
      const detail=String(provider?.error?.message||"Gemini quota/rate limit exhausted").slice(0,300);
      const retry_after_seconds=retryAfterSeconds(provider);
      return reply({error:"Gemini quota/rate limit reached on primary and fallback models",provider_status:429,
        model:activeModel,fallback_used,fallback_models_tried,detail,quota_violations:quotaViolations(provider),
        retryable:retry_after_seconds!==null,...(retry_after_seconds!==null?{retry_after_seconds}:{}),attempts},429);
    }
    if(!response.ok){
      let provider={};try{provider=await response.json()}catch{}
      const detail=String(provider?.error?.message||"").slice(0,240);
      return reply({error:"AI provider request failed (HTTP "+response.status+"): "+(detail||"Provider error"),
        provider_status:response.status,model:activeModel,fallback_used,detail,retryable:response.status>=500,attempts},502);
    }
    let data;
    try{data=await response.json();}catch{return reply({error:"Invalid provider response"},502);}
    const raw=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
    if(!raw)return reply({error:"No recap generated"},502);
    try{
      const result=JSON.parse(raw);
      if(typeof result.narration_my!=="string"||!result.narration_my.trim()||result.narration_my.length>2500||!Array.isArray(result.events)||result.events.length>500||!Array.isArray(result.uncertainties)||result.uncertainties.length>100)throw Error("shape");
      if(result.uncertainties.some(x=>typeof x!=="string"||x.length>1000))throw Error("uncertainty");
      const maxEvidenceTime=Math.max(...input.transcript_segments.map(s=>s.end_ms),...(input.frames||[]).map(f=>f.time_ms));
      let previousStart=-1;
      for(const event of result.events){
        if(!event||typeof event!=="object"||!Number.isSafeInteger(event.start_ms)||!Number.isSafeInteger(event.end_ms)||event.start_ms<0||event.end_ms<=event.start_ms||event.end_ms>maxEvidenceTime||event.start_ms<previousStart||typeof event.summary_my!=="string"||!event.summary_my.trim()||event.summary_my.length>3000||!Array.isArray(event.evidence)||event.evidence.length===0||event.evidence.length>20||event.evidence.some(x=>typeof x!=="string"||!x.trim()||x.length>500))throw Error("event");
        previousStart=event.start_ms;
      }
      return reply({version:"0.28-prototype",model:activeModel,fallback_used,mode:"transcript-plus-sampled-frames",audio_analyzed_from:"client_supplied_transcript",...result});
    }catch{return reply({error:"AI returned invalid recap structure"},502);}
  }
};
