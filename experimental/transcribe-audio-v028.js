import {getGoogleAiRequest, getGoogleAiProviderInfo, isGoogleAiConfigured} from "../google-ai-provider.js";
// Isolated W.H.K audio transcription prototype. Not deployed or wired into Android.
// Short audio clips only. No persistent storage. Never put API keys in the app.
const MAX_BASE64=2_800_000;
const MODEL="gemini-3.8-flash";
const FALLBACK_MODELS=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const MIME=new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/mp4","audio/aac","audio/ogg","audio/webm"]);
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

export default {
 async fetch(request,env){
  if(new URL(request.url).pathname!=="/api/transcribe-audio"||request.method!=="POST")return json({error:"Not found"},404);
  if(!isGoogleAiConfigured(env))return json({error:"Server not configured",provider:getGoogleAiProviderInfo(env)},503);
  if(request.headers.get("authorization")!==`Bearer ${env.APP_TOKEN}`)return json({error:"Unauthorized"},401);
  const length=Number(request.headers.get("content-length")||0);
  if(length>3_000_000)return json({error:"Audio request too large"},413);
  let input;
  try{const raw=await request.text();if(raw.length>3_000_000)return json({error:"Audio request too large"},413);input=JSON.parse(raw)}
  catch{return json({error:"Invalid JSON"},400)}
  if(!input||!MIME.has(input.mime_type)||typeof input.audio_base64!=="string"||input.audio_base64.length===0||input.audio_base64.length>MAX_BASE64||input.audio_base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio_base64))return json({error:"Invalid audio payload"},400);
  const instruction="Transcribe the spoken dialogue of this short audio clip in its original language. Include accurate clip-relative millisecond timestamps for each spoken segment. Do not invent speech. For non-speech clips, return an empty segments array. Output JSON object with segments array of {start_ms,end_ms,text,language} and uncertainties array of strings.";
  const providerError = error => ({
    name:String(error?.name||"Error").slice(0,60),
    message:String(error?.message||"Network request failed")
      .replaceAll("https://generativelanguage.googleapis.com","[upstream]")
       .replaceAll("https://aiplatform.googleapis.com","[upstream]")
      .slice(0,180)
  });
  let response, attempts = 0, activeModel = MODEL, fallback_used = false;
  let primary_network_error=null;
  try{
   const providerRequest=getGoogleAiRequest(env,MODEL);
   if(providerRequest.error)return json({error:providerRequest.error},503);
   const result=await fetchWithTransientRetry(providerRequest.url,{
    method:"POST",headers:providerRequest.headers,
    body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction},{inline_data:{mime_type:input.mime_type,data:input.audio_base64}}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
   });
   response=result.response;
   attempts=result.attempts;
  }catch(error){
    attempts=3;
    primary_network_error=providerError(error);
    response=new Response(JSON.stringify({error:{message:`Primary model network failure (${primary_network_error.name}): ${primary_network_error.message}`}}),{status:504,headers:{"content-type":"application/json"}});
  }
  // Keep actual upstream/network diagnostics; do not disguise a timeout as a generic 503.
  const fallback_models_tried=[];
  const fallback_network_errors=[];
  for(const fallbackModel of FALLBACK_MODELS){
   if(response.status!==429&&!RETRYABLE_PROVIDER_STATUSES.has(response.status))break;
   try{await response.body?.cancel();}catch{}
   fallback_models_tried.push(fallbackModel);
   try{
    const fallbackRequest=getGoogleAiRequest(env,fallbackModel);
     if(fallbackRequest.error)throw new Error(fallbackRequest.error);
     const secondary=await fetch(fallbackRequest.url,{
     method:"POST",signal:AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
     headers:fallbackRequest.headers,
     body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction},{inline_data:{mime_type:input.mime_type,data:input.audio_base64}}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:8192}})
    });
    response=secondary;attempts++;activeModel=fallbackModel;fallback_used=true;
   }catch(error){
    const diagnostic=providerError(error);
    fallback_network_errors.push({model:fallbackModel,...diagnostic});
    attempts++;activeModel=fallbackModel;fallback_used=true;
    response=new Response(JSON.stringify({error:{message:`Fallback model ${fallbackModel} network failure (${diagnostic.name}): ${diagnostic.message}`}}),{status:503,headers:{"content-type":"application/json"}});
   }
  }
  if(response.status===429){
   let provider={};try{provider=await response.json();}catch{}
   const detail=String(provider?.error?.message||"Gemini quota/rate limit exhausted").slice(0,300);
   const retry_after_seconds=retryAfterSeconds(provider);
   return json({error:"Gemini quota/rate limit reached on primary and fallback models",provider_status:429,
    model:activeModel,fallback_used,fallback_models_tried,detail,quota_violations:quotaViolations(provider),
    primary_network_error,fallback_network_errors,
    retryable:retry_after_seconds!==null,...(retry_after_seconds!==null?{retry_after_seconds}:{}),attempts},429);
  }
  if(!response.ok){
   let provider={};try{provider=await response.json()}catch{}
   const detail=String(provider?.error?.message||"").slice(0,240);
   return json({error:"AI provider failed (HTTP "+response.status+"): "+(detail||"Provider error"),
    provider_status:response.status,model:activeModel,fallback_used,fallback_models_tried,
    primary_network_error,fallback_network_errors,detail,retryable:response.status>=500,attempts},502);
  }
  let body;try{body=await response.json()}catch{return json({error:"Invalid AI response"},502)}
  const text=(body?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").trim();
  try{
   const parsed=JSON.parse(text);
   if(!Array.isArray(parsed.segments)||!Array.isArray(parsed.uncertainties)||parsed.segments.length>500)throw Error("shape");
   for(const s of parsed.segments){
    if(!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.end_ms<=s.start_ms||typeof s.text!=="string"||typeof s.language!=="string")throw Error("segment");
   }
   return json({version:"0.28-prototype",model:activeModel,fallback_used,fallback_models_tried,primary_network_error,fallback_network_errors,timestamp_basis:"clip-relative",transcript_segments:parsed.segments,uncertainties:parsed.uncertainties});
  }catch{return json({error:"Invalid transcription structure"},502)}
 }
};
