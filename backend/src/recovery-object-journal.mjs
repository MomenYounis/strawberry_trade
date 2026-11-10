// Local durable progress only. No credentials or object plaintext are journaled.
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,lstat,writeFile,chmod,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {canonical} from './validation.mjs';
import {readRecoveryObjectHandleBounded} from './recovery-object-local-storage.mjs';
const marker='.strawberry-recovery-object-owner.json',prefix='strawberry-recovery-object-journal-';
function fail(reason){throw Error('recovery-object-journal-'+reason);}
function encoded(value){const bytes=canonical(value);if(Buffer.byteLength(bytes)>16_384)fail('size');return bytes;}
export async function createRecoveryObjectLocalJournal({base=tmpdir()}={}){
 const directory=await mkdtemp(join(resolve(base),prefix));await chmod(directory,0o700);
 await writeFile(join(directory,marker),canonical({format:'strawberry-recovery-object-journal',version:1,uid:process.getuid()}),{flag:'wx',mode:0o600});
 return openRecoveryObjectLocalJournal({directory});
}
export async function openRecoveryObjectLocalJournal({directory}){
 if(typeof directory!=='string'||!basename(directory).startsWith(prefix))fail('owned-directory-required');directory=resolve(directory);
 for(const [path,type,maxBytes]of [[directory,'directory',Infinity],[join(directory,marker),'file',1024]]){
  const stat=await lstat(path);if(stat.isSymbolicLink()||!stat[type==='directory'?'isDirectory':'isFile']()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>maxBytes)fail('owned-directory-required');
 }
 const markerHandle=await open(join(directory,marker),constants.O_RDONLY|constants.O_NOFOLLOW);let owner;try{owner=JSON.parse((await readRecoveryObjectHandleBounded(markerHandle,1024)).toString('utf8'));}finally{await markerHandle.close();}if(encoded(owner)!==encoded({format:'strawberry-recovery-object-journal',version:1,uid:process.getuid()}))fail('owner');
 const path=join(directory,'progress.sqlite');try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>16_777_216)fail('database');}catch(error){if(error.code!=='ENOENT')throw error;}
 const db=new DatabaseSync(path);await chmod(path,0o600);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');let closed=false;
 function check(key){if(closed)fail('closed');if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))fail('key');}
 return Object.freeze({directory,kind:'local-sqlite-journal',productionRecoveryAccepted:false,
  async load(key){check(key);const row=db.prepare('SELECT payload FROM progress WHERE id=?').get(key);return row?JSON.parse(row.payload):null;},
  async compareAndSwap(key,previous,next){check(key);const before=previous===null?null:encoded(previous),after=encoded(next);db.exec('BEGIN IMMEDIATE');try{const found=db.prepare('SELECT payload FROM progress WHERE id=?').get(key)?.payload??null;if(found!==before)fail('changed');if(found===null){if(db.prepare('SELECT count(*) AS n FROM progress').get().n>=1000)fail('run-limit');db.prepare('INSERT INTO progress(id,payload) VALUES(?,?)').run(key,after);}else db.prepare('UPDATE progress SET payload=? WHERE id=?').run(after,key);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
  async close(){if(closed)return;closed=true;db.close();},
 });
}
