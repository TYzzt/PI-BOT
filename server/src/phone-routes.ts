// Narrow phone RPC only: deliberately not a generic localhost forwarding proxy.
import { z } from 'zod';
import { fail } from './db.js';
import type { Route } from './routes.js';
const coordX=z.number().int().min(0).max(719),coordY=z.number().int().min(0).max(1279);
export const phoneEventSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('tap'),x:coordX,y:coordY}).strict(),
 z.object({type:z.literal('swipe'),x1:coordX,y1:coordY,x2:coordX,y2:coordY,duration:z.number().int().min(50).max(2000)}).strict(),
 z.object({type:z.literal('text'),text:z.string().min(1).max(1000).regex(/^[\x20-\x7e]+$/)}).strict(),
 z.object({type:z.literal('key'),code:z.union([z.literal(3),z.literal(4),z.literal(67),z.literal(66),z.literal(187)])}).strict(),
]);
const empty=z.object({}).strict(),session=z.object({sessionId:z.string().uuid()}).strict();
export const phoneRoutes:Route[]=(['status','preview','acquire','frame','input','release'] as const).map(action=>({
 method:'POST',path:`/devices/:id/phone/${action}`,auth:'actor',tag:'device',summary:`人工手机控制：${action}`,tx:false,
 body:action==='input'?session.extend({event:phoneEventSchema}).strict():action==='status'||action==='preview'||action==='acquire'?empty:session,
 handler:async ctx=>{
  // Always recheck the owner and revocation, even when a node remains connected.
  const own=await ctx.db.tx(tx=>tx.one('SELECT device_id FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL',[ctx.params.id,ctx.user.user_id]));
  if(!own)fail(404,'执行电脑不存在');
  ctx.reply.header('Cache-Control','no-store');
  ctx.reply.header('Pragma','no-cache');
  // Existing Hub pins both request and response to this user's particular node.
  return ctx.hub.rpc(ctx.user.user_id,`phone.${action}`,{...ctx.body,phoneId:'google-play-validation'},Math.max(10000,Math.min(ctx.s.rpcTimeoutMs,20000)),ctx.params.id);
 },
}));
