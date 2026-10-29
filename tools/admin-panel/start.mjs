#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {open,constants} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePrivateDirectory,DEFAULT_STATE_DIRECTORY} from './server.mjs';

const url='http://127.0.0.1:8765';
async function running(){try{const response=await fetch(url+'/health',{signal:AbortSignal.timeout(750)});return response.ok&&(await response.json()).app==='strawberry-admin-panel-v1';}catch{return false;}}
try{
  if(!await running()){
    await preparePrivateDirectory(DEFAULT_STATE_DIRECTORY);
    const log=await open(join(DEFAULT_STATE_DIRECTORY,'server.log'),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    const stat=await log.stat();if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw Error('private-log-required');
    const allowed=['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'];
    const env=Object.fromEntries(allowed.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
    const child=spawn(process.execPath,['--no-deprecation',fileURLToPath(new URL('./server.mjs',import.meta.url))],{detached:true,stdio:['ignore',log.fd,log.fd],env});
    child.unref();await log.close();
    let ready=false;for(let i=0;i<30;i++){if(await running()){ready=true;break;}await new Promise(done=>setTimeout(done,250));}
    if(!ready)throw Error('local-server-not-ready');
  }
  console.log('لوحة الإدارة: '+url);
  if(!process.argv.includes('--no-browser')){const browser=spawn('xdg-open',[url],{detached:true,stdio:'ignore'});browser.on('error',()=>{});browser.unref();}
}catch{console.error('تعذر فتح لوحة الإدارة. تأكد أن المنفذ 8765 متاح وأن ملفاتها موجودة على اللاب.');process.exitCode=1;}
