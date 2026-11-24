import test from "node:test";
import assert from "node:assert/strict";
import worker from "../experimental/worker-v028-evidence.js";
import appWorker from "../worker.js";
const url="https://example.test/api/analyze-evidence";
const env={APP_TOKEN:"test-token",GEMINI_API_KEY:"test-key"};
const valid={transcript_segments:[{start_ms:0,end_ms:3000,text:"He entered the room and asked for help."}]};
const post=(data,token="test-token")=>new Request(url,{method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(data)});
const emptyStoryMap=()=>({characters:[],story_arc:{opening_my:"",central_conflict_my:"",turning_points:[],climax_my:"",resolution_my:""}});
const emptyRecap=(narration="ဇာတ်လမ်း",events=[])=>({narration_my:narration,story_map:emptyStoryMap(),events,uncertainties:[]});
test("rejects missing authorization before parsing",async()=>{const r=await worker.fetch(post(valid,"bad"),env);assert.equal(r.status,401)});
test("rejects missing transcript",async()=>{const r=await worker.fetch(post({transcript_segments:[]}),env);assert.equal(r.status,400)});
test("rejects invalid timestamps",async()=>{const r=await worker.fetch(post({transcript_segments:[{start_ms:4,end_ms:2,text:"a"}]}),env);assert.equal(r.status,400)});
test("rejects more than eight frames",async()=>{const r=await worker.fetch(post({...valid,frames:Array.from({length:9},(_,i)=>({time_ms:i,jpeg_base64:"YWJj"}))}),env);assert.equal(r.status,400)});
test("tries bounded model-specific fallbacks on evidence 429 without retrying the same model",async()=>{
  const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"quota exhausted"}}),{status:429})};
  try{const r=await worker.fetch(post(valid),env);const body=await r.json();assert.equal(r.status,429);assert.equal(calls,3);assert.equal(body.provider_status,429);assert.equal(body.model,"gemini-3.1-flash-lite");assert.equal(body.fallback_used,true);assert.equal(body.fallback_models_tried.length,2)}finally{globalThis.fetch=previous}
});
test("retries transient Gemini 503 evidence overload and succeeds",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return calls<3?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200})};
  try{const r=await worker.fetch(post(valid),env);assert.equal(r.status,200);assert.equal(calls,3);assert.equal((await r.json()).narration_my,"ဇာတ်လမ်း")}finally{globalThis.fetch=previous}
});
test("reports the final retry count after repeated Gemini 503 evidence failures",async()=>{
  const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"high demand"}}),{status:503})};
  try{const r=await worker.fetch(post(valid),env);const body=await r.json();assert.equal(r.status,502);assert.equal(calls,5);assert.equal(body.attempts,5);assert.equal(body.retryable,true);assert.equal(body.provider_status,503);assert.equal(body.model,"gemini-3.1-flash-lite")}finally{globalThis.fetch=previous}
});
test("returns structured grounded recap",async()=>{
  const previous=globalThis.fetch;let payload,providerUrl;
  globalThis.fetch=async(_url,opts)=>{providerUrl=_url;payload=JSON.parse(opts.body);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200})};
  try{
    const r=await worker.fetch(post(valid),env);assert.equal(r.status,200);
    const body=await r.json();assert.equal(body.mode,"story-map-transcript-plus-sampled-frames");
    assert.equal(body.analysis_contract,"story-map-v1");
    assert.deepEqual(body.story_map.characters,[]);
    assert.equal(body.audio_analyzed_from,"client_supplied_transcript");
    assert.ok(providerUrl.includes("models/gemini-3.8-flash"));
    assert.equal(body.model,"gemini-3.8-flash");
    assert.match(payload.contents[0].parts[0].text,/CHARACTER LEDGER/);
    assert.match(payload.contents[0].parts[0].text,/CAUSE AND EFFECT/);
    assert.match(payload.contents[0].parts[0].text,/natural Myanmar storytelling/);
    assert.equal(payload.generationConfig.responseMimeType,"application/json");
    assert.deepEqual(payload.generationConfig.responseSchema.required,["narration_my","story_map","events","uncertainties"]);
    assert.ok(payload.generationConfig.responseSchema.properties.story_map);
    assert.ok(payload.generationConfig.responseSchema.properties.events.items.required.includes("character_ids"));
    assert.equal(payload.generationConfig.responseSchema.properties.events.items.properties.start_ms.type,"INTEGER");
  }finally{globalThis.fetch=previous}
});


