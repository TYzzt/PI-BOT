import {confirmAction} from '../apps/desktop/ui/dialogs.js';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline } from '../apps/desktop/ui/timeline.js';
import { bridge } from '../apps/desktop/ui/bridge.js';
import { stageDrafts } from '../apps/desktop/ui/drafts.js';
import type { Bot } from '../packages/protocol/src/index.js';

const image = {name:'pixel.png',mime_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'};
const botA: Bot = {id:'bot-a',name:'A',slug:'a',persona:'',model_id:null,avatar:{shape:'blob',color:'orange',scheme:'light'},pending_approvals:[],latest_run:null,last_message:null,created_at:'2026-10-31',last_active_at:'2026-10-31'};
const botB: Bot = {...botA,id:'bot-b',name:'B',slug:'b'};
let pending: {resolve(value:unknown):void;reject(error:Error):void} | undefined;
const harness = {
  requests: [] as {botId:string;text:string;images:unknown[]}[],
  select: (_id:string) => {},
  online: (_value:boolean) => {},
  confirm:confirmAction,
  chunks:[] as string[],
  starts:[] as any[],
  sourceImage:image,
  pickers:[] as string[],
  finish: (success:boolean) => {
    if (!pending) throw new Error('No pending send');
    const request = pending; pending = undefined;
    if (success) request.resolve({messages:[]}); else request.reject(new Error('Send failed'));
  },
  save: () => bridge.updates!.install(),
};
(window as any).__draftHarness = harness;
document.addEventListener('click', event => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.type === 'file') {
    event.preventDefault();
    harness.pickers.push(input.accept);
  }
});
window.agent = {
  updates:{
    state:async()=>({supported:true,phase:'ready',channel:'stable',version:'0.3.0',buildNumber:0,message:''}),
    check:async()=>{throw new Error('unused');},download:async()=>{throw new Error('unused');},
    install:async()=>false,
  },
  call:async(method,input:any)=>{
    if(method==='documentCapabilities')return {version:1};
    if(method==='documentUploadBegin'){harness.starts.push(input);return {upload_id:input.request_id};}
    if(method==='documentUploadChunk'){harness.chunks[input.part]=input.data;return {received:atob(input.data).length};}
    if(method==='documentUploadComplete')return {artifact:{id:'11223344-1122-4122-8122-112233445566',name:harness.starts.at(-1).name,title:harness.starts.at(-1).name,mime:'text/csv',size:340000,status:'ready',created_at:new Date().toISOString()}};
    if (method !== 'send') throw new Error(`Unexpected call: ${method}`);
    harness.requests.push(input);
    return new Promise((resolve,reject)=>{pending={resolve,reject};});
  },
  subscribe:()=>()=>{},computerName:async()=>'',defaultServerUrl:async()=>'',openLibrary:async()=>{},openExternal:async()=>{},
};
if (!localStorage.getItem('pi-bot.message-drafts.v1')) stageDrafts({
  'bot-a':{text:'  send A once  ',images:[image]},
  'bot-b':{text:'draft B',images:[{...image,name:'B.png'}]},
});
function Harness() {
  const [bot,setBot] = useState(botA);
  const [online,setOnline] = useState(true);harness.online=setOnline;
  harness.select = id=>setBot(id === botA.id ? botA : botB);
  return <Timeline bot={bot} messages={[]} hasMore={false} mood="idle" online={online} onLoadMore={async()=>{}} onSent={()=>{}} onOpenBot={()=>{}} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
