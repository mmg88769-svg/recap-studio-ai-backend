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
test("tries bounded model-specific fallbacks on evidence 429 without retrying the same model",async()=>{
  const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"quota exhausted"}}),{status:429})};
  try{const r=await worker.fetch(post(valid),env);const body=await r.json();assert.equal(r.status,429);assert.equal(calls,3);assert.equal(body.provider_status,429);assert.equal(body.model,"gemini-3.1-flash-lite");assert.equal(body.fallback_used,true);assert.equal(body.fallback_models_tried.length,2)}finally{globalThis.fetch=previous}
});
test("retries transient Gemini 503 evidence overload and succeeds",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return calls<3?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200})};
  try{const r=await worker.fetch(post(valid),env);assert.equal(r.status,200);assert.equal(calls,3);assert.equal((await r.json()).narration_my,"ဇာတ်လမ်း")}finally{globalThis.fetch=previous}
});
test("reports the final retry count after repeated Gemini 503 evidence failures",async()=>{
  const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"high demand"}}),{status:503})};
  try{const r=await worker.fetch(post(valid),env);const body=await r.json();assert.equal(r.status,502);assert.equal(calls,5);assert.equal(body.attempts,5);assert.equal(body.retryable,true);assert.equal(body.provider_status,503);assert.equal(body.model,"gemini-3.1-flash-lite")}finally{globalThis.fetch=previous}
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
    assert.match(payload.contents[0].parts[0].text,/Follow the supplied movie timeline in timestamp order/);
    assert.equal(payload.generationConfig.responseMimeType,"application/json");
    assert.deepEqual(payload.generationConfig.responseSchema.required,["narration_my","events","uncertainties"]);
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
    narration_my:"ဇာတ်လမ်း",events:[{start_ms:10000,end_ms:12000,summary_my:"Invented scene",evidence:["unverified"]}],uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);
    assert.equal(r.status,502);
    const body=await r.json();
    assert.match(body.error,/invalid recap structure/);
    assert.match(body.validation_error,/outside the supplied evidence timeline/);
  }finally{globalThis.fetch=previous}
});

test("accepts exact transcript quotes and supplied frame timestamps as event evidence",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    narration_my:"သူ အခန်းထဲ ဝင်လာသည်။",
    events:[{start_ms:0,end_ms:3000,summary_my:"သူ အခန်းထဲ ဝင်လာသည်။",evidence:[
      'DIALOGUE: "He entered the room"',
      "FRAME@1500ms: A person is visible near a doorway"
    ]}],
    uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const request=post({...valid,frames:[{time_ms:1500,jpeg_base64:"YWJj"}]});
    const response=await worker.fetch(request,env);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.events[0].evidence.length,2);
  }finally{globalThis.fetch=previous}
});

test("rejects fabricated dialogue citations that are absent from the transcript",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    narration_my:"သူ ဘုရင်ဖြစ်သွားသည်။",
    events:[{start_ms:0,end_ms:3000,summary_my:"သူ ဘုရင်ဖြစ်သွားသည်။",evidence:[
      'DIALOGUE: "He became the king"'
    ]}],
    uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const response=await worker.fetch(post(valid),env);
    assert.equal(response.status,502);
    const body=await response.json();
    assert.match(body.validation_error,/exact transcript quote/);
  }finally{globalThis.fetch=previous}
});

test("removes unsupported evidence citations when a grounded citation is present",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({
    narration_my:"သူ အခန်းထဲ ဝင်လာသည်။",
    events:[{start_ms:0,end_ms:3000,summary_my:"သူ အခန်းထဲ ဝင်လာသည်။",evidence:[
      'DIALOGUE: "He entered the room"',
      'DIALOGUE: "He was crowned king"'
    ]}],
    uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const response=await worker.fetch(post(valid),env);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(body.events[0].evidence,['DIALOGUE: "He entered the room"']);
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
   new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200});
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
    : new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200})};
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
    : new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200});
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
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]})}]}}]}),{status:200});
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
    narration_my:"ဇာတ်လမ်း",events:[{start_ms:0,end_ms:1000,summary_my:"Scene",evidence:[]}],uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.equal(body.validation_error,"events[0].evidence must contain 1-20 non-empty evidence strings");
  }finally{globalThis.fetch=previous}
});
test("accepts valid JSON wrapped in a markdown JSON fence",async()=>{
  const previous=globalThis.fetch;
  const recap={narration_my:"ဇာတ်လမ်း",events:[],uncertainties:[]};
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
      narration_my:"မြန်မာဇာတ်လမ်း",events:[],uncertainties:[]
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
    narration_my:"ဇာတ်လမ်း",events:[{start_ms:0,end_ms:1000,summary_my:"Scene",evidence:[]}],uncertainties:[]
  })}]}}]}),{status:200});
  try{
    const r=await worker.fetch(post(valid),env);const body=await r.json();
    assert.equal(r.status,502);
    assert.ok(body.error.includes("events[0].evidence must contain"));
    assert.equal(body.error, "AI returned invalid recap structure: events[0].evidence must contain 1-20 non-empty evidence strings");
  }finally{globalThis.fetch=previous}
});

