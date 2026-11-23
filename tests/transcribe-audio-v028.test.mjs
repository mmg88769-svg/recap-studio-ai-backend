import test from "node:test";
import assert from "node:assert/strict";
import worker from "../experimental/transcribe-audio-v028.js";
const env={APP_TOKEN:"test-token",GEMINI_API_KEY:"test-key"};
const payload={mime_type:"audio/wav",audio_base64:"YWJj"};
function req(data=payload,token="test-token"){return new Request("https://example.test/api/transcribe-audio",{method:"POST",headers:{authorization:"Bearer "+token},body:JSON.stringify(data)})}
test("requires token",async()=>assert.equal((await worker.fetch(req(payload,"invalid"),env)).status,401));
test("rejects invalid audio",async()=>assert.equal((await worker.fetch(req({...payload,audio_base64:"not base64!"}),env)).status,400));
test("rejects unsupported MIME",async()=>assert.equal((await worker.fetch(req({...payload,mime_type:"text/plain"}),env)).status,400));
test("handles quota errors without retrying",async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response("quota",{status:429})};
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,429);assert.equal((await r.json()).retryable,true);assert.equal(calls,1)}finally{globalThis.fetch=old}
});
test("retries transient Gemini 503 overload and succeeds",async()=>{
 const old=globalThis.fetch;let calls=0;
 const provider={candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:0,end_ms:1200,text:"Hello",language:"en"}],uncertainties:[]})}]}}]};
 globalThis.fetch=async()=>{calls++;return calls<3?new Response(JSON.stringify({error:{message:"high demand"}}),{status:503}):new Response(JSON.stringify(provider),{status:200})};
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,200);assert.equal(calls,3);assert.equal((await r.json()).transcript_segments[0].text,"Hello")}finally{globalThis.fetch=old}
});
test("stops after three transient provider failures and marks them retryable",async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{message:"high demand"}}),{status:503})};
 try{const r=await worker.fetch(req(),env);const body=await r.json();assert.equal(r.status,502);assert.equal(calls,5);assert.equal(body.attempts,5);assert.equal(body.retryable,true);assert.equal(body.provider_status,503);assert.equal(body.model,"gemini-3.1-flash-lite")}finally{globalThis.fetch=old}
});
test("accepts timestamped transcription using Gemini 3.8 Flash",async()=>{
 const old=globalThis.fetch;let target;
 globalThis.fetch=async(url)=>{target=url;return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:0,end_ms:1200,text:"Hello",language:"en"}],uncertainties:[]})}]}}]}),{status:200})};
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.transcript_segments[0].text,"Hello");assert.equal(body.model,"gemini-3.8-flash");assert.match(target,/models\/gemini-3\.8-flash/)}finally{globalThis.fetch=old}
});
test("surfaces provider status and safe detail on access errors",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"Model access restricted"}}),{status:403});
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,502);const body=await r.json();assert.equal(body.provider_status,403);assert.match(body.error,/HTTP 403/);assert.match(body.detail,/restricted/)}finally{globalThis.fetch=old}
});
test("rejects malformed provider timestamps",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:1200,end_ms:100,text:"Hello",language:"en"}],uncertainties:[]})}]}}]}),{status:200});
 try{assert.equal((await worker.fetch(req(),env)).status,502)}finally{globalThis.fetch=old}
});

test("uses second free-tier Lite model when primary and first fallback return 503",async()=>{
 const old=globalThis.fetch;let calls=0;const urls=[];
 globalThis.fetch=async url=>{calls++;urls.push(url);
  if(calls<=4)return new Response(JSON.stringify({error:{message:"high demand"}}),{status:503});
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:0,end_ms:1200,text:"Hello",language:"en"}],uncertainties:[]})}]}}]}),{status:200});
 };
 try{const r=await worker.fetch(req(),env);const j=await r.json();assert.equal(r.status,200);assert.equal(calls,5);assert.equal(j.model,"gemini-3.1-flash-lite");assert.equal(j.fallback_used,true);assert.ok(urls[3].includes("gemini-3.5-flash-lite"));assert.ok(urls[4].includes("gemini-3.1-flash-lite"))}finally{globalThis.fetch=old}
});
