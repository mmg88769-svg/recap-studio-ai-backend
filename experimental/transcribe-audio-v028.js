// Isolated W.H.K audio transcription prototype. Not deployed or wired into Android.
// Short audio clips only. No persistent storage. Never put API keys in the app.
const MAX_BASE64=2_800_000;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const MIME=new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/mp4","audio/aac","audio/ogg","audio/webm"]);
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
  let response;
  try{
   response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",{
    method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{role:"user",parts:[{text:instruction},{inline_data:{mime_type:input.mime_type,data:input.audio_base64}}]}],generationConfig:{responseMimeType:"application/json",temperature:0,maxOutputTokens:8192}})
   });
  }catch{return json({error:"AI provider unreachable",retryable:true},503)}
  if(response.status===429)return json({error:"AI quota exceeded",retryable:true,retry_after_seconds:60},429);
  if(!response.ok)return json({error:"AI provider failed",provider_status:response.status,retryable:response.status>=500},502);
  let body;try{body=await response.json()}catch{return json({error:"Invalid AI response"},502)}
  const text=(body?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("").trim();
  try{
   const parsed=JSON.parse(text);
   if(!Array.isArray(parsed.segments)||!Array.isArray(parsed.uncertainties)||parsed.segments.length>500)throw Error("shape");
   for(const s of parsed.segments){
    if(!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.end_ms<=s.start_ms||typeof s.text!=="string"||typeof s.language!=="string")throw Error("segment");
   }
   return json({version:"0.28-prototype",timestamp_basis:"clip-relative",transcript_segments:parsed.segments,uncertainties:parsed.uncertainties});
  }catch{return json({error:"Invalid transcription structure"},502)}
 }
};