test("surfaces safe Gemini provider diagnostics on model-access failures",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"Model access is restricted"}}),{status:403});
  try{
    const r=await worker.fetch(post(valid),env);assert.equal(r.status,502);
    const body=await r.json();assert.equal(body.provider_status,403);
    assert.match(body.error,/HTTP 403/);
    assert.match(body.detail,/restricted/);
    assert.equal(body.model,"gemini-3.8-flash");
  }finally{globalThis.fetch=previous}
});

test("rejects AI events outside supplied evidence timeline",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    ...emptyRecap("ဇာတ်လမ်း",[{start_ms:10000,end_ms:12000,summary_my:"Invented scene",cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:[],evidence:["unverified"]}])
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);
    assert.equal(r.status,502);
    const body=await r.json();
    assert.match(body.error,/invalid recap structure/);
    assert.match(body.validation_error,/outside the supplied evidence timeline/);
  }finally{globalThis.fetch=previous}
});
test("rejects AI events without evidence references",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    ...emptyRecap("ဇာတ်လမ်း",[{start_ms:0,end_ms:2000,summary_my:"Claim",cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:[],evidence:[]}])
  })}]}}]}),{status:200});
  try{assert.equal((await worker.fetch(post(valid),env)).status,502)}
  finally{globalThis.fetch=previous}
});

