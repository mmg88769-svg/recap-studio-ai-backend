import test from "node:test";
import assert from "node:assert/strict";
import worker from "../experimental/worker-v028-evidence.js";
import appWorker from "../worker.js";
const url="https://example.test/api/analyze-evidence";
const env={APP_TOKEN:"test-token",GEMINI_API_KEY:"test-key"};
const valid={transcript_segments:[{start_ms:0,end_ms:3000,text:"He entered the room and asked for help."}]};
const post=(data,token="test-token")=>new Request(url,{method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(data)});
test("rejects missing authorization before parsing",async()=>{const r=await worker.fetch(post(valid,"bad"),env);assert.equal(r.status,401)});
test("rejects missing transcript",async()=>{const r=await worker.fetch(post({transcript_segments:[]}),env);assert.equal(r.status,400)});
test("rejects invalid timestamps",async()=>{const r=await worker.fetch(post({transcript_segments:[{start_ms:4,end_ms:2,text:"a"}]}),env);assert.equal(r.status,400)});
test("rejects more than eight frames",async()=>{const r=await worker.fetch(post({...valid,frames:Array.from({length:9},(_,i)=>({time_ms:i,jpeg_base64:"YWJj"}))}),env);assert.equal(r.status,400)});
test("returns 429 without pretending success",async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"quota"}}),{status:429});
  try{const r=await worker.fetch(post(valid),env);assert.equal(r.status,429);assert.equal((await r.json()).retryable,true)}finally{globalThis.fetch=previous}
});
test("returns structured grounded recap",async()=>{
  const previous=globalThis.fetch;let payload,providerUrl;
  globalThis.fetch=async(_url,opts)=>{providerUrl=_url;payload=JSON.parse(opts.body);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200})};
  try{
    const r=await worker.fetch(post(valid),env);assert.equal(r.status,200);
    const body=await r.json();assert.equal(body.mode,"transcript-plus-sampled-frames");
    assert.equal(body.audio_analyzed_from,"client_supplied_transcript");
    assert.ok(providerUrl.includes("models/gemini-3.8-flash"));
    assert.equal(body.model,"gemini-3.8-flash");
    assert.match(payload.contents[0].parts[0].text,/chronological Burmese movie recap/);
  }finally{globalThis.fetch=previous}
});


test("surfaces safe Gemini provider diagnostics on model-access failures",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"Model access is restricted"}}),{status:403});
  try{
    const r=await worker.fetch(post(valid),env);assert.equal(r.status,502);
    const body=await r.json();assert.equal(body.provider_status,403);
    assert.match(body.detail,/restricted/);
    assert.equal(body.model,"gemini-3.8-flash");
  }finally{globalThis.fetch=previous}
});

test("rejects AI events outside supplied evidence timeline",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    narration_my:"ဇာတ်လမ်း",events:[{start_ms:10000,end_ms:12000,summary_my:"Invented scene",evidence:["unverified"]}],uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);
    assert.equal(r.status,502);
    assert.match((await r.json()).error,/invalid recap structure/);
  }finally{globalThis.fetch=previous}
});
test("rejects AI events without evidence references",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    narration_my:"ဇာတ်လမ်း",events:[{start_ms:0,end_ms:2000,summary_my:"Claim",evidence:[]}],uncertainties:[]
  })}]}}]}),{status:200});
  try{assert.equal((await worker.fetch(post(valid),env)).status,502)}
  finally{globalThis.fetch=previous}
});

test("production worker exposes protected v0.28 health route",async()=>{
  const r=await appWorker.fetch(new Request("https://example.test/health"),env);
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.version,"0.28-prototype");
  assert.equal(body.mode,"integrated-prototype");
  assert.ok(body.capabilities.includes("audio-transcription"));
  assert.equal(body.ai_configured,true);
});
test("production worker routes evidence endpoint through token guard",async()=>{
  const request=new Request("https://example.test/api/analyze-evidence",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer wrong"},body:JSON.stringify(valid)
  });
  assert.equal((await appWorker.fetch(request,env)).status,401);
});
test("production worker routes audio transcription endpoint through token guard",async()=>{
  const request=new Request("https://example.test/api/transcribe-audio",{
    method:"POST",headers:{"content-type":"application/json",authorization:"Bearer wrong"},body:JSON.stringify({mime_type:"audio/wav",audio_base64:"YWJj"})
  });
  assert.equal((await appWorker.fetch(request,env)).status,401);
});

test("production worker generates Burmese WAV through Free Tier Gemini TTS",async()=>{
  const previous=globalThis.fetch;
  const wav=Buffer.alloc(44);wav.write("RIFF",0);wav.write("WAVE",8);
  let target,payload;
  globalThis.fetch=async(url,options)=>{
    target=url;payload=JSON.parse(options.body);
    return new Response(JSON.stringify({output_audio:{data:wav.toString("base64"),mime_type:"audio/wav"}}),{status:200});
  };
  try{
    const request=new Request("https://example.test/api/tts",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my",gender:"male",style:"cinematic"})
    });
    const response=await appWorker.fetch(request,env);
    assert.equal(response.status,200);
    assert.equal(response.headers.get("content-type"),"audio/wav");
    assert.equal(target,"https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(payload.model,"gemini-3.8-flash-tts");
    assert.ok(payload.input[0].content[0].annotations[0].style.includes("Burmese"));
    assert.ok(payload.generation_config.speech_config[0].voice);
  }finally{globalThis.fetch=previous}
});
test("production worker surfaces Gemini TTS free-tier quota without retrying",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"quota"}}),{status:429});
  try{
    const request=new Request("https://example.test/api/tts",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my"})
    });
    const response=await appWorker.fetch(request,env);
    assert.equal(response.status,429);
    assert.equal((await response.json()).retryable,true);
  }finally{globalThis.fetch=previous}
});
