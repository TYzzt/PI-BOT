import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ResourceLocks } from '../../desktop/packages/service/src/resource-lock.js';
import { queueStatus } from '../src/queue-status.js';

const file = (name: string, mode: 'read'|'write') => ({kind:'file' as const,path:resolve(name),mode});
const gate = () => { let open!: () => void; const waiting = new Promise<void>(r => {open=r;}); return {waiting,open}; };

function measure() {
  return new Promise<[number,number]>((done,fail) => {
    const child = spawn(process.execPath,['-e','const start=Date.now();setTimeout(()=>console.log(JSON.stringify([start,Date.now()])),450)']);
    let output=''; child.stdout.on('data',data => { output+=data; });
    child.on('error',fail); child.on('close',code => code === 0 ? done(JSON.parse(output)) : fail(new Error(String(code))));
  });
}
test('independent resources have overlapping actual child execution intervals', async () => {
  const lock=new ResourceLocks();
  const [a,b]=await Promise.all([lock.run(file('left/a','write'),undefined,measure),lock.run(file('right/b','write'),undefined,measure)]);
  assert.ok(Math.max(a[0],b[0])<Math.min(a[1],b[1]),JSON.stringify({a,b}));
});
test('same resource reads coexist; directory writer waits; following reader cannot bypass', async () => {
  const lock=new ResourceLocks(); const reads=gate(); const reasons:string[]=[]; const order:string[]=[];
  const first=lock.run(file('shared/a','read'),undefined,async()=>{order.push('r1');await reads.waiting;});
  const second=lock.run(file('shared/a','read'),undefined,async()=>{order.push('r2');await reads.waiting;});
  const writer=lock.run(file('shared','write'),undefined,async()=>{order.push('w1');},r=>reasons.push(r));
  const writer2=lock.run(file('shared/a','write'),undefined,async()=>{order.push('w2');},r=>reasons.push(r));
  const reader=lock.run(file('shared/a','read'),undefined,async()=>{order.push('r3');},r=>reasons.push(r));
  await new Promise(r=>setImmediate(r)); assert.deepEqual(order,['r1','r2']);
  assert.deepEqual(reasons,['file_resource','file_resource','file_resource']);
  assert.deepEqual(queueStatus({status:'running',resource_waits:{x:reasons[0]}}),{reason:'file_resource',label:'等待冲突的文件读写完成'});
  reads.open(); await Promise.all([first,second,writer,writer2,reader]); assert.deepEqual(order,['r1','r2','w1','w2','r3']);
});
test('queued cancellation and thrown work release reservations; input and file remain independent', async () => {
  const lock=new ResourceLocks(); const hold=gate(); const controller=new AbortController();
  const input=lock.run({kind:'input'},undefined,async()=>hold.waiting);
  const shell=lock.run({kind:'shell'},controller.signal,async()=>assert.fail('cancelled shell was started'));
  const reason:string[]=[];
  const write=lock.run(file('other','write'),undefined,async()=>{throw new Error('expected');},r=>reason.push(r));
  const rejection=assert.rejects(write,/expected/);
  controller.abort(); await assert.rejects(shell,/CANCELLED/); await rejection;
  assert.deepEqual(reason,['host_shell']);
  assert.equal(await lock.run(file('other','read'),undefined,async()=>42),42);
  hold.open(); await input;
  assert.equal(queueStatus({status:'queued',queue_reason:'device_capacity'})?.reason,'device_capacity');
  assert.equal(queueStatus({status:'failed',resource_waits:{x:'host_shell'}}),null);
});