test("production worker exposes protected v0.29 health route",async()=>{
  const r=await appWorker.fetch(new Request("https://example.test/health"),env);
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.version,"0.29-prototype");
  assert.equal(body.mode,"integrated-prototype");
  assert.ok(body.capabilities.includes("audio-transcription"));
  assert.ok(body.capabilities.includes("character-ledger"));
  assert.ok(body.capabilities.includes("visual-only-recap"));
  assert.equal(body.analysis_contract,"story-map-v1");
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
    return new Response(JSON.stringify({steps:[{type:"model_output",content:[{type:"audio",data:wav.toString("base64"),mime_type:"audio/wav"}]}]}),{status:200});
  };
  try{
    const request=new Request("https://example.test/api/tts",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my",gender:"male",style:"cinematic"})
    });
    const response=await appWorker.fetch(request,env);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get("content-type"),"audio/wav");
    assert.equal(target,"https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(payload.model,"gemini-3.8-flash-tts");
    assert.ok(payload.input[0].content[0].annotations[0].style.includes("Burmese"));
    assert.deepEqual(payload.generation_config.speech_config,[{voice:"Charon"}]);
  }finally{globalThis.fetch=previous}
});
test("production worker retries transient Gemini TTS 503 and returns Burmese WAV",async()=>{
  const previous=globalThis.fetch;let calls=0;
  const wav=Buffer.alloc(44);wav.write("RIFF",0);wav.write("WAVE",8);
  globalThis.fetch=async()=>{calls++;return calls<3?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):new Response(JSON.stringify({steps:[{type:"model_output",content:[{type:"audio",data:wav.toString("base64"),mime_type:"audio/wav"}]}]}),{status:200})};
  try{
    const request=new Request("https://example.test/api/tts",{method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my"})});
    const response=await appWorker.fetch(request,env);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"audio/wav");assert.equal(calls,3);
  }finally{globalThis.fetch=previous}
});
test("production worker switches to free-tier Lite TTS after persistent 503",async()=>{
  const previous=globalThis.fetch;let calls=0;const models=[];
  const wav=Buffer.alloc(44);wav.write("RIFF",0);wav.write("WAVE",8);
  globalThis.fetch=async(url,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    models.push(body.model);
    return calls<=3
      ? new Response(JSON.stringify({error:{message:"high demand"}}),{status:503})
      : new Response(JSON.stringify({steps:[{type:"model_output",content:[{type:"audio",data:wav.toString("base64"),mime_type:"audio/wav"}]}]}),{status:200});
  };
  try{
    const request=new Request("https://example.test/api/tts",{method:"POST",
      headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my",gender:"female"})});
    const result=await appWorker.fetch(request,env);
    assert.equal(result.status,200);
    assert.equal(result.headers.get("content-type"),"audio/wav");
    assert.equal(result.headers.get("x-whk-voice-model"),"gemini-3.8-flash-lite-tts");
    assert.equal(result.headers.get("x-whk-voice-fallback"),"true");
    assert.equal(calls,4);
    assert.deepEqual(models,["gemini-3.8-flash-tts","gemini-3.8-flash-tts",
      "gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]);
  }finally{globalThis.fetch=previous}
});
test("production worker does not use Lite fallback for TTS access errors",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"model access restricted"}}),{status:403})};
  try{
    const request=new Request("https://example.test/api/tts",{method:"POST",
      headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my"})});
    const result=await appWorker.fetch(request,env);
    const body=await result.json();
    assert.equal(result.status,502);
    assert.equal(body.provider_status,403);
    assert.equal(calls,1);
    assert.equal(body.fallback_used,false);
  }finally{globalThis.fetch=previous}
});
test("production worker tries Lite TTS once when primary model has a 429 quota limit",async()=>{
  const previous=globalThis.fetch;let calls=0;const models=[];
  globalThis.fetch=async(_url,options)=>{
    calls++;models.push(JSON.parse(options.body).model);
    return new Response(JSON.stringify({error:{message:"quota exhausted"}}),{status:429});
  };
  try{
    const request=new Request("https://example.test/api/tts",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my"})
    });
    const response=await appWorker.fetch(request,env);const body=await response.json();
    assert.equal(response.status,429);assert.equal(calls,2);
    assert.deepEqual(models,["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]);
    assert.equal(body.fallback_used,true);assert.equal(body.model,"gemini-3.8-flash-lite-tts");
  }finally{globalThis.fetch=previous}
});

test("uses second free-tier Lite model for transcript and frames after repeated overload",async()=>{
 const old=globalThis.fetch;let calls=0;const urls=[];
 globalThis.fetch=async url=>{calls++;urls.push(url);
  return calls<=4?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):
   new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200});
 };
 try{const r=await worker.fetch(post(valid),env);const j=await r.json();assert.equal(r.status,200);assert.equal(calls,5);assert.equal(j.model,"gemini-3.1-flash-lite");assert.equal(j.fallback_used,true);assert.ok(urls[3].includes("gemini-3.5-flash-lite"));assert.ok(urls[4].includes("gemini-3.1-flash-lite"))}finally{globalThis.fetch=old}
});

const legacyReq = (path, data, token="test-token") =>
  new Request("https://example.test"+path,{
    method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify(data)
  });
