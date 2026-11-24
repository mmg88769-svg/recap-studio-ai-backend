// W.H.K v0.29 story-map prototype. Isolated branch; not deployed. Does not replace worker.js.
// Accepts timestamped transcript and optional sampled JPEG frames; no claim of full-video listening.
const MAX_BODY=3500000, MAX_TRANSCRIPT=100000, MAX_FRAMES=8, MODEL="gemini-3.8-flash";
const FALLBACK_MODELS=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
// Constrain Gemini to the exact JSON contract consumed by the recap pipeline.
const RECAP_RESPONSE_SCHEMA={
  type:"OBJECT",
  properties:{
    narration_my:{type:"STRING"},
    story_map:{
      type:"OBJECT",
      properties:{
        characters:{
          type:"ARRAY",
          items:{type:"OBJECT",properties:{id:{type:"STRING"},name:{type:"STRING"},role_my:{type:"STRING"},first_seen_ms:{type:"INTEGER"},evidence:{type:"ARRAY",items:{type:"STRING"}}},required:["id","name","role_my","first_seen_ms","evidence"]}
        },
        story_arc:{
          type:"OBJECT",
          properties:{
            opening_my:{type:"STRING"},central_conflict_my:{type:"STRING"},
            turning_points:{type:"ARRAY",items:{type:"OBJECT",properties:{start_ms:{type:"INTEGER"},summary_my:{type:"STRING"},evidence:{type:"ARRAY",items:{type:"STRING"}}},required:["start_ms","summary_my","evidence"]}},
            climax_my:{type:"STRING"},resolution_my:{type:"STRING"}
          },
          required:["opening_my","central_conflict_my","turning_points","climax_my","resolution_my"]
        }
      },
      required:["characters","story_arc"]
    },
    events:{
      type:"ARRAY",
      items:{type:"OBJECT",properties:{start_ms:{type:"INTEGER"},end_ms:{type:"INTEGER"},summary_my:{type:"STRING"},cause_my:{type:"STRING"},consequence_my:{type:"STRING"},character_ids:{type:"ARRAY",items:{type:"STRING"}},evidence:{type:"ARRAY",items:{type:"STRING"}}},required:["start_ms","end_ms","summary_my","cause_my","consequence_my","character_ids","evidence"]}
    },
    uncertainties:{type:"ARRAY",items:{type:"STRING"}}
  },
  required:["narration_my","story_map","events","uncertainties"]
};
function validateRecapStructure(result,input){
  if(!result||typeof result!=="object"||Array.isArray(result))return "response must be a JSON object";
  if(typeof result.narration_my!=="string"||!result.narration_my.trim()||result.narration_my.length>1400)return "narration_my must be a non-empty string of at most 1400 characters";
  const maxEvidenceTime=Math.max(...input.transcript_segments.map(s=>s.end_ms),...(input.frames||[]).map(f=>f.time_ms));
  const storyMap=result.story_map;
  if(!storyMap||typeof storyMap!=="object"||Array.isArray(storyMap))return "story_map must be an object";
  if(!Array.isArray(storyMap.characters)||storyMap.characters.length>40)return "story_map.characters must be an array with at most 40 items";
  const characterIds=new Set();
  for(let i=0;i<storyMap.characters.length;i++){
    const character=storyMap.characters[i];
    if(!character||typeof character!=="object"||typeof character.id!=="string"||!/^[a-zA-Z0-9_-]{1,32}$/.test(character.id))return `story_map.characters[${i}].id must be a stable 1-32 character identifier`;
    if(characterIds.has(character.id))return `story_map.characters[${i}].id must be unique`;
    characterIds.add(character.id);
    if(typeof character.name!=="string"||!character.name.trim()||character.name.length>120)return `story_map.characters[${i}].name must be a non-empty string of at most 120 characters`;
    if(typeof character.role_my!=="string"||!character.role_my.trim()||character.role_my.length>500)return `story_map.characters[${i}].role_my must be a non-empty string of at most 500 characters`;
    if(!Number.isSafeInteger(character.first_seen_ms)||character.first_seen_ms<0||character.first_seen_ms>maxEvidenceTime)return `story_map.characters[${i}].first_seen_ms is outside the supplied evidence timeline`;
    if(!Array.isArray(character.evidence)||character.evidence.length===0||character.evidence.length>10||character.evidence.some(x=>typeof x!=="string"||!x.trim()||x.length>500))return `story_map.characters[${i}].evidence must contain 1-10 non-empty evidence strings`;
  }
  const arc=storyMap.story_arc;
  if(!arc||typeof arc!=="object"||Array.isArray(arc))return "story_map.story_arc must be an object";
  for(const field of ["opening_my","central_conflict_my","climax_my","resolution_my"])if(typeof arc[field]!=="string"||arc[field].length>1500)return `story_map.story_arc.${field} must be a string of at most 1500 characters`;
  if(!Array.isArray(arc.turning_points)||arc.turning_points.length>20)return "story_map.story_arc.turning_points must be an array with at most 20 items";
  for(let i=0;i<arc.turning_points.length;i++){
    const point=arc.turning_points[i];
    if(!point||typeof point!=="object"||!Number.isSafeInteger(point.start_ms)||point.start_ms<0||point.start_ms>maxEvidenceTime)return `story_map.story_arc.turning_points[${i}].start_ms is outside the supplied evidence timeline`;
    if(typeof point.summary_my!=="string"||!point.summary_my.trim()||point.summary_my.length>1200)return `story_map.story_arc.turning_points[${i}].summary_my must be a non-empty string of at most 1200 characters`;
    if(!Array.isArray(point.evidence)||point.evidence.length===0||point.evidence.length>10||point.evidence.some(x=>typeof x!=="string"||!x.trim()||x.length>500))return `story_map.story_arc.turning_points[${i}].evidence must contain 1-10 non-empty evidence strings`;
  }
  if(!Array.isArray(result.events)||result.events.length>500)return "events must be an array with at most 500 items";
  if(!Array.isArray(result.uncertainties)||result.uncertainties.length>100)return "uncertainties must be an array with at most 100 strings";
  for(let i=0;i<result.uncertainties.length;i++)if(typeof result.uncertainties[i]!=="string"||result.uncertainties[i].length>1000)return `uncertainties[${i}] must be a string of at most 1000 characters`;
  let previousStart=-1;
  for(let i=0;i<result.events.length;i++){
    const event=result.events[i];
    if(!event||typeof event!=="object"||!Number.isSafeInteger(event.start_ms)||!Number.isSafeInteger(event.end_ms))return `events[${i}].start_ms and end_ms must be integer milliseconds`;
    if(event.start_ms<0||event.end_ms<=event.start_ms||event.end_ms>maxEvidenceTime)return `events[${i}] timestamp is outside the supplied evidence timeline`;
    if(event.start_ms<previousStart)return `events[${i}] is not in chronological order`;
    if(typeof event.summary_my!=="string"||!event.summary_my.trim()||event.summary_my.length>3000)return `events[${i}].summary_my must be a non-empty string of at most 3000 characters`;
    if(typeof event.cause_my!=="string"||!event.cause_my.trim()||event.cause_my.length>1200)return `events[${i}].cause_my must be a non-empty string of at most 1200 characters`;
    if(typeof event.consequence_my!=="string"||!event.consequence_my.trim()||event.consequence_my.length>1200)return `events[${i}].consequence_my must be a non-empty string of at most 1200 characters`;
    if(!Array.isArray(event.character_ids)||event.character_ids.length>12||event.character_ids.some(id=>typeof id!=="string"||!characterIds.has(id)))return `events[${i}].character_ids must contain only known character IDs`;
    if(!Array.isArray(event.evidence)||event.evidence.length===0||event.evidence.length>20||event.evidence.some(x=>typeof x!=="string"||!x.trim()||x.length>500))return `events[${i}].evidence must contain 1-20 non-empty evidence strings`;
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
  const segments=input.transcript_segments===undefined?[]:input.transcript_segments;
  if(!Array.isArray(segments)||segments.length>2000)return "transcript_segments must be an array with at most 2000 items";
  let previous=-1,total=0;
  for(const s of segments){
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
  if(segments.length===0&&(!Array.isArray(input.frames)||input.frames.length===0))
    return "At least one transcript segment or sampled video frame is required";
  return null;
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method==="GET"&&path==="/health")return reply({status:"online",version:"0.28-prototype",mode:"integrated-prototype",analysis_contract:"story-map-v1",capabilities:["audio-transcription","transcript-plus-sampled-frames","visual-only-recap","character-ledger","cause-and-effect-story-map"],ai_configured:Boolean(env.APP_TOKEN&&env.GEMINI_API_KEY)});
    if(request.method!=="POST"||path!=="/api/analyze-evidence")return reply({error:"Not found"},404);
    if(!env.APP_TOKEN||!env.GEMINI_API_KEY)return reply({error:"Server not configured"},503);
    if(request.headers.get("authorization")!==`Bearer ${env.APP_TOKEN}`)return reply({error:"Unauthorized"},401);
    const length=Number(request.headers.get("content-length")||0);
    if(length>MAX_BODY)return reply({error:"Request too large"},413);
    let input;
    try{const raw=await request.text();if(raw.length>MAX_BODY)return reply({error:"Request too large"},413);input=JSON.parse(raw);}
    catch{return reply({error:"Invalid JSON"},400);}
    const error=validate(input);if(error)return reply({error},400);
    const transcriptSegments=input.transcript_segments||[];
    const evidenceMode=transcriptSegments.length>0?"audio_and_visual":"visual_only";
    const transcript=transcriptSegments.map(s=>`[${s.start_ms}-${s.end_ms} ms] ${s.text}`).join("\\n");
    const instructions=[
      "You are a careful movie story analyst and a professional Burmese recap narrator.",
      "Evidence mode: "+evidenceMode+".",
      "If evidence mode is visual_only, there is no reliable speech transcript. Describe only clearly visible people, objects, and actions in timestamp order. Do not invent dialogue, names, relationships, motives, off-screen causes, or an unseen ending. If the visual evidence is too sparse to support a plot, produce a concise visual recap and record the limits in uncertainties.",
      "If evidence mode is audio_and_visual, combine the timestamped transcript with the sampled frames, but do not let dialogue claims override contradictory visual evidence without noting the conflict.",
      "Build an evidence-grounded story map before writing the final narration. Do this analysis silently; output only the required structured result, not private reasoning.",
      "STEP 1 — CHARACTER LEDGER: identify each distinct person or speaking character, keep identities separate, record roles and relationships only when supported, and assign a stable unique id such as c1 or c2. Never merge characters because names or voices sound similar.",
      "For each character, first_seen_ms is the earliest supplied timestamp supporting that identity. Include 1-10 short evidence references. If a character cannot be identified confidently, omit them and record the uncertainty.",
      "STEP 2 — CHRONOLOGY: reconstruct the order of supported events from timestamped dialogue and supplied frames. Do not confuse the order in which dialogue mentions something with the time it happened.",
      "STEP 3 — CAUSE AND EFFECT: for every event, state its supported cause and consequence. If either link is unknown, say မသေချာပါ rather than inventing a motive, relationship, action, or outcome.",
      "STEP 4 — STORY ARC: identify the opening situation, central conflict, turning points, climax, and resolution only where evidence supports them. Empty strings are allowed for unsupported arc fields; never force a complete ending when the evidence stops earlier.",
      "STEP 5 — VISUAL CROSS-CHECK: transcript is audio/dialogue evidence. Frames are sparse still-image evidence, not the whole movie. A still frame cannot prove motion or an unseen action. Do not claim full-video visual analysis.",
      "STEP 6 — BURMESE NARRATION: write fluent, natural Myanmar storytelling with clear transitions, correct character continuity, and chronological cause-and-effect. Preserve names when known. Avoid repetitive openings, generic filler, frame-by-frame captions, and unsupported details.",
      "Keep narration suitable for a 45–60 second voiceover and at most 1400 Unicode characters so the existing Android voice/export pipeline remains compatible.",
      "Return 6–16 chronological key story events only when the evidence supports them; fewer events are better than invented events.",
      "Return JSON matching the required response schema exactly. Use integer milliseconds for all timestamps. Every event must include summary_my, cause_my, consequence_my, character_ids, and 1-20 concise evidence strings.",
      "Every character and turning point must include evidence. Every event character_ids entry must refer to an id in story_map.characters.",
      "Keep event timestamps within the supplied evidence timeline and order events chronologically. Keep the story map and narration consistent with the events.",
      "If evidence conflicts, distinguish a character claim from a verified event and add the conflict to uncertainties.",
      "Timestamped transcript (empty means no speech transcript is available):\\n"+(transcript||"[No speech transcript supplied; use visual evidence only.]")
    ].join("\\n");
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
      const result=await fetchWithTransientRetry(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,{
        method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
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
        const secondary=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent`,{
          method:"POST",signal:AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
          headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
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
    return reply({version:"0.29-prototype",analysis_contract:"story-map-v1",evidence_mode:evidenceMode,model:activeModel,fallback_used,fallback_models_tried,primary_network_error,fallback_network_errors,mode:evidenceMode==="visual_only"?"story-map-visual-only":"story-map-transcript-plus-sampled-frames",audio_analyzed_from:transcriptSegments.length>0?"client_supplied_transcript":"none",...result});
  }
};
