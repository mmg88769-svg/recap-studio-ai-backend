import {getGoogleAiRequest, getGoogleAiProviderInfo, isGoogleAiConfigured} from "../google-ai-provider.js";
// W.H.K v0.28 isolated prototype. NOT deployed. Does not replace worker.js.
// Accepts timestamped transcript and optional sampled JPEG frames; no claim of full-video listening.
const MAX_BODY=3500000, MAX_TRANSCRIPT=100000, MAX_FRAMES=8, MODEL="gemini-3.8-flash";
const FALLBACK_MODELS=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
// Constrain Gemini to the exact JSON contract consumed by the recap pipeline.
const RECAP_RESPONSE_SCHEMA={
  type:"OBJECT",
  properties:{
    narration_my:{type:"STRING"},
    events:{
      type:"ARRAY",
      items:{
        type:"OBJECT",
        properties:{
          start_ms:{type:"INTEGER"},
          end_ms:{type:"INTEGER"},
          summary_my:{type:"STRING"},
          evidence:{type:"ARRAY",items:{type:"STRING"}}
        },
        required:["start_ms","end_ms","summary_my","evidence"]
      }
    },
    uncertainties:{type:"ARRAY",items:{type:"STRING"}}
  },
  required:["narration_my","events","uncertainties"]
};
function normalizeEvidenceText(value){
  return String(value||"").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g," ").trim();
}
function groundedEvidenceForEvent(event,input){
  const grounded=[];
  for(const raw of event.evidence){
    const evidence=raw.trim();
    const dialoguePrefix=evidence.match(/^DIALOGUE:\s*/i);
    if(dialoguePrefix){
      let quote=evidence.slice(dialoguePrefix[0].length).trim();
      if((quote.startsWith('"')&&quote.endsWith('"'))||(quote.startsWith("“")&&quote.endsWith("”")))
        quote=quote.slice(1,-1).trim();
      const normalizedQuote=normalizeEvidenceText(quote);
      if(Array.from(normalizedQuote).length>=4&&input.transcript_segments.some(segment=>
        segment.start_ms<=event.end_ms&&segment.end_ms>=event.start_ms&&
        normalizeEvidenceText(segment.text).includes(normalizedQuote)))
        grounded.push(evidence);
      continue;
    }
    const frameMatch=evidence.match(/^FRAME@(\d+)ms(?::\s*[\s\S]*)?$/i);
    if(frameMatch){
      const timeMs=Number(frameMatch[1]);
      if((input.frames||[]).some(frame=>frame.time_ms===timeMs)&&
        timeMs>=event.start_ms&&timeMs<=event.end_ms)
        grounded.push(evidence);
    }
  }
  return grounded;
}
function validateRecapStructure(result,input){
  if(!result||typeof result!=="object"||Array.isArray(result))return "response must be a JSON object";
  if(typeof result.narration_my!=="string"||!result.narration_my.trim()||result.narration_my.length>2500)
    return "narration_my must be a non-empty string of at most 2500 characters";
  if(!Array.isArray(result.events)||result.events.length>500)return "events must be an array with at most 500 items";
  if(!Array.isArray(result.uncertainties)||result.uncertainties.length>100)return "uncertainties must be an array with at most 100 strings";
  for(let i=0;i<result.uncertainties.length;i++)
    if(typeof result.uncertainties[i]!=="string"||result.uncertainties[i].length>1000)
      return "uncertainties["+i+"] must be a string of at most 1000 characters";
  const maxEvidenceTime=Math.max(...input.transcript_segments.map(s=>s.end_ms),...(input.frames||[]).map(f=>f.time_ms));
  let previousStart=-1;
  for(let i=0;i<result.events.length;i++){
    const event=result.events[i];
    if(!event||typeof event!=="object"||!Number.isSafeInteger(event.start_ms)||!Number.isSafeInteger(event.end_ms))
      return "events["+i+"].start_ms and end_ms must be integer milliseconds";
    if(event.start_ms<0||event.end_ms<=event.start_ms||event.end_ms>maxEvidenceTime)
      return "events["+i+"] timestamp is outside the supplied evidence timeline";
    if(event.start_ms<previousStart)return "events["+i+"] is not in chronological order";
    if(typeof event.summary_my!=="string"||!event.summary_my.trim()||event.summary_my.length>3000)
      return "events["+i+"].summary_my must be a non-empty string of at most 3000 characters";
    if(!Array.isArray(event.evidence)||event.evidence.length===0||event.evidence.length>20||
      event.evidence.some(x=>typeof x!=="string"||!x.trim()||x.length>500))
      return "events["+i+"].evidence must contain 1-20 non-empty evidence strings";
    const grounded=groundedEvidenceForEvent(event,input);
    if(grounded.length===0)
      return "events["+i+"].evidence must cite an exact transcript quote with DIALOGUE: or a supplied frame timestamp with FRAME@...ms";
    // Drop unsupported citations when at least one valid source citation remains.
    event.evidence=grounded;
    previousStart=event.start_ms;
  }
  return null;
}
function parseRecapJson(raw){
  const clean=String(raw||"").trim().replace(/^\`\`\`(?:json)?\s*/i,"").replace(/\s*\`\`\`$/,"");
  return JSON.parse(clean);
}
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
    if(!isGoogleAiConfigured(env))return reply({error:"Server not configured",provider:getGoogleAiProviderInfo(env)},503);
    if(request.headers.get("authorization")!==`Bearer ${env.APP_TOKEN}`)return reply({error:"Unauthorized"},401);
    const length=Number(request.headers.get("content-length")||0);
    if(length>MAX_BODY)return reply({error:"Request too large"},413);
    let input;
    try{const raw=await request.text();if(raw.length>MAX_BODY)return reply({error:"Request too large"},413);input=JSON.parse(raw);}
    catch{return reply({error:"Invalid JSON"},400);}
    const error=validate(input);if(error)return reply({error},400);
    const transcript=input.transcript_segments.map(s=>`[${s.start_ms}-${s.end_ms} ms] ${s.text}`).join("\n");
    const frameTimeline=(input.frames||[]).map(frame=>frame.time_ms).join(", ")||"none";
    const instructions=[
      "You are an expert movie-story analyst and a natural Burmese recap narrator.",
      "Produce a coherent story recap grounded ONLY in the supplied evidence. Do not invent missing scenes, dialogue, character identities, relationships, motives, or an ending.",
      "First organize the evidence into a compact story map: identifiable characters, supported relationships, goals, conflict, cause-and-effect, turning points, and outcome. Use only facts supported by the supplied evidence; do not output private reasoning.",
      "Transcript segments are the available audio/dialogue evidence and include movie-relative timestamps. A transcript can contain speech-recognition errors: do not silently repair names or details unless other evidence confirms them.",
      "Frames are sparse still images, not the whole movie. Never claim motion, an action between frames, an unseen reaction, or a continuous scene based only on a still image.",
      "Follow the supplied movie timeline in timestamp order. If the evidence clearly shows a flashback or time jump, identify it as such; do not silently reorder events into an assumed story chronology.",
      "Separate what is directly supported from what is uncertain. If a character, relationship, cause, or outcome is unclear, use cautious wording and add a short Burmese uncertainty note instead of guessing.",
      "Write natural spoken Burmese for a movie recap: connected storytelling, clear transitions, consistent character references, and concise sentences. Avoid literal translation, repetitive captions, unnecessary English, and scene-by-scene image descriptions.",
      "Do not begin with generic greetings. Focus on the story. Do not add a moral, review, rating, or ending that the evidence does not support.",
      "Return 6-16 important chronological events only when the evidence supports that many; fewer events are better than invented events.",
      "For EVERY event, evidence must use ONLY these exact citation formats: DIALOGUE: followed by a continuous verbatim quote copied from one supplied transcript segment; OR FRAME@<exact_time_ms>ms: followed by a brief detail visible in that exact supplied still frame.",
      "A DIALOGUE quote must be copied exactly from the transcript, not translated or paraphrased. The quote must come from a transcript segment whose time overlaps the event start_ms/end_ms.",
      "A FRAME citation must use one of the exact sampled frame timestamps listed here: "+frameTimeline+". Its timestamp must fall within the event start_ms/end_ms. Describe only what is visibly present in that still, not movement or unseen context.",
      "Every event needs at least one source citation that directly supports its summary. Do not use generic evidence such as 'the scene', 'the movie', 'the character', or invented dialogue.",
      "Keep event timestamps within the supplied evidence timeline and order events by start_ms. Use integer milliseconds.",
      "Keep Burmese narration suitable for a 45-60 second voiceover and at most 2500 Unicode characters. Do not pad the recap to reach a target duration.",
      "If the evidence is too thin to tell the story reliably, produce a shorter cautious narration and explain the missing evidence in uncertainties.",
      "Return JSON matching the required response schema exactly. Do not include markdown or any text outside the JSON object.",
      "Timestamped transcript:\n"+transcript
    ].join("\n");
    const parts=[{text:instructions}];
    for(const frame of input.frames||[]){
      parts.push({text:`Sampled frame at ${frame.time_ms} ms (visual context only):`});
      parts.push({inline_data:{mime_type:"image/jpeg",data:frame.jpeg_base64}});
    }
    const providerError = error => ({
      name: String(error?.name || "Error").slice(0, 60),
      message: String(error?.message || "Network request failed")
        .replaceAll("https://generativelanguage.googleapis.com", "[upstream]")
        .slice(0, 180)
    });
    let response, attempts = 0, activeModel = MODEL, fallback_used = false;
    let primary_network_error = null;
    try{
      const providerRequest=getGoogleAiRequest(env,MODEL);
      if(providerRequest.error)return reply({error:providerRequest.error},503);
      const result=await fetchWithTransientRetry(providerRequest.url,{
        method:"POST",headers:providerRequest.headers,
        body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",responseSchema:RECAP_RESPONSE_SCHEMA,maxOutputTokens:8192}})
      });
      response=result.response;
      attempts=result.attempts;
    }catch(error){
      attempts=3;
      primary_network_error = providerError(error);
      response=new Response(JSON.stringify({error:{message:`Primary model network failure (${primary_network_error.name}): ${primary_network_error.message}`}}),{status:504,headers:{"content-type":"application/json"}});
    }
    // Try each Lite fallback once after bounded primary retries. Keep the real
    // network exception: hiding it as "temporarily unreachable" made 503s opaque.
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
          body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{responseMimeType:"application/json",responseSchema:RECAP_RESPONSE_SCHEMA,maxOutputTokens:8192}})
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
      return reply({error:"Gemini quota/rate limit reached on primary and fallback models",provider_status:429,
        model:activeModel,fallback_used,fallback_models_tried,detail,quota_violations:quotaViolations(provider),
        primary_network_error,fallback_network_errors,
        retryable:retry_after_seconds!==null,...(retry_after_seconds!==null?{retry_after_seconds}:{}),attempts},429);
    }
    if(!response.ok){
      let provider={};try{provider=await response.json()}catch{}
      const detail=String(provider?.error?.message||"").slice(0,240);
      return reply({error:"AI provider request failed (HTTP "+response.status+"): "+(detail||"Provider error"),
        provider_status:response.status,model:activeModel,fallback_used,fallback_models_tried,
        primary_network_error,fallback_network_errors,detail,retryable:response.status>=500,attempts},502);
    }
    let data;
    try{data=await response.json();}catch{return reply({error:"Invalid provider response"},502);}
    const raw=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
    if(!raw)return reply({error:"No recap generated"},502);
    let result;
    try{result=parseRecapJson(raw);}
    catch{
      return reply({error:"AI returned invalid recap structure: Gemini response was not valid JSON",validation_error:"Gemini response was not valid JSON",model:activeModel,fallback_used,attempts},502);
    }
    const validationError=validateRecapStructure(result,input);
    if(validationError){
      return reply({error:"AI returned invalid recap structure: "+validationError,validation_error:validationError,model:activeModel,fallback_used,attempts},502);
    }
    return reply({version:"0.28-prototype",model:activeModel,fallback_used,fallback_models_tried,primary_network_error,fallback_network_errors,mode:"transcript-plus-sampled-frames",audio_analyzed_from:"client_supplied_transcript",...result});
  }
};