test("legacy recap retries 503 then uses first free-tier text fallback",async()=>{
  const previous=globalThis.fetch;let calls=0,urls=[];
  globalThis.fetch=async url=>{
    calls++;urls.push(url);
    return calls<=3
      ? new Response(JSON.stringify({error:{message:"high demand"}}),{status:503})
      : new Response(JSON.stringify({candidates:[{content:{parts:[{text:"မြန်မာဇာတ်လမ်း အကျဉ်းချုပ်"}]}}]}),{status:200});
  };
  try{
    const r=await appWorker.fetch(legacyReq("/api/recap",{transcript:"A long dialogue source text for the story."}),env);
    const body=await r.json();
    assert.equal(r.status,200);assert.match(body.script,/မြန်မာ/);
    assert.equal(calls,4);assert.ok(urls[3].includes("gemini-3.5-flash-lite"));
  }finally{globalThis.fetch=previous}
});
test("legacy recap tries bounded Lite model fallbacks on model-specific 429 quota",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"quota exhausted"}}),{status:429})};
  try{
    const r=await appWorker.fetch(legacyReq("/api/recap",{transcript:"A long dialogue source text for the story."}),env);
    const body=await r.json();
    assert.equal(r.status,429);assert.equal(body.status,429);
    assert.equal(calls,3);assert.equal(body.fallback_used,true);
    assert.equal(body.model,"gemini-3.1-flash-lite");
  }finally{globalThis.fetch=previous}
});
test("legacy translation tries both free-tier fallback models after persistent overload",async()=>{
  const previous=globalThis.fetch;let calls=0,urls=[];
  globalThis.fetch=async url=>{
    calls++;urls.push(url);
    return calls<=4?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):
      new Response(JSON.stringify({candidates:[{content:{parts:[{text:"A translation."}]}}]}),{status:200});
  };
  try{
    const r=await appWorker.fetch(legacyReq("/api/translate",{text:"This is a story recap.",language:"en"}),env);
    const body=await r.json();
    assert.equal(r.status,200);assert.equal(body.translation,"A translation.");
    assert.equal(calls,5);assert.ok(urls[3].includes("gemini-3.5-flash-lite"));
    assert.ok(urls[4].includes("gemini-3.1-flash-lite"));
  }finally{globalThis.fetch=previous}
});
test("legacy text generation surfaces fallback model if all providers overloaded",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"overloaded"}}),{status:503})};
  try{
    const r=await appWorker.fetch(legacyReq("/api/recap",{transcript:"A long dialogue source text for the story."}),env);
    const body=await r.json();
    assert.equal(r.status,502);assert.equal(body.status,503);
    assert.equal(body.model,"gemini-3.1-flash-lite");assert.equal(body.fallback_used,true);
    assert.equal(body.attempts,5);assert.equal(calls,5);
  }finally{globalThis.fetch=previous}
});

test("evidence analysis succeeds on Lite fallback when primary model has 429 quota",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return calls===1
    ? new Response(JSON.stringify({error:{message:"primary quota"}}),{status:429})
    : new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200})};
  try{const r=await worker.fetch(post(valid),env);const body=await r.json();assert.equal(r.status,200);assert.equal(calls,2);assert.equal(body.model,"gemini-3.5-flash-lite");assert.equal(body.fallback_used,true)}finally{globalThis.fetch=previous}
});

test("legacy recap succeeds on Lite model when primary model returns 429",async()=>{
  const previous=globalThis.fetch;let calls=0,urls=[];
  globalThis.fetch=async url=>{calls++;urls.push(url);
    return calls===1?new Response(JSON.stringify({error:{message:"primary quota"}}),{status:429}):
      new Response(JSON.stringify({candidates:[{content:{parts:[{text:"မြန်မာဇာတ်လမ်း အကျဉ်းချုပ်"}]}}]}),{status:200});
  };
  try{
    const r=await appWorker.fetch(legacyReq("/api/recap",{transcript:"A long dialogue source text for the story."}),env);
    const body=await r.json();assert.equal(r.status,200);assert.match(body.script,/မြန်မာ/);
    assert.equal(calls,2);assert.ok(urls[1].includes("gemini-3.5-flash-lite"));
  }finally{globalThis.fetch=previous}
});

