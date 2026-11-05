import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {mkdtemp,readFile,writeFile,mkdir,symlink,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPrivateScratch,sweepPrivateScratch} from '../src/private-scratch.mjs';
test('SIGKILL startup sweep removes only dead marked scratch; live, recent, unmarked and symlink data survive',async()=>{
 const base=await mkdtemp(join(tmpdir(),'scratch-sweeper-test-'));let child;
 try{
  const moduleUrl=new URL('../src/private-scratch.mjs',import.meta.url).href;
  child=spawn(process.execPath,['--input-type=module','-e',`import {createPrivateScratch} from ${JSON.stringify(moduleUrl)};const s=await createPrivateScratch('kill_fixture',{base:${JSON.stringify(base)}});console.log(s.directory);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  const [bytes]=await once(child.stdout,'data'),dead=bytes.toString().trim();assert.ok(dead.startsWith(base+'/strawberry-private-scratch-'));
  const live=await createPrivateScratch('live_fixture',{base});
  const unmarked=join(base,'strawberry-private-scratch-unmarked');await mkdir(unmarked,{mode:0o700});await writeFile(join(unmarked,'keep'),'synthetic retained');
  await symlink(dead,join(base,'strawberry-private-scratch-symlink'));
  assert.equal((await sweepPrivateScratch({base,minAgeMs:60_000,now:()=>Date.now()+61_000})).removed,0);
  child.kill('SIGKILL');await once(child,'exit');
  assert.equal((await sweepPrivateScratch({base,minAgeMs:60_000})).removed,0);
  const result=await sweepPrivateScratch({base,minAgeMs:60_000,now:()=>Date.now()+61_000});assert.equal(result.removed,1);
  await assert.rejects(stat(dead),{code:'ENOENT'});assert.equal(await readFile(join(unmarked,'keep'),'utf8'),'synthetic retained');await stat(live.directory);await live.destroy();
 }finally{child?.kill('SIGKILL');await rm(base,{recursive:true,force:true});}
});
test('boot identity prevents reboot PID/tick collisions from retaining dead scratch',async()=>{
 const base=await mkdtemp(join(tmpdir(),'scratch-reboot-test-'));
 try{
  const priorBoot=await createPrivateScratch('prior_boot',{base}),marker=join(priorBoot.directory,'.strawberry-owner.json');
  const owner=JSON.parse(await readFile(marker,'utf8'));assert.equal(owner.version,2);assert.ok(owner.bootId);
  owner.bootId=owner.bootId==='00000000-0000-0000-0000-000000000000'?'11111111-1111-1111-1111-111111111111':'00000000-0000-0000-0000-000000000000';
  await writeFile(marker,JSON.stringify(owner));
  const current=await createPrivateScratch('current_boot',{base});
  const result=await sweepPrivateScratch({base,minAgeMs:60_000,now:()=>Date.now()+61_000});
  assert.equal(result.removed,1);await assert.rejects(stat(priorBoot.directory),{code:'ENOENT'});await stat(current.directory);
  await current.destroy();
 }finally{await rm(base,{recursive:true,force:true});}
});
test('scratch sweep streams a bounded number of directory entries and rejects invalid scan limits',async()=>{
 const base=await mkdtemp(join(tmpdir(),'scratch-bound-test-'));
 try{
  for(let index=0;index<10;index++)await mkdir(join(base,'unrelated_'+index));
  const result=await sweepPrivateScratch({base,maxEntries:3});assert.equal(result.scanned,3);assert.equal(result.truncated,true);assert.equal(result.removed,0);
  for(const maxEntries of [0,-1,100001,1.5])await assert.rejects(sweepPrivateScratch({base,maxEntries}),/scratch-scan-limit/);
 }finally{await rm(base,{recursive:true,force:true});}
});
