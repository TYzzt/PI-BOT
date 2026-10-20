import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export function run(command,args,cwd) {
  const result=spawnSync(command,args,{cwd,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status!==0) throw new Error(`${command} failed (${result.status})`);
}
export function prepareRuntime(root,runtime) {
  const require=createRequire(resolve(root,'package.json'));
  const manifests=['package.json','../packages/agent/package.json','../packages/a2ui/package.json'].map(file=>require(resolve(root,file)));
  const deps=['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','typebox','ws','zod','@a2ui/web_core','zod-to-json-schema'];
  rmSync(runtime,{recursive:true,force:true});
  mkdirSync(resolve(runtime,'bin'),{recursive:true}); mkdirSync(resolve(runtime,'licenses'));
  for (const file of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']) cpSync(resolve(root,'..',file),resolve(runtime,file));
  cpSync(resolve(root,'../packages/agent/src/hermes-memory/LICENSE'),resolve(runtime,'licenses/pi-hermes-memory-LICENSE'));
  cpSync(process.execPath,resolve(runtime,'bin/node'));
  for (const file of ['server.mjs','cli.mjs']) cpSync(resolve(root,'packages/service/dist',file),resolve(runtime,file));
  if (process.platform==='darwin') cpSync(resolve(root,'native/dist/keychain'),resolve(runtime,'keychain'));
  writeFileSync(resolve(runtime,'package.json'),JSON.stringify({name:'pi-bot-runtime',private:true,type:'module',dependencies:Object.fromEntries(deps.map(name=>[name,manifests.map(m=>m.dependencies?.[name]).find(Boolean)]))},null,2));
  run('npm',['install','--omit=dev','--no-package-lock','--ignore-scripts','--no-audit','--no-fund'],runtime);
}
