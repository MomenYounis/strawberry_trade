import http from 'node:http';
import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const derive=promisify(scrypt), projectId='strawberry-trade-261017-6a49b';
const directory=dirname(fileURLToPath(import.meta.url));
const token=()=>randomBytes(32).toString('base64url');
const passwordValid=p=>typeof p==='string'&&p.length>=12&&p.length<=200;
const stateDefault=join(homedir(),'.local/share/strawberry-trade-operator/admin-panel');
const messages={
  'login-required':'سجّل الدخول إلى لوحة الإدارة أولاً.',
  'wrong-password':'كلمة مرور اللوحة غير صحيحة.',
  'weak-password':'استخدم كلمة مرور للوحة من 12 حرفاً على الأقل.',
  'already-configured':'كلمة مرور اللوحة موجودة بالفعل؛ استخدم تسجيل الدخول.',
  'rate-limited':'محاولات دخول كثيرة. انتظر دقيقة ثم أعد المحاولة.',
  'request-refused':'تعذر قبول الطلب. افتح اللوحة من رابطها المحلي ثم أعد المحاولة.',
  'invalid-json':'بيانات الطلب غير صالحة.',
  'request-too-large':'الطلب أكبر من الحد المسموح.',
  'not-found':'الصفحة أو الإجراء غير موجود.',
  'operator-account-mismatch':'حساب Google الموجود على اللاب يختلف عن حساب المسؤول المحدد.',
  'operator-login-required':'يلزم توصيل حساب Firebase الخاص بالمسؤول على هذا اللاب.',
  'preview-expired':'انتهت صلاحية المراجعة. اعرض الإجراء مرة أخرى قبل التنفيذ.',
  'confirmation-mismatch':'نص التأكيد غير مطابق. انسخه كما يظهر في المراجعة.',
  'account-unverified':'يجب تأكيد البريد الإلكتروني للحساب قبل ربطه بالمنشأة.',
  'account-disabled':'الحساب موقوف؛ فعّله أولاً قبل إضافته.',
  'tenant-not-found':'المنشأة غير موجودة أو سبق حذفها.',
  'tenant-exists':'معرّف المنشأة مستخدم بالفعل؛ اختر معرّفاً آخر.',
  'device-limit-reached':'بلغت المنشأة حد الأجهزة. عدّل الحد من التفعيل قبل إضافة جهاز.',
  'internal-error':'تعذر إكمال الإجراء. حدّث البيانات وراجع الحالة قبل إعادة المحاولة.',
  'verified-enabled-account-required':'البريد يجب أن يكون مؤكداً والحساب مفعلاً قبل ربطه بالمنشأة.',
  'unverified-enabled-account-required':'إرسال التحقق متاح لحساب موجود ومفعّل لم يؤكد بريده بعد.',
  'account-already-exists':'البريد مستخدم بالفعل. ابحث عن الحساب الموجود بدلاً من إنشاء حساب آخر.',
  'account-lookup-failed':'تعذر قراءة الحساب. راجع اتصال الإدارة وأعد البحث.',
  'account-create-outcome-uncertain':'نتيجة إنشاء الحساب غير مؤكدة. ابحث عن البريد أولاً قبل محاولة إنشاء أخرى.',
  'verification-email-failed':'تعذر إرسال رسالة التحقق. الحساب الموجود محفوظ؛ راجع البريد وكلمة مروره ثم أعد إرسال التحقق.',
  'verification-delivery-failed':'تعذر إرسال رسالة التحقق الآن. أعد المحاولة من حسابات الدخول.',
  'manager-device-limit':'عدد الأجهزة النشطة يتجاوز الحد. عدّل حد الأجهزة من التفعيل أولاً.',
  'manager-device-limit-exceeded':'عدد أجهزة المديرين يتجاوز الحد. عدّل حد الأجهزة من التفعيل أولاً.',
  'membership-or-device-already-exists':'المدير أو الجهاز مسجل بالفعل داخل هذه المنشأة.',
  'tenant-or-owner-history-exists':'معرّف المنشأة أو صاحبها له تسجيل أو تجربة سابقة. استخدم المنشأة الأصلية ولا تبدأ تجربة جديدة.',
  'tenant-deleting':'المنشأة جارٍ حذفها. المتاح حالياً استكمال الحذف فقط.',
  'tenant-already-deleted':'المنشأة سبق حذفها نهائياً.',
  'tenant-delete-incomplete':'الحذف لم يكتمل. المنشأة موقوفة؛ استخدم استكمال الحذف لمراجعة وإزالة الباقي.',
  'tenant-recreated-during-deletion':'تغيرت المنشأة أثناء الحذف؛ توقف التنفيذ لحماية بياناتها. راجع حالتها قبل المتابعة.',
  'stale-preview':'البيانات تغيرت بعد المراجعة. حدّث المنشأة واعرض الإجراء مرة أخرى.',
  'preview-expired-or-missing':'انتهت صلاحية المراجعة. اعرض الإجراء مرة أخرى.',
  'action-in-progress':'الإجراء ما زال قيد التنفيذ. انتظر نتيجته قبل تكراره.',
  'invalid-device-request':'طلب الجهاز غير صحيح. انسخ الطلب كاملاً من التطبيق على الهاتف المقصود.',
  'invalid-id':'استخدم معرّفاً بالإنجليزية والأرقام والشرطة فقط، دون مسافات.',
  'invalid-email':'اكتب بريداً إلكترونياً صحيحاً.',
  'invalid-password':'كلمة مرور حساب التطبيق يجب أن تتكون من 8 إلى 128 حرفاً.',
  'invalid-number':'القيمة العددية خارج الحدود المسموح بها.',
  'invalid-text':'راجع الاسم أو النص المكتوب وأزل المسافات الزائدة.',
  'permanent-license-cannot-be-shortened':'المنشأة مفعلة بشكل دائم؛ لا يمكن تحويلها إلى تفعيل أقصر بهذه العملية.',
  'local-receipt-write-failed':'الإجراء نُفذ لكن حفظ إيصال محلي لم يكتمل. حدّث الحالة قبل إعادة التنفيذ.',
  'admin-action-incomplete':'نتيجة التنفيذ غير مؤكدة. حدّث بيانات المنشأة قبل محاولة جديدة.',
  'operator-session-refresh-failed':'تعذر تجديد اتصال حساب الإدارة. يلزم تسجيل دخوله مجدداً على هذا اللاب.',
  'unsafe-operator-environment':'إعداد تشغيل اللوحة غير مناسب للاتصال بالحساب الفعلي. افتحها من الاختصار المخصص.',
};
export function publicError(error){
  const raw=typeof error?.code==='string'?error.code:'';
  const code=/^[a-z][a-z0-9-]{0,79}$/.test(raw)?raw:'internal-error';
  const result={code,message:messages[code]||'تعذر قبول الإجراء. راجع بياناته واعرض المراجعة مرة أخرى.'};
  const details=error?.publicDetails||error?.details;
  if(details&&typeof details==='object'){
    result.details={};
    for(const key of ['accountCreated','emailSent','deletionPending','actionCompleted','retryAfterMs']){
      if(typeof details[key]==='boolean'||(key==='retryAfterMs'&&Number.isSafeInteger(details[key])))result.details[key]=details[key];
    }
  }
  return result;
}
function refuse(code,status=400){const error=Error(code);error.code=code;error.httpStatus=status;throw error;}
async function secureDirectory(path){
  const absolute=resolve(path);let current='/';
  for(const part of absolute.split('/').filter(Boolean)){
    current=join(current,part);try{const st=await lstat(current);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe-state-path');}
    catch(error){if(error.code!=='ENOENT')throw error;await mkdir(current,{mode:0o700});}
  }
  const state=await lstat(absolute);
  if((state.mode&0o077)||state.uid!==process.getuid?.())throw Error('private-state-directory-required');
}
export {secureDirectory as preparePrivateDirectory,stateDefault as DEFAULT_STATE_DIRECTORY};
async function readAuth(path){
  try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.())throw Error('private-auth-file-required');
    const value=JSON.parse(await readFile(path,'utf8'));
    if(value.version!==1||!/^[a-f0-9]{64}$/.test(value.salt)||!/^[a-f0-9]{128}$/.test(value.hash))throw Error('invalid-local-auth-file');return value;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function passwordHash(password,salt){return Buffer.from(await derive(password,Buffer.from(salt,'hex'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024}));}

/** Loopback-only HTTP UI. Backend clients are loaded only after local authentication. */
export async function createPanelServer({stateDirectory=stateDefault,operationsFactory,demo=false,port=8765}={}){
  await secureDirectory(stateDirectory);
  const authPath=join(stateDirectory,'auth.json');let auth=await readAuth(authPath),opsPromise;
  const sessions=new Map(),attempts={count:0,until:0};let setupBusy=false,origin;
  const getOps=()=>opsPromise??=(async()=>{
    if(operationsFactory)return operationsFactory();
    const {createProductionClients}=await import('./credentials.mjs');
    const {createAdminOperations}=await import('./operations.mjs');
    const clients=await createProductionClients();
    return {...createAdminOperations({...clients,receiptDirectory:join(stateDirectory,'receipts')}),close:clients.close};
  })().catch(error=>{opsPromise=undefined;throw error;});
  const makeSession=(authenticated=false)=>{
    const value={id:token(),csrf:token(),authenticated,expires:Date.now()+(authenticated?8*3600000:600000)};sessions.set(value.id,value);return value;
  };
  const sessionFor=req=>{
    const id=/(?:^|;\s*)strawberry_admin=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    const session=sessions.get(id);if(session&&session.expires>Date.now())return session;
    if(session)sessions.delete(id);return null;
  };
  function send(res,status,value,session){
    if(session)res.setHeader('Set-Cookie',`strawberry_admin=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${session.authenticated?28800:600}`);
    res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));
  }
  function sessionView(session){return{configured:!!auth,authenticated:session.authenticated,csrfToken:session.csrf,projectId,demo};}
  async function json(req){
    if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||''))refuse('invalid-json');
    let total=0;const chunks=[];
    for await(const chunk of req){total+=chunk.length;if(total>65536)refuse('request-too-large',413);chunks.push(chunk);}
    try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}
    catch{refuse('invalid-json');}
  }
  const server=http.createServer(async(req,res)=>{
    for(const [key,value] of Object.entries({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"}))res.setHeader(key,value);
    try{
      if(req.headers.host!==new URL(origin).host)refuse('request-refused',403);
      if(req.headers.origin&&req.headers.origin!==origin)refuse('request-refused',403);
      if(req.headers['sec-fetch-site']==='cross-site')refuse('request-refused',403);
      const url=new URL(req.url,origin);
      if(url.origin!==origin)refuse('request-refused',403);
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{status:'ok',app:'strawberry-admin-panel-v1',localOnly:true});
      if(req.method==='GET'&&['/','/index.html','/app.js','/styles.css','/icon.svg'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);let data;
        try{data=await readFile(join(directory,'public',file));}catch{refuse('not-found',404);}
        res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});return res.end(data);
      }
      if(!url.pathname.startsWith('/api/'))refuse('not-found',404);
      let session=sessionFor(req);
      if(req.method==='GET'&&url.pathname==='/api/session'){
        session??=makeSession();return send(res,200,sessionView(session),session);
      }
      if(req.method!=='GET'){
        if(req.method!=='POST'||req.headers.origin!==origin||!session||req.headers['x-csrf-token']!==session.csrf)refuse('request-refused',403);
      }
      if(req.method==='POST'&&['/api/setup','/api/login'].includes(url.pathname)){
        const body=await json(req);if(Object.keys(body).some(key=>key!=='password'))refuse('invalid-json');
        if(attempts.until>Date.now())refuse('rate-limited',429);
        if(url.pathname==='/api/setup'){
          if(auth||setupBusy)refuse('already-configured',409);
          if(!passwordValid(body.password))refuse('weak-password');
          setupBusy=true;try{
            const salt=randomBytes(32).toString('hex');const hash=(await passwordHash(body.password,salt)).toString('hex');
            await writeFile(authPath,JSON.stringify({version:1,salt,hash})+'\n',{flag:'wx',mode:0o600});auth={version:1,salt,hash};
          }finally{setupBusy=false;}
        }else{
          if(!auth||typeof body.password!=='string'||body.password.length>200)refuse('wrong-password',401);
          const hash=await passwordHash(body.password,auth.salt);
          if(!timingSafeEqual(hash,Buffer.from(auth.hash,'hex'))){attempts.count++;if(attempts.count>=5){attempts.until=Date.now()+60000;attempts.count=0;}refuse('wrong-password',401);}
        }
        attempts.count=0;attempts.until=0;sessions.delete(session.id);session=makeSession(true);return send(res,200,sessionView(session),session);
      }
      if(!session?.authenticated)refuse('login-required',401);
      if(req.method==='POST'&&url.pathname==='/api/logout'){
        await json(req);sessions.delete(session.id);session=makeSession(false);return send(res,200,sessionView(session),session);
      }
      const ops=await getOps();
      if(req.method==='GET'&&url.pathname==='/api/tenants')return send(res,200,{result:await ops.listTenants({limit:50,...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{})})});
      if(req.method==='GET'&&/^\/api\/tenants\/[A-Za-z0-9_-]{1,120}$/.test(url.pathname))return send(res,200,{result:await ops.tenantDetail({tenantId:url.pathname.split('/').at(-1)})});
      if(req.method==='POST'&&url.pathname==='/api/accounts/lookup')return send(res,200,{result:await ops.lookupAccount(await json(req))});
      if(req.method==='POST'&&['/api/preview','/api/accounts'].includes(url.pathname)){
        const body=await json(req);const preview=await ops.previewAction(url.pathname==='/api/accounts'?{...body,type:'create-account'}:body);
        return send(res,200,{...preview,id:preview.previewId,details:preview.summary,expiresAt:preview.expiresAtMs});
      }
      if(req.method==='POST'&&url.pathname==='/api/execute'){
        const body=await json(req);if(Object.keys(body).some(key=>!['previewId','confirmationText'].includes(key)))refuse('invalid-json');
        return send(res,200,{result:await ops.executeAction({previewId:body.previewId,confirmation:body.confirmationText})});
      }
      refuse('not-found',404);
    }catch(error){
      if(!res.headersSent)send(res,Number.isInteger(error.httpStatus)?error.httpStatus:400,{error:publicError(error)});else res.end();
    }
  });
  server.headersTimeout=10000;server.requestTimeout=120000;server.keepAliveTimeout=5000;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;done();});});
  const cleanup=setInterval(()=>{for(const [id,s] of sessions)if(s.expires<=Date.now())sessions.delete(id);},60000);cleanup.unref();
  return {server,url:origin,stateDirectory,async close(){clearInterval(cleanup);sessions.clear();const ops=await opsPromise?.catch(()=>null);await ops?.close?.();await new Promise(done=>server.close(done));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const portArg=process.argv.find(x=>x.startsWith('--port='));
  if(process.argv.slice(2).some(x=>!/^--port=\d{1,5}$/.test(x))){console.error('Invalid local panel option.');process.exitCode=2;}
  else{
    try{
      const panel=await createPanelServer({port:portArg?Number(portArg.slice(7)):8765});console.log('Local administration panel: '+panel.url);
      for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>panel.close().finally(()=>process.exit(0)));
    }catch{console.error('Local administration panel could not start. Check its private settings and port.');process.exitCode=1;}
  }
}
