import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneAdb, isPhoneAdbCommand, PhoneController } from '../src/index.js';
const skip = process.platform !== 'linux' && 'Configured ADB requires Linux/flock';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'phone-adb-')),path=join(root,'phone.json'),log=join(root,'argv.jsonl'),offline=join(root,'offline');
 const adb=join(root,'adb.cjs'),ffmpeg=join(root,'ffmpeg.cjs');
 writeFileSync(adb,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(fs.existsSync(${JSON.stringify(offline)}))process.exit(1);
if(args.includes('screencap')){const b=Buffer.alloc(24);b.writeUInt32BE(720,16);b.writeUInt32BE(1280,20);process.stdout.write(b);}
else if(args.includes('get-state'))process.stdout.write('device');
else if(args.includes('slow'))setTimeout(()=>{},30000);
else process.stdout.write(JSON.stringify(args));
`,{mode:0o700});
 writeFileSync(ffmpeg,`#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([255,216,255,217])));
`,{mode:0o700});
 const config={enabled:true,adbPath:adb,ffmpegPath:ffmpeg,lockPath:join(root,'lock'),serial:'assigned-42',adbPort:15039};
 const save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
 return {root,path,log,offline,config,save,bridge:PhoneAdb.open(path)!,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('phone command context is opt-in and reports the pinned target without adding tools', {skip}, async()=>{
 const f=fixture();try {
  assert.equal(PhoneAdb.open(join(f.root,'missing')),undefined);
  assert.ok(isPhoneAdbCommand('  phone-adb shell input keyevent 3'));
  assert.equal(isPhoneAdbCommand('echo phone-adb'),false);
  const chat=await f.bridge.environment(true,false,false);
  assert.match(chat,/assigned-42.*15039.*在线/s);assert.match(chat,/start_task/);
  assert.match(await f.bridge.environment(false,false,false),/run_command.*phone-adb/s);
  assert.match(await f.bridge.environment(false,true,false),/只读目标检查/);
  writeFileSync(f.offline,'1');assert.match(await f.bridge.environment(true,false,false),/无法连接/);
  chmodSync(f.path,0o644);assert.equal(PhoneAdb.open(f.path),undefined);
 }finally{f.cleanup();}
});
test('ADB argv is pinned, literal quoted input works, and discovery/host-shell syntax is rejected', {skip},async()=>{
 const f=fixture();try {
  const result=await f.bridge.command(`phone-adb shell input text 'hello world'`,2000);
  const body=JSON.parse(result.content[0].text!);assert.equal(body.exit_code,0);
  assert.deepEqual(JSON.parse(body.output),['-H','127.0.0.1','-P','15039','-s','assigned-42','shell','input','text','hello world']);
  for(const command of ['phone-adb devices','phone-adb -s other shell id','phone-adb connect 1.2.3.4','phone-adb shell id; touch /tmp/wrong','phone-adb shell id | cat','phone-adb shell $(id)','phone-adb shell "unclosed','phone-adb shell id\nphone-adb shell id'])
   await assert.rejects(f.bridge.command(command,2000));
  assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,1);
  f.config.serial='other';f.save();await assert.rejects(f.bridge.command('phone-adb shell id',2000),/配置已变更/);
 }finally{f.cleanup();}
});
test('screenshot is image content, and manual control shares the exact ADB lock', {skip},async()=>{
 const f=fixture(),phone=new PhoneController(f.path);try {
  const frame=await f.bridge.command('phone-adb exec-out screencap -p',2000);
  assert.equal(frame.content[1].type,'image');assert.equal(frame.content[1].mimeType,'image/jpeg');
  assert.deepEqual(Buffer.from(frame.content[1].data!,'base64'),Buffer.from([255,216,255,217]));
  assert.ok(!frame.content[0].text!.includes('/9j/'));
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  await assert.rejects(f.bridge.command('phone-adb shell input keyevent 3',2000),/占用/);
  await phone.call('phone.release',{sessionId});await new Promise(r=>setTimeout(r,100));
  assert.equal(JSON.parse((await f.bridge.command('phone-adb get-state',2000)).content[0].text!).exit_code,0);
 }finally{phone.close();await new Promise(r=>setTimeout(r,100));f.cleanup();}
});
test('cancelled and timed-out ADB commands terminate the process group and free the lock', {skip},async()=>{
 const f=fixture();try {
  const controller=new AbortController();const command=f.bridge.command('phone-adb shell slow',10000,controller.signal);
  const rejected=assert.rejects(command,/CANCELLED/);
  for(let i=0;i<50&&(!existsSync(f.log)||!readFileSync(f.log,'utf8').includes('slow'));i++)await new Promise(r=>setTimeout(r,20));
  controller.abort();await rejected;
  assert.equal(JSON.parse((await f.bridge.command('phone-adb get-state',2000)).content[0].text!).exit_code,0);
  assert.equal(JSON.parse((await f.bridge.command('phone-adb shell slow',1000)).content[0].text!).timed_out,true);
  assert.equal(JSON.parse((await f.bridge.command('phone-adb get-state',2000)).content[0].text!).exit_code,0);
 }finally{f.cleanup();}
});
