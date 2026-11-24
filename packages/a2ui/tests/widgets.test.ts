import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetCatalog } from '@pi-bot/generative-ui';
import { getUiCatalog, validateUiDocument, updateUiState, validateUiAction } from '../src/index.js';
import { protocolCatalog } from '../src/catalog.js';
import { UiSession } from '../src/session.js';
import { widgetDocument, formDocument, documentOf, ARTIFACT_ID } from './widget-fixtures.js';

test('all 35 pinned assistant-ui components expose schemas and persist as replayable A2UI',()=>{
  assert.equal(Object.keys(widgetCatalog).length,35);
  for(const name of Object.keys(widgetCatalog)){
    assert.ok(getUiCatalog(`Aui${name}`).schema, name);
    const doc=widgetDocument(name);assert.deepEqual(validateUiDocument(doc),doc,name);
  }
});
test('forms validate edited state and canonicalize published confirm/cancel actions',()=>{
  const doc=formDocument();
  const edited=updateUiState(doc,[{surfaceId:'example',data:{note:'修改备注',count:4}}]);
  const action={surfaceId:'example',sourceComponentId:'root',name:'submit',context:{note:'伪造',count:100}};
  assert.deepEqual(validateUiAction(edited,action).context,{note:'修改备注',count:4});
  const empty=updateUiState(doc,[{surfaceId:'example',data:{note:'',count:4}}]);
  assert.throws(()=>validateUiAction(empty,action),/不能为空/);
  assert.deepEqual(validateUiAction(empty,{...action,name:'cancel'}).context,{});
  assert.throws(()=>updateUiState(doc,[{surfaceId:'example',data:{note:99,count:4}}]));
  assert.throws(()=>validateUiAction(doc,{...action,name:'forged'}),/不属于/);
});
test('artifact image references remain small and reject remote images/password controls',()=>{
  const doc=documentOf([{id:'root',component:'AuiImage',artifact_id:ARTIFACT_ID,alt:'生成的图片'}]);
  assert.ok(JSON.stringify(doc).length<500);
  assert.throws(()=>documentOf([{id:'root',component:'AuiImage',src:'https://external.example/private',alt:'bad'}]),/附件|artifact_id|内联/);
  assert.throws(()=>documentOf([{id:'root',component:'AuiInput',inputType:'password',defaultValue:{path:'/v'}}],{v:''}),/密码/);
  assert.throws(()=>documentOf([{id:'root',component:'AuiCol',children:['missing']}]));
});
test('list templates resolve properties against each item rather than the surface root',()=>{
  const doc=documentOf([{id:'root',component:'AuiListView',children:{componentId:'item',path:'/rows'}},{id:'item',component:'AuiText',value:{path:'title'}}],{rows:[{title:'第一项'},{title:'第二项'}]});
  assert.deepEqual(validateUiDocument(doc),doc);
});
test('template actions preserve a verified instance path across the client session and server',async()=>{
  const doc=documentOf([{id:'root',component:'AuiCol',children:{componentId:'choose',path:'/items'}},{id:'choose',component:'AuiButton',label:{path:'name'},action:{event:{name:'select',context:{selection:{path:'name'}}}}}],{items:[{name:'First'},{name:'Second'}],secret:{name:'not a row'}});
  const action={surfaceId:'example',sourceComponentId:'choose',sourceDataPath:'/items/1',name:'select',context:{selection:'forged'}};
  assert.deepEqual(validateUiAction(doc,action).context,{selection:'Second'});
  for(const sourceDataPath of ['/items/2','/secret','/'])assert.throws(()=>validateUiAction(doc,{...action,sourceDataPath}),/模板实例/);
  let posted:any;
  const session=new UiSession(doc,protocolCatalog,{save:async()=>doc,action:async input=>{posted=input.action;}});
  await session.submit(action as any);assert.equal(posted.sourceDataPath,'/items/1');
  await session.dispose();
});
