import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { sourceKey } from '../shared/source.mjs';
const base = process.env.ANNOTATED_URL || 'http://127.0.0.1:4317';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw new Error('Smoke fixtures may only be sent to the local test service.');
const artifact = new URL('../artifacts/smoke/', import.meta.url);
await mkdir(artifact, { recursive:true });
const results = [];
async function request(route, { method='GET', body, token, headers={}, status }={}) {
  headers.Origin = base;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !Buffer.isBuffer(body)) { headers['Content-Type']='application/json'; body=JSON.stringify(body); }
  const response = await fetch(base+route, {method,body,headers});
  const result = await response.json();
  if (status) assert.equal(response.status,status,JSON.stringify(result));
  else assert.ok(response.ok,`${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
  return {response,...result};
}
function clip(input,name,args) {
  const path = new URL(name,artifact).pathname;
  const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss','10','-i',new URL(input,import.meta.url).pathname,'-t','15',...args,path],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return path;
}
await request('/api/health');
await request('/api/annotations',{method:'POST',body:{},status:401});
const mira=await request('/api/dev/session',{method:'POST',body:{persona:'mira'}});
const leo=await request('/api/dev/session',{method:'POST',body:{persona:'leo'}});
assert.ok(mira.token && leo.token);
// Remove only this script's previous generated examples after an interrupted run.
const prior=await request('/api/feed?limit=100');
for (const annotation of prior.annotations) {
  if (/^(Synthetic QA example:|Synthetic audio and voice-track QA\.|Local testing example:)/.test(annotation.commentary)) {
    const ownerToken=annotation.author.id===mira.user.id?mira.token:annotation.author.id===leo.user.id?leo.token:null;
    if(ownerToken) await request(`/api/annotations/${annotation.id}`,{method:'DELETE',token:ownerToken});
  }
}
const video=clip('../web/fixtures/timing.mp4','source-video.mp4',['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac']);
const audio=clip('../web/fixtures/timing.wav','source-audio.wav',['-c:a','pcm_s16le']);
const uploadVideo=await request('/api/media',{method:'POST',token:mira.token,body:await readFile(video),headers:{'Content-Type':'video/mp4','X-Media-Role':'source-video'}});
assert.ok(uploadVideo.duration<=90 && uploadVideo.height<=240);
const uploadAudio=await request('/api/media',{method:'POST',token:mira.token,body:await readFile(audio),headers:{'Content-Type':'audio/wav','X-Media-Role':'source-audio'}});
const uploadVoice=await request('/api/media',{method:'POST',token:mira.token,body:await readFile(audio),headers:{'Content-Type':'audio/wav','X-Media-Role':'voice'}});
results.push({check:'Real media normalization',video:{duration:uploadVideo.duration,width:uploadVideo.width,height:uploadVideo.height},audioDuration:uploadAudio.duration,voiceDuration:uploadVoice.duration});
const videoPayload={clientId:crypto.randomUUID(),source:{url:base+'/fixtures/video.html',title:'Source timing laboratory',kind:'video',author:'Annotated test corpus'},start:10,end:25,commentary:'Synthetic QA example: this is an actual 15-second clip of our original timing fixture. It verifies playback and source context, not real user demand.',mediaId:uploadVideo.id};
const first=await request('/api/annotations',{method:'POST',token:mira.token,body:videoPayload});
const retry=await request('/api/annotations',{method:'POST',token:mira.token,body:videoPayload});
assert.equal(first.annotation.id,retry.annotation.id);
const second=await request('/api/annotations',{method:'POST',token:mira.token,body:{clientId:crypto.randomUUID(),source:{url:base+'/fixtures/audio.html',title:'Listening laboratory',kind:'audio',author:'Annotated test corpus'},start:10,end:25,commentary:'Synthetic audio and voice-track QA. Both players contain a generated test tone; no microphone or person was recorded.',mediaId:uploadAudio.id,voiceMediaId:uploadVoice.id}});
const third=await request('/api/annotations',{method:'POST',token:leo.token,body:{clientId:crypto.randomUUID(),source:{url:base+'/fixtures/article.html',title:'The smaller team is only half the story.',kind:'article',author:'Annotated test corpus'},excerpt:'A smaller team can build the product. It still has to build the trust.',commentary:'Local testing example: the excerpt and commentary stay separate so a reader can inspect the exact source passage.'}});
await request(`/api/annotations/${first.annotation.id}/comments`,{method:'POST',token:leo.token,body:{text:'Local test response: the public clip is playable and the source remains one click away.'}});
const receipt=await request(`/api/annotations/${first.annotation.id}`);
assert.ok(receipt.comments.some(comment=>comment.author.id===leo.user.id));
await request(`/api/annotations/${first.annotation.id}`,{method:'DELETE',token:leo.token,status:403});
await request(`/api/users/${mira.user.id}/follow`,{method:'POST',token:leo.token,body:{following:true}});
const following=await request('/api/feed?following=1',{token:leo.token});
assert.ok(following.annotations.some(annotation=>annotation.id===first.annotation.id));
const source=await request('/api/sources/lookup',{method:'POST',body:{key:await sourceKey(videoPayload.source.url)}});
assert.ok(source.annotations.some(annotation=>annotation.id===first.annotation.id));
const range=await fetch(base+first.annotation.mediaUrl,{headers:{Range:'bytes=0-127'}});
assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,128);
const claim=await request('/api/claims',{method:'POST',body:{annotationId:first.annotation.id,name:'Local QA claimant',email:'qa@example.invalid',reason:'Testing',details:'Synthetic test claim; no real rights complaint.'}});
assert.ok(claim.reference);
await request('/api/admin/claims',{status:401});
await request('/api/admin/claims',{token:leo.token,status:403});
const claims=await request('/api/admin/claims',{token:mira.token});
assert.ok(claims.claims.some(item=>item.reference===claim.reference));
results.push({check:'Publish, retry, anonymous playback/range, second-user comment, source lookup, follow, ownership and private claim access',passed:true});
results.push({check:'Review URLs',urls:[first,second,third].map(item=>`${base}/a/${item.annotation.id}`)});
await writeFile(new URL('results.json',artifact),JSON.stringify({at:new Date().toISOString(),mode:'local-test',results},null,2));
console.log(JSON.stringify(results,null,2));