test("evidence Cloudflare 524 triggers bounded Lite fallback",async()=>{
 const previous=globalThis.fetch;let calls=0,urls=[];
 globalThis.fetch=async(url,options)=>{
  calls++;urls.push(url);assert.ok(options.signal instanceof AbortSignal);
  return calls<=3
    ? new Response("<html>Origin timed out</html>",{status:524})
    : new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200});
 };
 try{const r=await worker.fetch(post(valid),env);const b=await r.json();
  assert.equal(r.status,200);assert.equal(calls,4);
  assert.equal(b.model,"gemini-3.5-flash-lite");assert.equal(b.fallback_used,true);
  assert.ok(urls[3].includes("gemini-3.5-flash-lite"));
 }finally{globalThis.fetch=previous}
});
test("evidence primary network timeouts still allow Lite fallback",async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,options)=>{
  calls++;assert.ok(options.signal instanceof AbortSignal);
  if(calls<=3)throw Object.assign(new Error("Upstream timed out"),{name:"TimeoutError"});
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap())}]}}]}),{status:200});
 };
 try{const r=await worker.fetch(post(valid),env);const b=await r.json();
  assert.equal(r.status,200);assert.equal(calls,4);assert.equal(b.fallback_used,true);
 }finally{globalThis.fetch=previous}
});
test("evidence persistent Cloudflare 524 is reported after five bounded calls",async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,options)=>{calls++;assert.ok(options.signal instanceof AbortSignal);return new Response("<html>524</html>",{status:524})};
 try{const r=await worker.fetch(post(valid),env);const b=await r.json();
  assert.equal(r.status,502);assert.equal(calls,5);assert.equal(b.provider_status,524);assert.equal(b.attempts,5);assert.equal(b.retryable,true);
 }finally{globalThis.fetch=previous}
});

test("reports the exact invalid recap field instead of a generic validation error",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    ...emptyRecap("ဇာတ်လမ်း",[{start_ms:0,end_ms:1000,summary_my:"Scene",cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:[],evidence:[]}])
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.equal(body.validation_error,"events[0].evidence must contain 1-20 non-empty evidence strings");
  }finally{globalThis.fetch=previous}
});
test("accepts valid JSON wrapped in a markdown JSON fence",async()=>{
  const previous=globalThis.fetch;
  const recap=emptyRecap();
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:"```json\n"+JSON.stringify(recap)+"\n```"}]}}]}),{status:200});
  try{const r=await worker.fetch(post(valid),env);assert.equal(r.status,200);assert.equal((await r.json()).narration_my,"ဇာတ်လမ်း")}
  finally{globalThis.fetch=previous}
});


test("evidence fallback keeps real network diagnostics and continues to the next Lite model",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls<=3)return new Response(JSON.stringify({error:{message:"primary overloaded"}}),{status:503});
    if(calls===4)throw Object.assign(new Error("connect ECONNRESET"),{name:"NetworkError"});
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
      ...emptyRecap("မြန်မာဇာတ်လမ်း")
    })}]}}]}),{status:200});
  };
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,200);assert.equal(calls,5);
    assert.equal(body.model,"gemini-3.1-flash-lite");
    assert.equal(body.fallback_used,true);
    assert.deepEqual(body.fallback_models_tried,["gemini-3.5-flash-lite","gemini-3.1-flash-lite"]);
    assert.equal(body.fallback_network_errors[0].name,"NetworkError");
    assert.equal(body.fallback_network_errors[0].message,"connect ECONNRESET");
  }finally{globalThis.fetch=previous}
});

test("evidence reports the actual final fallback network error instead of a generic unreachable message",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls<=3)return new Response(JSON.stringify({error:{message:"primary overloaded"}}),{status:503});
    if(calls===4)throw Object.assign(new Error("connect ECONNRESET"),{name:"NetworkError"});
    throw Object.assign(new Error("The operation was aborted"),{name:"TimeoutError"});
  };
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);assert.equal(calls,5);
    assert.equal(body.provider_status,503);
    assert.equal(body.model,"gemini-3.1-flash-lite");
    assert.match(body.detail,/TimeoutError/);
    assert.match(body.detail,/The operation was aborted/);
    assert.equal(body.fallback_network_errors.length,2);
    assert.equal(body.fallback_network_errors[0].message,"connect ECONNRESET");
    assert.equal(body.fallback_network_errors[1].name,"TimeoutError");
    assert.deepEqual(body.fallback_models_tried,["gemini-3.5-flash-lite","gemini-3.1-flash-lite"]);
  }finally{globalThis.fetch=previous}
});

