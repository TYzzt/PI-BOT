import React from 'react';
import { DataContext } from '@a2ui/web_core/v0_9';
import { Widget, CONTROL_KEYS, type MediaHost } from '@pi-bot/generative-ui/react';
import type { UiSession } from './session.js';
export type { MediaHost };

function Node({ id, basePath, surface, session, host }: {id:string;basePath:string;surface:any;session:UiSession;host?:MediaHost}) {
  const raw = [...surface.componentsModel.values].find((n:any)=>n.id===id);
  if(!raw)return null;
  const context = new DataContext(surface,basePath), type=raw.type.slice(3);
  const props = context.resolveDynamicValue<Record<string,any>>(raw.properties);
  const child = (childId:string,path=basePath) => <Node key={`${childId}:${path}`} id={childId} basePath={path} surface={surface} session={session} host={host}/>;
  const refs=raw.properties.children;
  let children:React.ReactNode;
  if(Array.isArray(refs))children=refs.map((c:string)=>child(c));
  else if(refs?.componentId&&refs.path){const items=context.resolveDynamicValue<unknown[]>({path:refs.path});children=Array.isArray(items)?items.map((_,i)=>child(refs.componentId,context.resolvePath(`${refs.path}/${i}`))):null;}
  const fire = (slot?:'confirm'|'cancel') => {
    const published = slot ? raw.properties[slot]?.action ?? (slot==='confirm'?raw.properties.action:undefined) : raw.properties.action;
    if(!published?.event)return;
    const resolved=context.resolveAction(published) as any;
    void session.submit({name:published.event.name,surfaceId:surface.id,sourceComponentId:id,sourceDataPath:basePath,context:resolved.event?.context??{}} as any);
  };
  return <Widget type={type} props={props} host={host} fire={fire} change={value=>{
    const binding=raw.properties[CONTROL_KEYS[type]];
    if(session.enabled && !session.busy && binding?.path)context.set(binding.path,value);
  }}>{children}</Widget>;
}
export function WidgetSurface({surface,session,host}:{surface:any;session:UiSession;host?:MediaHost}) {
  return <div className="pi-generative-ui" data-aui="root"><Node id="root" basePath="/" surface={surface} session={session} host={host}/></div>;
}
