import {test} from 'node:test';
import assert from 'node:assert/strict';
import {phoneRoutes} from '../src/phone-routes.js';
import {Hub} from '../src/hub.js';

test('phone endpoints use actor authentication and strict narrow payload schemas',()=>{
 assert.equal(phoneRoutes.length,6);
 for(const route of phoneRoutes){assert.equal(route.auth,'actor');assert.equal(route.tx,false);}
 const input=phoneRoutes.find(r=>r.path.endsWith('/input'))!;
 assert.equal(input.body!.safeParse({sessionId:'00000000-0000-4000-8000-000000000000',event:{type:'tap',x:2,y:3}}).success,true);
 for(const event of [{type:'shell',command:'id'},{type:'tap',x:720,y:0},{type:'key',code:26},{type:'text',text:'x\ncommand'}]){
  assert.equal(input.body!.safeParse({sessionId:'00000000-0000-4000-8000-000000000000',event}).success,false);
 }
 assert.equal(phoneRoutes[0].body!.safeParse({host:'127.0.0.1',port:5038}).success,false);
});

test('phone API checks current owner before RPC and pins requests to the intended node',async()=>{
 const route=phoneRoutes.find(r=>r.path.endsWith('/frame'))!;const sent:any[]=[],headers:any={};
 const hub=new Hub();
 hub.attach({deviceId:'node-a',userId:'owner',send:m=>{if(m.type!=='rpc')return;sent.push(m);queueMicrotask(()=>hub.resolveRpc('node-a',{id:m.id,ok:true,result:{mime:'image/jpeg',data:'test'}}));},close(){}});
 const ctx:any={user:{user_id:'owner'},params:{id:'node-a'},body:{sessionId:'00000000-0000-4000-8000-000000000000'},s:{rpcTimeoutMs:12000},reply:{header:(k:string,v:string)=>{headers[k]=v;}},hub,db:{tx:async(fn:any)=>fn({one:async(_sql:string,args:string[])=>args[0]==='node-a'&&args[1]==='owner'?{device_id:'node-a'}:null})}};
 assert.equal((await route.handler(ctx) as any).mime,'image/jpeg');
 assert.equal(sent[0].method,'phone.frame');assert.equal(sent[0].params.phoneId,'google-play-validation');assert.equal(headers['Cache-Control'],'no-store');
 await assert.rejects(route.handler({...ctx,user:{user_id:'other'}}),(e:any)=>e.status===404);
 assert.equal(sent.length,1);
 hub.kick('node-a');
 await assert.rejects(route.handler(ctx),(e:any)=>e.status===503);
});

test('RPC result from another node cannot resolve an ongoing phone request',async()=>{
 const hub=new Hub();let packet:any;
 hub.attach({deviceId:'a',userId:'u',send:m=>{packet=m;},close(){}});
 const pending=hub.rpc('u','phone.acquire',{},1000,'a');
 hub.resolveRpc('b',{id:packet.id,ok:true,result:'wrong'});
 hub.resolveRpc('a',{id:packet.id,ok:true,result:'right'});
 assert.equal(await pending,'right');
});

test('phone HTTP fixture enforces real bearer authentication, owner isolation and revocation',async()=>{
 const {default:Fastify}=await import('fastify');
 const {user,issueToken,issueLlmToken}=await import('../src/security.js');
 const {settings}=await import('../src/config.js');
 const {HttpError}=await import('../src/db.js');
 const s=settings({PI_BOT_DATABASE_URL:'not-used',PI_BOT_JWT_SECRET:'isolated-phone-test-secret-not-production'});
 const owner={user_id:'owner',role:'user'},other={user_id:'other',role:'user'};
 let revoked=false;const calls:string[]=[];
 const tx:any={get:async(table:string,id:string)=>table==='users'?(id==='owner'?owner:id==='other'?other:null):null,one:async(_sql:string,args:string[])=>!revoked&&args[0]==='node-a'&&args[1]==='owner'?{device_id:'node-a'}:null};
 const hub=new Hub();hub.attach({deviceId:'node-a',userId:'owner',send:m=>{if(m.type!=='rpc')return;calls.push(m.method);queueMicrotask(()=>hub.resolveRpc('node-a',{id:m.id,ok:true,result:{available:true}}));},close(){}});
 const app=Fastify({logger:false});app.setErrorHandler((e,_req,reply)=>{if(e instanceof HttpError)reply.code(e.status).send({detail:e.detail});else reply.code(500).send({detail:'test fixture failed'});});
 for(const route of phoneRoutes)app.route({method:route.method,url:route.path,handler:async(req,reply)=>{
  const u=await user(tx,req.headers,s);const parsed=route.body!.safeParse(req.body);
  if(!parsed.success)return reply.code(422).send({detail:'手机请求参数无效'});
  return route.handler({db:{tx:async(fn:any)=>fn(tx)},hub,s,user:u,params:req.params,reply,body:parsed.data} as any);
 }});
 try{
  const url='/devices/node-a/phone/preview';
  assert.equal((await app.inject({method:'POST',url,payload:{}})).statusCode,401);
  const token=await issueToken(owner,s),otherToken=await issueToken(other,s),llm=await issueLlmToken({sub:'owner',src:'cloud'},s);
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer '+llm},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer '+otherToken},payload:{}})).statusCode,404);
  assert.equal(calls.length,0);
  const ok=await app.inject({method:'POST',url,headers:{authorization:'Bearer '+token},payload:{}});
  assert.equal(ok.statusCode,200);assert.equal(ok.headers['cache-control'],'no-store');assert.equal(ok.json().available,true);
  revoked=true;
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer '+token},payload:{}})).statusCode,404);
  assert.equal(calls.length,1);
 }finally{await app.close();}
});


test('read-only preview is sessionless, strict, authenticated and node scoped',async()=>{
 const preview=phoneRoutes.find(r=>r.path.endsWith('/preview'))!;
 assert.equal(preview.auth,'actor');
 assert.equal(preview.body!.safeParse({}).success,true);
 for(const body of [{sessionId:'00000000-0000-4000-8000-000000000000'},{phoneId:'other'},{event:{type:'key',code:4}}]) assert.equal(preview.body!.safeParse(body).success,false);
 const calls:any[]=[],headers:any={};let revoked=false;
 const ctx:any={user:{user_id:'owner'},params:{id:'node-a'},body:{},s:{rpcTimeoutMs:12000},reply:{header:(k:string,v:string)=>{headers[k]=v;}},db:{tx:async(fn:any)=>fn({one:async(_sql:string,args:string[])=>!revoked&&args[0]==='node-a'&&args[1]==='owner'?{device_id:'node-a'}:null})},hub:{rpc:async(...args:any[])=>{calls.push(args);return {mime:'image/jpeg'};}}};
 await preview.handler(ctx);
 assert.deepEqual(calls[0],['owner','phone.preview',{phoneId:'google-play-validation'},12000,'node-a']);
 assert.equal(headers['Cache-Control'],'no-store');
 await assert.rejects(preview.handler({...ctx,user:{user_id:'other'}}),(e:any)=>e.status===404);
 revoked=true;await assert.rejects(preview.handler(ctx),(e:any)=>e.status===404);
 assert.equal(calls.length,1);
});
