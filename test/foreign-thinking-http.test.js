import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleMessages } from '../src/handlers/messages.js';
import { __setRequestImpl } from '../src/devin-connect.js';
import { setLiveCatalogSelectors, clearLiveCatalogSelectors } from '../src/devin-connect-models.js';
import { getExperimental, setExperimental } from '../src/runtime-config.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';
import { parseFields, getAllFields, getField, writeStringField, writeVarintField } from '../src/proto.js';
const FLAGS={DEVIN_CONNECT:'1',DEVIN_CONNECT_TOKEN:'fixture-http-policy-account',DEVIN_CONNECT_NATIVE_THINKING:'1',
  DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS:'swe-2-high',DEVIN_CONNECT_NATIVE_THINKING_TEXT_MODELS:''};
let saved, experimental, requests;
beforeEach(()=>{
  saved=Object.fromEntries(Object.keys(FLAGS).map(k=>[k,process.env[k]]));Object.assign(process.env,FLAGS);
  experimental=getExperimental();setExperimental({nativeToolCall:true});
  setLiveCatalogSelectors(['glm-5-3-flash-high','claude-sonnet-4-6-thinking','swe-2-high']);requests=[];
  __setRequestImpl((_opts,cb)=>{
    const req=new EventEmitter();req.destroyed=false;req.setTimeout=()=>req;
    req.write=data=>requests.push(parseFields(data.subarray(5)));
    req.destroy=()=>{req.destroyed=true;};
    req.end=()=>{
      const res=new EventEmitter();res.statusCode=200;cb(res);
      setImmediate(()=>{
        res.emit('data',wrapEnvelope(Buffer.concat([writeStringField(3,'OK'),writeVarintField(5,2)]),{compress:false}));
        res.emit('data',endOfStreamEnvelope());res.emit('end');
      });
    };return req;
  });
});
afterEach(()=>{for(const [k,v] of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;
  setExperimental(experimental);clearLiveCatalogSelectors();__setRequestImpl(null);});
for(const model of ['glm-5-3-flash-high','claude-sonnet-4-6-thinking'])for(const stream of [false,true])for(const parallel of [false,true]){
  test(`foreign thinking through Messages: ${model}, stream=${stream}, tools=${parallel}`,async()=>{
    const content=[{type:'thinking',thinking:'fixture summary from another provider',signature:'foreign-fixture-signature'},{type:'text',text:'previous answer'}];
    if(parallel)for(const id of ['a','b'])content.push({type:'tool_use',id,name:'lookup',input:{key:id}});
    const messages=[{role:'user',content:'previous question'},{role:'assistant',content},
      {role:'user',content:parallel?['b','a'].map(id=>({type:'tool_result',tool_use_id:id,content:id+' value'})):'continue'}];
    const reply=await handleMessages({model,stream,messages,max_tokens:128,
      ...(parallel?{tools:[{name:'lookup',description:'Get one value.',input_schema:{type:'object',properties:{key:{type:'string'}}}}]}:{})},{callerKey:'fixture-caller'});
    assert.equal(reply.status,200,JSON.stringify(reply.body?.error));
    if(stream){
      const res={body:'',writableEnded:false,on(){return this;},write(c){this.body+=c;return true;},end(c){if(c)this.write(c);this.writableEnded=true;}};
      await reply.handler(res);assert.ok(res.body.includes('message_stop'));assert.ok(!res.body.includes('event: error'));
    }else assert.equal(reply.body.content.find(b=>b.type==='text')?.text,'OK');
    assert.equal(requests.length,1);
    assert.equal(getField(requests[0],21,2)?.value.toString(),model,'the exact intended selector must reach the encoder');
    const rows=getAllFields(requests[0],3).map(f=>parseFields(f.value));
    for(const r of rows)for(const n of [11,12,18])assert.equal(getField(r,n,2),null,'foreign thinking must not reach wire');
    if(parallel)assert.equal(rows.filter(r=>getField(r,7,2)).length,2,'both tool results survive stripping');
  });
}
