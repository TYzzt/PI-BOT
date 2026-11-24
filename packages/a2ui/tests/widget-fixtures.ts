import { widgetCatalog } from '@pi-bot/generative-ui';
import { CATALOG_ID, applyUiMessages } from '../src/index.js';
import { CONTROL_VALUES } from '../src/widgets.js';
export const ARTIFACT_ID = '66e75b1a-7bc7-4514-8ff7-7cbad8a59e7d';
export const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==';
function sample(s:any):any {
  if(s.enum)return s.enum[0];if('const'in s)return s.const;
  if(s.anyOf)return sample(s.anyOf[0]);if(Array.isArray(s.type))return sample({...s,type:s.type[0]});
  if(s.type==='string')return '样例';if(s.type==='number'||s.type==='integer')return Math.max(s.minimum??1,1);if(s.type==='boolean')return false;
  if(s.type==='array')return [sample(s.items??{})];
  if(s.type==='object')return Object.fromEntries((s.required??[]).map((k:string)=>[k,sample(s.properties[k])]));return '';
}
export function widgetFixture(name:string) {
  const entry=widgetCatalog[name as keyof typeof widgetCatalog];
  const props:Record<string,any>=sample(entry.schema), data:Record<string,any>={};
  if(name==='Image'){props.src=PIXEL;props.alt='测试图片';}
  if(name==='Diagram'){props.code='flowchart LR\n A[开始] --> B[完成]';props.title='本地流程图';}
  if(name==='Map'){props.places=[{label:'海边散步',lat:22.3,lng:114.2}];}
  if(name==='Markdown')props.value='**加粗文字**';
  if(name==='Chart'){props.data=[{label:'一月',value:12},{label:'二月',value:-4}];props.showAxis=true;}
  if(name==='Table'){props.columns=[{label:'项目'}];props.rows=[['数据']];props.sortable=true;}
  if(name==='Tabs')props.tabs=['第一页'];
  const valueKey=CONTROL_VALUES[`Aui${name}`];
  if(valueKey){ data.value=name==='Checkbox'?false:name==='CheckboxGroup'?[]:name==='Slider'?1:'';props[valueKey]={path:'/value'};props.label=name;if(name==='Slider')Object.assign(props,{min:0,max:10}); }
  const copy:Record<string,Record<string,any>>={
    Header:{text:'把周末留给喜欢的事',size:'md'},Text:{value:'已经为你整理好一份轻松的周末计划。可以随时调整，再决定下一步。'},Caption:{value:'更新于今天 09:41 · 所有修改自动保存'},
    Fact:{label:'本周已完成',value:'24',delta:'+12%',trend:'up'},Button:{label:'查看完整计划',buttonStyle:'primary'},
    Select:{label:'出行方式',placeholder:'选择你的偏好',options:[{label:'步行与公共交通',value:'walk'},{label:'自驾出行',value:'drive'}]},Input:{label:'给计划加一点想法',placeholder:'例如：想找一家安静的咖啡馆'},DatePicker:{label:'出发日期'},
    Checkbox:{label:'完成后通知我',variant:'switch'},Slider:{label:'创意程度',min:0,max:100,unit:'%'},
    RadioGroup:{label:'你的旅行节奏',options:[{label:'轻松一点',value:'slow',description:'留出散步和休息的时间'},{label:'多看一点',value:'full',description:'安排更多沿途的风景'}]},
    CheckboxGroup:{label:'出门前的小清单',progress:true,options:[{label:'带上相机',value:'camera'},{label:'下载离线地图',value:'map'},{label:'确认天气',value:'weather'}]},
    Card:{title:'一份刚刚好的周末计划'},Badge:{value:'已准备就绪',variant:'success'},Box:{width:'100%',height:6,radius:'full',background:'#65a991'},
    Steps:{steps:[{title:'确认偏好',detail:'选择节奏和出行方式'},{title:'生成方案',detail:'整理路线与预算'},{title:'开启周末',detail:'带着期待出发'}]},
    Timeline:{items:[{time:'09:30',title:'在街角喝一杯咖啡',detail:'留一点时间，慢慢醒来'},{time:'11:00',title:'沿着海岸散步',detail:'步行约 2 公里'}]},
    Table:{columns:[{label:'安排'},{label:'预算',format:{kind:'currency',currency:'CNY',decimals:0}}],rows:[['早午餐',68],['咖啡与甜点',42],['交通',26]],sortable:true},
    Chart:{variant:'bar',data:[{label:'周一',value:12},{label:'周二',value:18},{label:'周三',value:15},{label:'周四',value:26},{label:'周五',value:22}],showAxis:true},
    Citation:{title:'给忙碌日常的一份周末指南',source:'PiBot · 旅行笔记',snippet:'走走停停，也是一种很好的安排。',url:'https://www.assistant-ui.com/docs/tools/generative-ui'},
    Alert:{title:'计划已经准备好了',description:'你可以继续调整，确认后再开始执行。',tone:'success'},Carousel:{label:'挑一个喜欢的周末'},Icon:{name:'sun',size:'lg'},
  };
  Object.assign(props,copy[name]??{});
  if(name==='Slider')data.value=64;if(name==='DatePicker')data.value='2026-11-28';if(name==='Checkbox')data.value=true;if(name==='CheckboxGroup')data.value=['camera'];
  const components:Record<string,any>[]=[{id:'root',component:`Aui${name}`,...props}];
  if(['Card','Col','Row','ListView','ListViewItem','Form','Tabs','Carousel'].includes(name)){
    const extra:Record<string,any>[]=name==='Row'?[{id:'first',component:'AuiBadge',value:'已完成',variant:'success'},{id:'second',component:'AuiText',value:'周末计划已就绪'}]
      :name==='Tabs'?[{id:'first',component:'AuiText',value:'周六：咖啡、海边和落日。'},{id:'second',component:'AuiText',value:'周日：逛书店，慢慢回家。'}]
      :name==='ListView'?[{id:'first',component:'AuiListViewItem',children:['first-title']},{id:'second',component:'AuiListViewItem',children:['second-title']},{id:'first-title',component:'AuiText',value:'海边散步 · 约 30 分钟'},{id:'second-title',component:'AuiText',value:'街角咖啡 · 找个靠窗的位置'}]
      :name==='ListViewItem'?[{id:'first',component:'AuiText',value:'海边散步'},{id:'second',component:'AuiCaption',value:'轻松路线 · 约 30 分钟'}]
      :name==='Carousel'?[{id:'first',component:'AuiCard',title:'去海边',children:['sea']},{id:'second',component:'AuiCard',title:'逛书店',children:['book']},{id:'sea',component:'AuiCaption',value:'散步 · 落日 · 慢生活'},{id:'book',component:'AuiCaption',value:'阅读 · 咖啡 · 城市角落'}]
      :name==='Form'?[{id:'first',component:'AuiInput',label:'这次想去哪里？',placeholder:'输入一个城市或地点',defaultValue:{path:'/destination'}},{id:'second',component:'AuiButton',label:'生成计划',submit:true,buttonStyle:'primary'}]
      :[{id:'first',component:'AuiText',value:'海风、咖啡，和不赶时间的一天。'},{id:'second',component:'AuiCaption',value:'按你的节奏安排，随时都可以调整。'}];
    components[0].children=['first','second'];components.push(...extra);
    if(name==='Tabs')props.tabs=['周六','周日'],components[0].tabs=props.tabs;
    if(name==='Form')data.destination='';
  }
  if(name==='Divider'||name==='Spacer')return {components:[{id:'root',component:name==='Spacer'?'AuiRow':'AuiCol',children:['before','part','after']},{id:'before',component:'AuiCaption',value:name==='Spacer'?'当前状态':'周末计划'},{id:'part',component:`Aui${name}`},{id:'after',component:'AuiText',value:name==='Spacer'?'准备就绪':'已经整理好，等你来看看。'}],data};
  return {components,data};
}
export function widgetDocument(name:string) {const f=widgetFixture(name);return documentOf(f.components,f.data);}
export function documentOf(components:Record<string,any>[],data:Record<string,any>={}) {return applyUiMessages(null,[
  {version:'v0.9',createSurface:{surfaceId:'example',catalogId:CATALOG_ID}},
  {version:'v0.9',updateDataModel:{surfaceId:'example',path:'/',value:data}},
  {version:'v0.9',updateComponents:{surfaceId:'example',components}},
]);}
export function formDocument() {return documentOf([
  {id:'root',component:'AuiCard',title:'方案表单',asForm:true,children:['note','count','total'],confirm:{label:'提交方案',action:{event:{name:'submit',context:{note:{path:'/note'},count:{path:'/count'}}}}},cancel:{label:'取消方案',action:{event:{name:'cancel',context:{}}}}},
  {id:'note',component:'AuiInput',label:'备注',name:'note',required:true,minLength:2,defaultValue:{path:'/note'}},
  {id:'count',component:'AuiSlider',label:'数量',name:'count',min:0,max:10,defaultValue:{path:'/count'}},
  {id:'total',component:'AuiFact',label:'合计',value:{call:'displayNumber',args:{value:{call:'calculate',args:{expression:'n*2',variables:{n:{path:'/count'}}},returnType:'number'}},returnType:'string'}},
],{note:'初始备注',count:2});}
