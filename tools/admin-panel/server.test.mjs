import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {createPanelServer,publicError} from './server.mjs';

async function fixture(){
  const stateDirectory=await mkdtemp(join(tmpdir(),'strawberry-panel-test-'));
  const activity={loaded:0,reads:0,writes:0,previews:0};
  const panel=await createPanelServer({port:0,stateDirectory,operationsFactory:async()=>{
    activity.loaded++;return{
      async listTenants(){activity.reads++;return{tenants:[]};},
      async lookupAccount({email}){activity.reads++;return{email,verified:true};},
      async previewAction(action){activity.previews++;return{previewId:'synthetic-preview',confirmationText:'APPLY synthetic',summary:{type:action.type}};},
      async executeAction(input){assert.equal(input.previewId,'synthetic-preview');assert.equal(input.confirmation,'APPLY synthetic');activity.writes++;return{status:'done'};},
    };
  }});
  let cookie='',csrf='';
  async function request(path,{method='GET',body,origin=panel.url,headers={}}={}){
    const response=await fetch(panel.url+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json',origin,'x-csrf-token':csrf}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json();const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
    if(data.csrfToken)csrf=data.csrfToken;return{response,data};
  }
  return{panel,activity,request,get cookie(){return cookie;},get csrf(){return csrf;},async close(){await panel.close();await rm(stateDirectory,{recursive:true,force:true});}};
}
test('unauthenticated page/session never load cloud credentials; setup stores only a private password hash',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/api/tenants')).response.status,401);
    const initial=await f.request('/api/session');assert.equal(initial.data.configured,false);assert.equal(initial.data.authenticated,false);assert.equal(f.activity.loaded,0);
    assert.match(initial.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    const password='synthetic-panel-password';const setup=await f.request('/api/setup',{method:'POST',body:{password}});
    assert.equal(setup.data.authenticated,true);assert.equal(f.activity.loaded,0);
    const stored=await readFile(join(f.panel.stateDirectory,'auth.json'),'utf8');assert.ok(!stored.includes(password));assert.equal(JSON.parse(stored).hash.length,128);
    assert.equal((await stat(join(f.panel.stateDirectory,'auth.json'))).mode&0o777,0o600);
    assert.equal((await f.request('/api/tenants')).response.status,200);assert.equal(f.activity.loaded,1);assert.equal(f.activity.reads,1);assert.equal(f.activity.writes,0);
  }finally{await f.close();}
});
test('cross-origin, forged Host, missing CSRF and unauthenticated mutations refuse before operations',async()=>{
  const f=await fixture();try{
    await f.request('/api/session');
    assert.equal((await f.request('/api/setup',{method:'POST',body:{password:'synthetic-password'},origin:'https://foreign.invalid'})).response.status,403);
    const hostStatus=await new Promise((done,reject)=>{const req=httpRequest(f.panel.url+'/api/session',{headers:{Host:'foreign.invalid'}},res=>{res.resume();res.on('end',()=>done(res.statusCode));});req.on('error',reject);req.end();});
    assert.equal(hostStatus,403);
    assert.equal((await f.request('/api/session',{headers:{Origin:'https://foreign.invalid'}})).response.status,403);
    assert.equal((await f.request('/api/setup',{method:'POST',body:{password:'synthetic-password'},headers:{'x-csrf-token':'forged'}})).response.status,403);
    assert.equal((await f.request('/api/execute',{method:'POST',body:{previewId:'synthetic-preview',confirmationText:'APPLY synthetic'}})).response.status,401);
    assert.equal(f.activity.loaded,0);assert.equal(f.activity.writes,0);
  }finally{await f.close();}
});
test('preview is read-only, execute carries only reviewed identifier/confirmation and logout invalidates session',async()=>{
  const f=await fixture();try{
    await f.request('/api/session');await f.request('/api/setup',{method:'POST',body:{password:'synthetic-admin-password'}});
    const result=await f.request('/api/preview',{method:'POST',body:{type:'delete-tenant',tenantId:'synthetic'}});
    assert.equal(result.data.id,'synthetic-preview');assert.equal(f.activity.previews,1);assert.equal(f.activity.writes,0);
    assert.equal((await f.request('/api/execute',{method:'POST',body:{previewId:'synthetic-preview',confirmationText:'APPLY synthetic',tenantId:'different'}})).response.status,400);
    assert.equal(f.activity.writes,0);
    assert.equal((await f.request('/api/execute',{method:'POST',body:{previewId:'synthetic-preview',confirmationText:'APPLY synthetic'}})).response.status,200);assert.equal(f.activity.writes,1);
    await f.request('/api/logout',{method:'POST',body:{}});assert.equal((await f.request('/api/tenants')).response.status,401);
    assert.equal((await f.request('/api/login',{method:'POST',body:{password:'wrong-but-synthetic'}})).response.status,401);
    assert.equal((await f.request('/api/login',{method:'POST',body:{password:'synthetic-admin-password'}})).data.authenticated,true);
  }finally{await f.close();}
});
test('private files and arbitrary error messages/keys are never exposed through HTTP or error envelopes',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/credentials.mjs')).response.status,404);
    const e=Object.assign(Error('SENSITIVE_PROVIDER_BODY'),{code:403,private_key:'DO_NOT_RETURN',publicDetails:{accountCreated:true,password:'DO_NOT_RETURN'}});
    const result=publicError(e);assert.equal(result.code,'internal-error');assert.equal(result.details.accountCreated,true);assert.ok(!JSON.stringify(result).includes('DO_NOT_RETURN'));assert.ok(!JSON.stringify(result).includes('SENSITIVE'));
    assert.match((await f.request('/health')).response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }finally{await f.close();}
});
test('server refuses a symbolic link state directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'strawberry-panel-symlink-'));try{
    await symlink(root,join(root,'link'));await assert.rejects(createPanelServer({stateDirectory:join(root,'link'),port:0}),/unsafe-state-path/);
  }finally{await rm(root,{recursive:true,force:true});}
});
