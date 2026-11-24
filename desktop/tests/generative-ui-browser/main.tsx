import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UiView } from '@pi-bot/a2ui/react';
import { updateUiState, validateUiAction, type UiDocument } from '@pi-bot/a2ui';
import { widgetCatalog } from '@pi-bot/generative-ui';
import { widgetDocument, formDocument, documentOf, ARTIFACT_ID } from '../../../packages/a2ui/tests/widget-fixtures.js';
import { Timeline } from '../../apps/desktop/ui/timeline.js';
import type { Message, Bot } from '../../packages/protocol/src/index.js';
import '@pi-bot/a2ui/styles';
import '../../apps/desktop/ui/style.css';
import './preview.css';

declare global { interface Window { widgetTest: { saved?:UiDocument; action?:unknown; reads:string[]; opened:number; external:number; failImages?:boolean; setLayout?(mode:string):void; templateAction?:unknown; dateSaved?:UiDocument }; fixtureImage:string } }
window.widgetTest={reads:[],opened:0,external:0};
window.agent={
  call:async(method,input:any)=>{
    if(method==='artifactImage'){window.widgetTest.reads.push(input.variant);if(window.widgetTest.failImages)throw new Error('fixture read failure');return {name:'image.png',mime_type:'image/png',data:window.fixtureImage};}
    if(method==='reportOpen'){window.widgetTest.opened++;return {url:'https://example.com/image'};}
    return {};
  },subscribe:()=>()=>{},computerName:async()=>'',defaultServerUrl:async()=>'',openLibrary:async()=>{},openExternal:async()=>{},
};
const bid='12345678-1234-4234-8234-123456789000',now=new Date().toISOString();
const bot={id:bid,name:'生图测试',slug:'image',pending_approvals:[],created_at:now,avatar:null} as unknown as Bot;
const imageLayout=documentOf([{id:'root',component:'AuiCard',title:'已生成',children:['image']},{id:'image',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'卡片里的生成图片'}]);
const messages=[false,true].map((ui,i)=>({id:`12345678-1234-4234-8234-12345678900${i+1}`,bot_id:bid,role:'assistant',content:ui?'定制图片布局':'自动图片展示',seq:i+1,run_id:null,status:'completed',executor:'cloud',tools:[],created_at:now,updated_at:now,ui:ui?imageLayout:null,attachments:[{id:ARTIFACT_ID,title:'橙色机器人',name:'robot.png',mime:'image/png',size:128,created_at:now,status:'ready'}]}) as Message);
function Form(){const[doc]=useState(formDocument);return <UiView document={doc} save={async(states)=>{const next=updateUiState(doc,states);window.widgetTest.saved=next;return next;}} action={async input=>{const next=updateUiState(doc,input.states);window.widgetTest.action=validateUiAction(next,input.action);}}/>;}
const media={image:async()=>`data:image/png;base64,${window.fixtureImage}`,open:async()=>{},openExternal:async()=>{window.widgetTest.external++;}};
const poster=documentOf([
  {id:'root',component:'AuiCard',title:'海边的慢时光',children:['intro','picture','status']},
  {id:'intro',component:'AuiCaption',value:'一张给周末的邀请。按你的想法生成，随时可以继续调整。'},
  {id:'picture',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'周末灵感 · 一起去海边'},
  {id:'status',component:'AuiRow',justify:'between',children:['badge','format']},
  {id:'badge',component:'AuiBadge',value:'生成完成',variant:'success'},
  {id:'format',component:'AuiCaption',value:'PNG · 720 × 480'},
]);
const dashboard=documentOf([
  {id:'root',component:'AuiCard',title:'这一周，进展很不错',children:['stats','divider','detail']},
  {id:'stats',component:'AuiRow',gap:6,children:['tasks','auto','hours']},
  {id:'tasks',component:'AuiFact',label:'完成任务',value:'24',delta:'+12%',trend:'up'},
  {id:'auto',component:'AuiFact',label:'自动处理',value:'18',delta:'75%',trend:'flat'},
  {id:'hours',component:'AuiFact',label:'节省时间',value:'6.4 小时'},
  {id:'divider',component:'AuiDivider'},
  {id:'detail',component:'AuiRow',align:'start',children:['chart-box','table-box']},
  {id:'chart-box',component:'AuiBox',width:'calc(50% - 14px)',children:['chart-title','chart']},
  {id:'chart-title',component:'AuiCaption',value:'每天都有一点进展'},
  {id:'chart',component:'AuiChart',variant:'bar',data:[{label:'周一',value:3},{label:'周二',value:5},{label:'周三',value:4},{label:'周四',value:7},{label:'周五',value:5}],showAxis:true},
  {id:'table-box',component:'AuiBox',width:'calc(50% - 14px)',children:['table-title','table']},
  {id:'table-title',component:'AuiCaption',value:'最近完成'},
  {id:'table',component:'AuiTable',columns:[{label:'任务'},{label:'状态'}],rows:[['整理会议纪要','已完成'],['生成活动海报','已完成'],['安排周末行程','已完成']]},
]);
function PreferenceForm(){const [doc]=useState(()=>{
  const d=formDocument(),c=d.surfaces[0].components;
  Object.assign(c[0],{title:'定制你的出行计划',children:['note','pace','count','total'],confirm:{label:'保存当前选择',action:{event:{name:'save',context:{note:{path:'/note'}}}}},cancel:{label:'暂不调整',action:{event:{name:'cancel',context:{}}}}});
  Object.assign(c.find(x=>x.id==='note')!,{label:'偏好与期待',multiline:true,placeholder:'说说你想怎样度过这一天'});
  Object.assign(c.find(x=>x.id==='count')!,{label:'同行人数',min:1,max:6,unit:' 人'});
  Object.assign(c.find(x=>x.id==='total')!,{label:'建议停留点'});
  c.push({id:'pace',component:'AuiSelect',label:'旅行节奏',defaultValue:{path:'/pace'},options:[{label:'轻松一点，留时间走走停停',value:'slow'},{label:'多看一些，安排更丰富的行程',value:'full'}]});
  d.surfaces[0].data={note:'想去海边散步，找一家安静的咖啡馆。',count:2,pace:'slow'};return d;
});return <UiView document={doc} save={async states=>updateUiState(doc,states)} action={async()=>{}}/>;}
function catalogDocument(name:string){const doc=widgetDocument(name);if(name==='Image')doc.surfaces[0].components[0].src=`data:image/png;base64,${window.fixtureImage}`;return doc;}
const templateDoc=documentOf([{id:'root',component:'AuiCol',children:{componentId:'choose',path:'/items'}},{id:'choose',component:'AuiButton',label:{path:'name'},action:{event:{name:'select',context:{selection:{path:'name'}}}}}],{items:[{name:'First'},{name:'Second'}]});
const temporalDoc=documentOf([
  {id:'root',component:'AuiCol',children:['offset','utc','floating','fallback']},
  {id:'offset',component:'AuiDatePicker',label:'带偏移的时间',inputType:'datetime',value:{path:'/offset'},min:'2026-11-28T08:00:00+08:00',max:'2026-11-28T12:00:00+08:00',required:true},
  {id:'utc',component:'AuiDatePicker',label:'UTC 时间',inputType:'datetime',value:{path:'/utc'}},
  {id:'floating',component:'AuiDatePicker',label:'不带时区的时间',inputType:'datetime',value:{path:'/floating'}},
  {id:'fallback',component:'AuiDatePicker',label:'原始文本',inputType:'datetime',value:{path:'/fallback'}},
],{offset:'2026-11-28T09:30:00+08:00',utc:'2026-11-28T01:30:00Z',floating:'2026-11-28T09:30',fallback:'保留原始文本'});
let savedTemporal=temporalDoc;
function ReviewCases(){return <><div id="template-case"><UiView document={templateDoc} save={async()=>templateDoc} action={async input=>{window.widgetTest.templateAction=validateUiAction(templateDoc,input.action);}}/></div><div id="temporal-case"><UiView document={temporalDoc} save={async states=>{savedTemporal=updateUiState(savedTemporal,states);window.widgetTest.dateSaved=savedTemporal;return savedTemporal;}} action={async()=>{}}/></div></>;}
function App(){
  const [timelineMessages,setTimelineMessages]=useState(messages);
  window.widgetTest.setLayout=mode=>setTimelineMessages(current=>{
    const next=mode==='tabs'?documentOf([{id:'root',component:'AuiTabs',tabs:['说明','生成的图片'],children:['copy','image']},{id:'copy',component:'AuiText',value:'图片位于另一个标签页'},{id:'image',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'隐藏页里的图片'}]):mode==='plain'?documentOf([{id:'root',component:'AuiText',value:'布局已更新'}]):documentOf(mode==='two'?[
      {id:'root',component:'AuiCard',title:'两张相同附件的组合',children:['image','second-image']},
      {id:'image',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'卡片里的生成图片'},
      {id:'second-image',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'第二个位置'},
    ]:imageLayout.surfaces[0].components);
    next.revision=(current[1].ui?.revision??1)+1;
    return [current[0],{...current[1],ui:next}];
  });
  return <main className="preview-page">
  <nav className="preview-nav"><div className="preview-brand"><svg viewBox="0 0 30 30" fill="none"><rect x="3" y="5" width="24" height="21" rx="8" fill="#fff" stroke="#252a31" strokeWidth="1.5"/><path d="M15 2v3" stroke="#252a31" strokeWidth="1.5" strokeLinecap="round"/><circle cx="11" cy="15" r="2" fill="#252a31"/><circle cx="19" cy="15" r="2" fill="#252a31"/><path d="M12 21h6" stroke="#252a31" strokeWidth="1.5" strokeLinecap="round"/></svg>PiBot<em>Generative UI</em></div><span className="preview-status"><i/>35 个组件 · 三端共用</span></nav>
  <header className="preview-heading"><small>COMPONENTS & INTERACTIONS</small><h1>组件与交互预览</h1><p>图片、表单和数据面板，都可以直接出现在对话里。</p></header>
  <div className="preview-showcases" id="showcases">
    <section className="preview-image"><div className="preview-label"><b>01 / 图片直接展示</b><small>Image · Card · Badge</small></div><UiView document={poster} media={media} save={async()=>poster} action={async()=>{}}/></section>
    <section><div className="preview-label"><b>02 / 偏好随手调整</b><small>Form · Select · Slider</small></div><PreferenceForm/></section>
    <section className="preview-dashboard"><div className="preview-label"><b>03 / 数据一目了然</b><small>Fact · Chart · Table</small></div><UiView document={dashboard} save={async()=>dashboard} action={async()=>{}}/></section>
  </div>
  <div className="preview-section-heading"><div><h2>组件目录</h2><p>同一套视觉语言，组合成不同的答案。</p></div><span className="preview-count">35 COMPONENTS</span></div>
  <div id="gallery" className="preview-catalog">{Object.keys(widgetCatalog).map((name,i)=><section className="preview-sample" key={name} data-widget={name}><h3>{name}<span>{String(i+1).padStart(2,'0')}</span></h3><UiView document={catalogDocument(name)} media={media} save={async states=>updateUiState(catalogDocument(name),states)} action={async()=>{}}/></section>)}</div>
  <details className="preview-debug" id="regression"><summary>展开功能回归用例</summary><div id="form"><Form/></div><div><ReviewCases/></div><div id="timeline" style={{height:700,display:'flex',flexDirection:'column',position:'relative'}}><Timeline bot={bot} messages={timelineMessages} hasMore={false} mood="happy" online onLoadMore={async()=>{}} onSent={()=>{}} onOpenBot={()=>{}}/></div></details>
</main>;}
createRoot(document.getElementById('root')!).render(<App/>);
