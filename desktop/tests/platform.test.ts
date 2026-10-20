import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDataDir, commandShell } from '../packages/service/src/platform.js';
import { Hub, type DeviceConnection } from '../../server/src/hub.js';

test('Linux uses XDG data directories and bash without changing macOS defaults', () => {
  assert.equal(defaultDataDir('linux',{},'/home/test'),'/home/test/.local/share/pi-bot');
  assert.equal(defaultDataDir('linux',{XDG_DATA_HOME:'/data'},'/home/test'),'/data/pi-bot');
  assert.equal(defaultDataDir('linux',{XDG_DATA_HOME:'relative'},'/home/test'),'/home/test/.local/share/pi-bot');
  assert.equal(defaultDataDir('darwin',{},'/Users/test'),'/Users/test/Library/Application Support/Pi Bot');
  assert.equal(defaultDataDir('linux',{PI_BOT_DATA_DIR:'/custom'},'/home/test'),'/custom');
  assert.equal(commandShell('linux',{}),'/bin/bash');
  assert.equal(commandShell('linux',{PI_BOT_SHELL:'/bin/sh'}),'/bin/sh');
  assert.throws(()=>commandShell('linux',{PI_BOT_SHELL:'bash'}),/绝对路径/);
  assert.throws(()=>commandShell('linux',{PI_BOT_SHELL:'/no-such-pi-bot-shell'}),/不可执行/);
});

test('two devices coexist, RPC is pinned and only a reconnect of the same identity replaces a connection', async () => {
  const hub=new Hub(), frames: Record<string,any[]>={a:[],b:[],other:[]}, closed:string[]=[];
  const connection=(id:string,userId='user'):DeviceConnection=>({deviceId:id,userId,send:m=>frames[id].push(m),close:()=>closed.push(id)});
  const a=connection('a'),b=connection('b'),other=connection('other','other-user');
  hub.attach(a); hub.attach(b); hub.attach(other);
  assert.equal(hub.count(),3); assert.deepEqual(closed,[]);
  assert.equal(hub.device('user','a'),a); assert.equal(hub.device('other-user','a'),undefined);
  const rpc=hub.rpc('user','files.list',{},1000,'a');
  const request=frames.a.find(m=>m.type==='rpc');
  assert.ok(request); assert.ok(!frames.b.some(m=>m.type==='rpc'));
  hub.resolveRpc('b',{id:request.id,ok:true,result:'wrong'});
  hub.resolveRpc('a',{id:request.id,ok:true,result:'correct'});
  assert.equal(await rpc,'correct');
  hub.detach(a); assert.equal(hub.online('user'),true);
  assert.ok(frames.b.some(m=>m.event?.type==='presence' && m.event.device_id==='a' && !m.event.device_online && m.event.online));
  const replacement=connection('b'); hub.attach(replacement);
  assert.deepEqual(closed,['b']); assert.equal(hub.detach(b),false);
  assert.equal(hub.device('user','b'),replacement);
  hub.detach(replacement); assert.equal(hub.online('user'),false);
});

test('replacing a socket rejects its outstanding file RPC instead of leaving it until timeout', async () => {
  const hub = new Hub();
  const conn = (): DeviceConnection => ({deviceId:'same',userId:'user',send() {},close() {}});
  const first = conn(); hub.attach(first);
  const pending = assert.rejects(hub.rpc('user','files.list',{},60000,'same'), /离线/);
  const replacement = conn(); hub.attach(replacement);
  await pending;
  assert.equal(hub.device('user','same'), replacement);
});
