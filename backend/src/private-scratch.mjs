// Marker-restricted cleanup for this operator's private plaintext scratch.
// This is crash hygiene, not secure erasure or encrypted-volume acceptance.
import {mkdtemp,lstat,readFile,writeFile,opendir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const prefix='strawberry-private-scratch-',marker='.strawberry-owner.json';
const bootPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function bootId(){const value=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();if(!bootPattern.test(value))throw Error('linux-boot-identity-required');return value;}
async function startTicks(pid){
 try{const s=await readFile(`/proc/${pid}/stat`,'utf8'),value=s.slice(s.lastIndexOf(')')+2).split(' ')[19];return /^\d+$/.test(value??'')?value:undefined;}
 catch(error){return ['ENOENT','ESRCH'].includes(error.code)?null:undefined;}
}
export async function createPrivateScratch(purpose,{base=tmpdir(),now=Date.now}={}){
 if(!/^[a-z_-]{1,40}$/.test(purpose))throw Error('scratch-purpose-required');
 const directory=await mkdtemp(join(resolve(base),prefix));
 try{const owner={version:2,uid:process.getuid(),pid:process.pid,startTicks:await startTicks(process.pid),bootId:await bootId(),purpose,createdAtMs:now()};
  if(!owner.startTicks)throw Error('linux-process-identity-required');
  await writeFile(join(directory,marker),JSON.stringify(owner),{mode:0o600,flag:'wx'});
  return {directory,async destroy(){await rm(directory,{recursive:true,force:true});}};
 }catch(e){await rm(directory,{recursive:true,force:true});throw e;}
}
export async function sweepPrivateScratch({base=tmpdir(),minAgeMs=3_600_000,maxEntries=10_000,now=Date.now}={}){
 if(!Number.isSafeInteger(minAgeMs)||minAgeMs<60_000)throw Error('scratch-grace-required');
 if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>100_000)throw Error('scratch-scan-limit-required');
 const currentBoot=await bootId(),result={removed:0,skipped:0,scanned:0,truncated:false};
 for await(const entry of await opendir(resolve(base))){
  if(result.scanned===maxEntries){result.truncated=true;break;}
  result.scanned++;const name=entry.name;
  if(!name.startsWith(prefix))continue;const directory=join(resolve(base),name);
  try{
   const stat=await lstat(directory),markStat=await lstat(join(directory,marker));
   if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||!markStat.isFile()||markStat.isSymbolicLink()||markStat.uid!==stat.uid||(markStat.mode&0o077)!==0||markStat.size>2048)throw Error('unowned');
   const owner=JSON.parse(await readFile(join(directory,marker),'utf8'));
   if(![1,2].includes(owner.version)||owner.uid!==stat.uid||!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.startTicks!=='string'||!/^\d+$/.test(owner.startTicks)||!Number.isSafeInteger(owner.createdAtMs)||owner.createdAtMs<0||owner.createdAtMs>now()-minAgeMs||(owner.version===2&&!bootPattern.test(owner.bootId??'')))throw Error('unowned-or-recent');
   // PIDs and boot-relative ticks can repeat after reboot. An older boot can
   // never own a live process here. Unknown /proc errors retain scratch.
   if(owner.version===1||owner.bootId===currentBoot){const ticks=await startTicks(owner.pid);if(ticks===undefined||ticks===owner.startTicks){result.skipped++;continue;}}
   await rm(directory,{recursive:true,force:true});result.removed++;
  }catch{result.skipped++;}
 }
 return result;
}