const agentPlatformEnv={
  ...env,
  GEMINI_PROVIDER:"agent-platform",
  GOOGLE_CLOUD_PROJECT_ID:"whk-movie-recap-test",
  AGENT_PLATFORM_API_KEY:"test-agent-platform-key"
};

test("health reports Agent Platform provider when its credentials are configured",async()=>{
  const response=await appWorker.fetch(new Request("https://example.test/health"),agentPlatformEnv);
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.ai_configured,true);
  assert.equal(body.ai_provider,"gemini-enterprise-agent-platform");
  assert.equal(body.ai_provider_location,"global");
});

test("legacy recap routes to Gemini Enterprise Agent Platform global endpoint",async()=>{
  const previous=globalThis.fetch;let target,headers;
  globalThis.fetch=async(url,options)=>{
    target=url;headers=options.headers;
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"မြန်မာဇာတ်လမ်း အကျဉ်းချုပ်"}]}}]}),{status:200});
  };
  try{
    const response=await appWorker.fetch(
      legacyReq("/api/recap",{transcript:"A sufficiently long movie dialogue transcript."}),
      agentPlatformEnv
    );
    const body=await response.json();
    assert.equal(response.status,200);
    assert.match(body.script,/မြန်မာ/);
    assert.equal(target,"https://aiplatform.googleapis.com/v1/projects/whk-movie-recap-test/locations/global/publishers/google/models/gemini-3.8-flash:generateContent");
    assert.equal(headers["x-goog-api-key"],"test-agent-platform-key");
    assert.equal(headers.Authorization,undefined);
  }finally{globalThis.fetch=previous}
});

test("Agent Platform TTS uses generateContent and returns its inline WAV audio",async()=>{
  const previous=globalThis.fetch;
  const wav=Buffer.alloc(44);wav.write("RIFF",0);wav.write("WAVE",8);
  let target,payload,headers;
  globalThis.fetch=async(url,options)=>{
    target=url;payload=JSON.parse(options.body);headers=options.headers;
    return new Response(JSON.stringify({candidates:[{content:{parts:[{
      inlineData:{mimeType:"audio/wav",data:wav.toString("base64")}
    }]}}]}),{status:200});
  };
  try{
    const request=new Request("https://example.test/api/tts",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({text:"မြန်မာဇာတ်လမ်း",language:"my",gender:"male",style:"cinematic"})
    });
    const response=await appWorker.fetch(request,agentPlatformEnv);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get("content-type"),"audio/wav");
    assert.equal(target,"https://aiplatform.googleapis.com/v1/projects/whk-movie-recap-test/locations/global/publishers/google/models/gemini-3.8-flash-tts:generateContent");
    assert.equal(headers["x-goog-api-key"],"test-agent-platform-key");
    assert.deepEqual(payload.generationConfig.responseModalities,["AUDIO"]);
    assert.equal(payload.generationConfig.speechConfig.voiceConfig.voice,"Charon");
    assert.ok(payload.contents[0].parts[0].speechMetadata.style.includes("Burmese"));
  }finally{globalThis.fetch=previous}
});

test("Agent Platform mode fails closed when its project or API key is missing",async()=>{
  const request=new Request("https://example.test/api/recap",{
    method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
    body:JSON.stringify({transcript:"A sufficiently long movie dialogue transcript."})
  });
  const response=await appWorker.fetch(request,{...agentPlatformEnv,AGENT_PLATFORM_API_KEY:""});
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/AGENT_PLATFORM_API_KEY/);
});