test("invalid recap error includes the exact validation failure for the Android client",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    ...emptyRecap("ဇာတ်လမ်း",[{start_ms:0,end_ms:1000,summary_my:"Scene",cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:[],evidence:[]}])
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.ok(body.error.includes("events[0].evidence must contain"));
    assert.equal(body.error, "AI returned invalid recap structure: events[0].evidence must contain 1-20 non-empty evidence strings");
  }finally{globalThis.fetch=previous}
});

test("rejects events that reference a character missing from the story map",async()=>{
  const previous=globalThis.fetch;
  const recap=emptyRecap("ဇာတ်လမ်း",[{start_ms:0,end_ms:2000,summary_my:"Scene",cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:["unknown"],evidence:["dialogue"]}]);
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(recap)}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.equal(body.validation_error,"events[0].character_ids must contain only known character IDs");
  }finally{globalThis.fetch=previous}
});

test("rejects character first-seen timestamps outside supplied evidence",async()=>{
  const previous=globalThis.fetch;
  const recap=emptyRecap();
  recap.story_map.characters=[{id:"c1",name:"A",role_my:"ဇာတ်ကောင်",first_seen_ms:5000,evidence:["dialogue"]}];
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(recap)}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.match(body.validation_error,/first_seen_ms is outside the supplied evidence timeline/);
  }finally{globalThis.fetch=previous}
});

test("requires the story map contract before returning a recap",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.equal(body.validation_error,"story_map must be an object");
  }finally{globalThis.fetch=previous}
});

test("rejects narration longer than the Android voice input limit",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(emptyRecap("က".repeat(1401)))}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.equal(body.validation_error,"narration_my must be a non-empty string of at most 1400 characters");
  }finally{globalThis.fetch=previous}
});

test("supports visual-only recap when no speech transcript is available",async()=>{
  const previous=globalThis.fetch;let prompt="";
  const visualRecap=emptyRecap("မြင်ရသောအဖြစ်အပျက်",[{
    start_ms:1000,end_ms:2000,summary_my:"မြင်ကွင်းတွင် လူတစ်ဦး လမ်းလျှောက်နေသည်",
    cause_my:"မသေချာပါ",consequence_my:"မသေချာပါ",character_ids:[],
    evidence:["Sampled frame at 1000 ms","Sampled frame at 2000 ms"]
  }]);
  globalThis.fetch=async(_url,opts)=>{
    prompt=JSON.parse(opts.body).contents[0].parts[0].text;
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(visualRecap)}]}}]}),{status:200});
  };
  try{
    const r=await worker.fetch(post({transcript_segments:[],frames:[
      {time_ms:1000,jpeg_base64:"AAAA"},{time_ms:2000,jpeg_base64:"AAAA"}
    ]}),env);
    const body=await r.json();
    assert.equal(r.status,200);
    assert.equal(body.analysis_contract,"story-map-v1");
    assert.equal(body.evidence_mode,"visual_only");
    assert.equal(body.mode,"story-map-visual-only");
    assert.equal(body.events.length,1);
    assert.match(prompt,/Evidence mode: visual_only/);
    assert.match(prompt,/use visual evidence only/);
  }finally{globalThis.fetch=previous}
});

test("rejects visual-only analysis when no frames are supplied",async()=>{
  const r=await worker.fetch(post({transcript_segments:[],frames:[]}),env);
  assert.equal(r.status,400);
  assert.equal((await r.json()).error,"At least one transcript segment or sampled video frame is required");
});
