import test from "node:test";
import assert from "node:assert/strict";
import worker from "../experimental/transcribe-audio-v028.js";
const env={APP_TOKEN:"test-token",GEMINI_API_KEY:"test-key"};
const payload={mime_type:"audio/wav",audio_base64:"YWJj"};
function req(data=payload,token="test-token"){return new Request("https://example.test/api/transcribe-audio",{method:"POST",headers:{authorization:"Bearer "+token},body:JSON.stringify(data)})}
test("requires token",async()=>assert.equal((await worker.fetch(req(payload,"invalid"),env)).status,401));
test("rejects invalid audio",async()=>assert.equal((await worker.fetch(req({...payload,audio_base64:"not base64!"}),env)).status,400));
test("rejects unsupported MIME",async()=>assert.equal((await worker.fetch(req({...payload,mime_type:"text/plain"}),env)).status,400));
test("handles quota errors",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response("quota",{status:429});
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,429);assert.equal((await r.json()).retryable,true)}finally{globalThis.fetch=old}
});
test("accepts timestamped transcription",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:0,end_ms:1200,text:"Hello",language:"en"}],uncertainties:[]})}]}}]}),{status:200});
 try{const r=await worker.fetch(req(),env);assert.equal(r.status,200);assert.equal((await r.json()).transcript_segments[0].text,"Hello")}finally{globalThis.fetch=old}
});
test("rejects malformed provider timestamps",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{start_ms:1200,end_ms:100,text:"Hello",language:"en"}],uncertainties:[]})}]}}]}),{status:200});
 try{assert.equal((await worker.fetch(req(),env)).status,502)}finally{globalThis.fetch=old}
});
