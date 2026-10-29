'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const number = value => new Intl.NumberFormat('ar-EG').format(value);
const date = value => Number.isFinite(Number(value)) && Number(value)>0 ? new Intl.DateTimeFormat('ar-EG',{dateStyle:'medium'}).format(new Date(Number(value))) : 'غير محدد';
const state = {session:{}, view:'tenants', tenants:[], nextCursor:null, search:'', filter:'all', loading:false, listError:'', tenantId:null, detail:null, detailTab:'overview', lookups:new Map(), preview:null, executing:false, previewTimer:null, resultTimer:null, detailTimer:null, downloads:[], pendingDeletion:null};

const labels = {
  tenantId:'معرّف المنشأة',businessName:'اسم المنشأة',name:'الاسم',ownerUid:'معرّف حساب المالك',uid:'معرّف الحساب',email:'البريد الإلكتروني',expectedEmail:'البريد الإلكتروني',displayName:'اسم صاحب الحساب',deviceId:'معرّف الهاتف',maxDevices:'الحد الأقصى لهواتف المدير',activeManagerDevices:'هواتف المديرين المفعّلة',trialDays:'مدة التجربة بالأيام',globalSessionRevocation:'إلغاء جلسات الحساب الحالية',sendVerificationEmail:'إرسال رسالة تأكيد البريد',willCreateUnverified:'يحتاج الحساب تأكيد بريده',from:'الحالة الحالية',to:'الحالة الجديدة',enabled:'المنشأة مفعّلة',active:'الحساب مفعّل',offlineCopiesUnaffected:'الأجهزة غير المتصلة تحتاج استلام التحديث',unit:'نوع مدة التفعيل',count:'مدة التفعيل',previousExpiryMs:'نهاية التفعيل السابقة',perpetual:'تفعيل دائم',preservesTrial:'يُحفظ تاريخ التجربة الأصلي',permanent:'حذف نهائي',cloudChildrenDeleted:'حذف جميع البيانات التابعة للمنشأة',authUsersKept:'تظل حسابات تسجيل الدخول محفوظة',minimalHistoryKept:'يُحفظ سجل مختصر يمنع إعادة التجربة',offlineCopiesRemain:'النسخ الموجودة على الأجهزة لا تُمحى عن بُعد',resuming:'متابعة حذف بدأ سابقًا',quietWindowSeconds:'مدة الانتظار قبل المتابعة بالثواني',emailVerified:'البريد مؤكّد',disabled:'الحساب موقوف',status:'النتيجة',tenantName:'اسم المنشأة',trialStartMs:'بداية التجربة',trialEndMs:'نهاية التجربة',expiresAtMs:'نهاية التفعيل',paidUntilMs:'التفعيل حتى',verificationEmailSent:'أُرسلت رسالة تأكيد البريد',deleted:'تم الحذف',deletedDocuments:'السجلات المحذوفة',role:'الصلاحية',licenseId:'معرّف التفعيل',epoch:'إصدار التفعيل',membershipCount:'الحسابات المرتبطة',deviceCount:'عدد الهواتف',managerDeviceCount:'هواتف المديرين',created:'تم الإنشاء',updated:'تم التحديث',owner:'المالك',account:'الحساب',result:'النتيجة',operationId:'مرجع العملية',nextCheckAfterMs:'موعد متابعة الحذف',managerName:'اسم المدير',remaining:'المتبقي',processed:'السجلات التي عولجت',complete:'اكتملت العملية',entitlementEpoch:'إصدار التفعيل',accountCreated:'أُنشئ حساب الدخول'
};
const actionTitles = {'create-tenant':'إنشاء منشأة جديدة','add-manager':'إضافة مدير وربط هاتفه','set-tenant-enabled':'تغيير حالة المنشأة','set-member-active':'تغيير صلاحية الحساب','activate-license':'تفعيل المنشأة','delete-tenant':'حذف المنشأة نهائيًا','create-account':'إنشاء حساب دخول','send-verification-email':'إرسال رسالة تأكيد البريد'};
const secretKey = key => /password|secret|token|credential|private.?key/i.test(key);

async function api(path,{method='GET',body}={}) {
  const headers = {Accept:'application/json'};
  if (method!=='GET') {headers['Content-Type']='application/json';headers['X-CSRF-Token']=state.session.csrfToken || '';}
  let response;
  try {response = await fetch('/api'+path,{method,headers,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch {throw new Error('تعذر الاتصال باللوحة. تحقق أنها ما زالت مفتوحة على اللاب ثم أعد المحاولة.');}
  let data;
  try {data=await response.json();} catch {throw new Error('تعذر قراءة نتيجة العملية. حدّث البيانات قبل إعادة المحاولة.');}
  if (!response.ok) {
    const message=data?.error?.message;
    const error = new Error(typeof message==='string' && /[\u0600-\u06ff]/.test(message) ? message : 'تعذر إكمال الإجراء. حدّث البيانات ثم حاول مرة أخرى.');
    error.status=response.status;error.code=data?.error?.code;throw error;
  }
  return Object.prototype.hasOwnProperty.call(data,'result') ? data.result : data;
}

function toast(message,error=false) {
  const item=document.createElement('div');item.className='toast'+(error?' error':'');
  item.innerHTML=icon(error?'info':'check')+`<span>${esc(message)}</span>`;$('#toasts').append(item);
  setTimeout(()=>item.remove(),6500);
}
function showError(node,message) {node.textContent=message;node.hidden=!message;}
function formError(form,message) {
  let box=$('[data-form-error]',form);
  if (!box) {box=document.createElement('div');box.className='notice error';box.dataset.formError='';box.setAttribute('role','alert');form.append(box);}
  showError(box,message);
}
function fieldError(input,message) {
  input.setAttribute('aria-invalid','true');const small=document.createElement('small');small.className='field-error';small.textContent=message;
  const field=input.closest('.field') || input.parentElement;field.append(small);
}
function clearErrors(form) {form.querySelectorAll('.field-error').forEach(n=>n.remove());form.querySelectorAll('[aria-invalid]').forEach(n=>n.removeAttribute('aria-invalid'));const box=$('[data-form-error]',form);if(box)box.hidden=true;}
function digits(value) {return String(value).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));}
function validate(form) {
  clearErrors(form);let first=null;
  for (const input of form.querySelectorAll('input,select,textarea')) {
    if (input.disabled || input.closest('[hidden]') || ['checkbox','radio','hidden'].includes(input.type)) continue;
    const value=input.value.trim();let message='';
    if (input.required&&!value)message='أكمل هذا الحقل للمتابعة';
    else if(value&&input.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))message='أدخل بريدًا إلكترونيًا صحيحًا';
    else if(value&&input.dataset.integer!==undefined) {
      const normalized=digits(value),min=Number(input.dataset.min||1),max=Number(input.dataset.max||36500);
      if(!/^\d+$/.test(normalized)||Number(normalized)<min||Number(normalized)>max)message=`أدخل عددًا صحيحًا من ${number(min)} إلى ${number(max)}`;
    }
    else if(value&&input.name==='tenantId'&&!/^[A-Za-z0-9_-]{1,120}$/.test(value))message='استخدم حروفًا إنجليزية أو أرقامًا أو شرطة فقط، دون مسافات';
    if(message){fieldError(input,message);first ||= input;}
  }
  if(first){first.focus();return false;}return true;
}
function busy(form,value,label='جارٍ المراجعة…') {
  const button=$('button[type="submit"]',form);if(!button)return;
  if(value){button.dataset.original=button.innerHTML;button.disabled=true;button.innerHTML='<span class="spinner small-spinner"></span>'+esc(label);}
  else {button.disabled=false;if(button.dataset.original)button.innerHTML=button.dataset.original;}
}
const inputField=(label,name,{type='text',required=true,placeholder='',help='',value='',ltr=false,integer=false,min=1,max=36500}={})=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${required?'required':''} ${ltr?'dir="ltr"':''} ${integer?`inputmode="numeric" data-integer data-min="${min}" data-max="${max}"`:''} value="${esc(value)}" placeholder="${esc(placeholder)}" ${type==='password'?'autocomplete="new-password"':''}>${help?`<small class="field-help">${help}</small>`:''}</label>`;
const empty=(title,text,button='')=>`<div class="empty-state"><span class="empty-icon">${icon('grid')}</span><h3>${title}</h3><p>${text}</p>${button}</div>`;
const loading=()=>`<div class="loading-state"><span class="spinner small-spinner"></span>جارٍ تحميل البيانات…</div>`;

function setNav(open) {$('#sidebar').classList.toggle('open',open);$('#nav-backdrop').hidden=!open;$('.menu-button').setAttribute('aria-expanded',String(open));}
async function boot() {
  try {
    state.session=await api('/session');$('#startup').hidden=true;
    if(state.session.authenticated){showApp();await loadTenants();}
    else showAuth();
  } catch(error) {$('#startup').hidden=true;showAuth();showError($('#auth-error'),error.message);}
}
function showAuth() {
  $('#app-view').hidden=true;$('#auth-view').hidden=false;
  const setup=state.session.configured===false;
  $('#auth-title').textContent=setup?'أنشئ كلمة مرور للوحة':'ادخل إلى لوحة الإدارة';
  $('#auth-subtitle').textContent=setup?'هذه أول مرة. اختر كلمة مرور خاصة بك لفتح اللوحة على هذا اللاب.':'استخدم كلمة المرور الخاصة بهذه اللوحة.';
  $('#auth-confirm-field').hidden=!setup;
  $('#auth-password-help').textContent=setup?'استخدم ١٢ حرفًا على الأقل.':'';
  $('#auth-password').autocomplete=setup?'new-password':'current-password';
  $('#auth-submit').innerHTML=(setup?'حفظ وفتح اللوحة':'الدخول إلى اللوحة')+icon('arrow');
}
function showApp() {
  $('#auth-view').hidden=true;$('#app-view').hidden=false;
  $('#auth-form').reset();showError($('#auth-error'),'');render();
}
function navigate(view) {state.view=view;if(view!=='detail'){state.tenantId=null;state.detail=null;}setNav(false);render();}
function render() {
  clearInterval(state.detailTimer);
  $('.navigation').querySelectorAll('[data-nav]').forEach(node=>{const active=node.dataset.nav===(state.view==='detail'?'tenants':state.view);node.classList.toggle('active',active);active?node.setAttribute('aria-current','page'):node.removeAttribute('aria-current');});
  $('#nav-tenant-count').textContent=number(state.tenants.length);
  $('#page-content').innerHTML=state.view==='accounts'?accountsPage():state.view==='help'?helpPage():state.view==='detail'?detailPage():tenantsPage();
  if(state.view==='tenants')renderTenantRows();
  else if(state.view==='detail')startDeletionDetailCountdown();
  const title=state.view==='detail'?(state.detail?.tenant?.businessName||state.detail?.tenant?.name||'المنشأة'):state.view==='accounts'?'حسابات الدخول':state.view==='help'?'دليل الاستخدام':'المنشآت';
  document.title=title+' · دفتر الفراولة';$('#announcement').textContent=title;
}

function tenantData(tenant) {return {...tenant,id:tenant.tenantId||tenant.id,name:tenant.businessName||tenant.name||tenant.tenantId||tenant.id};}
function license(tenant) {
  const expiry=tenant.entitlementPayload?.expiresAtMs ?? tenant.paidUntilMs ?? tenant.trialEndMs;
  if(tenant.perpetual===true||tenant.entitlementPayload?.expiresAtMs===null)return {text:'تفعيل دائم',class:'green',type:'permanent',expiry:null};
  if(Number(expiry)>0&&Number(expiry)<=Date.now())return {text:'انتهت المدة',class:'red',type:'expired',expiry};
  if(tenant.paidUntilMs||tenant.entitlementPayload?.trial===false)return {text:'تفعيل محدد المدة',class:'green',type:'paid',expiry};
  if(tenant.trialEndMs||tenant.entitlementPayload?.trial===true)return {text:'فترة تجريبية',class:'gold',type:'trial',expiry};
  return {text:'لم يُحدد التفعيل',class:'gray',type:'unknown',expiry:null};
}
function badge(text,kind='green'){return `<span class="status-badge ${kind}">${esc(text)}</span>`;}
function tenantsPage() {
  const active=state.tenants.filter(t=>!t.deleting&&t.enabled===true).length;
  const permanent=state.tenants.filter(t=>!t.deleting&&license(t).type==='permanent').length;
  const ending=state.tenants.filter(t=>{const end=license(t).expiry;return !t.deleting&&end>Date.now()&&end<Date.now()+7*86400000;}).length;
  return `<div class="page-heading"><div><span class="eyebrow">مساحة عملك</span><h1>إدارة المنشآت</h1><p>أضف منشأة، واربط مديرها وهاتفها، وتابع التفعيل والصلاحيات.</p></div><button class="button primary" data-action="new-tenant">${icon('plus')}منشأة جديدة</button></div>
  <div class="stats-grid">${stat('المنشآت',state.tenants.length,'كل منشأة لها سجل مستقل','grid',true)}${stat('المنشآت المفعّلة',active,'صلاحية تشغيل سارية للمنشأة','check')}${stat('تفعيل دائم',permanent,'منشآت دون تاريخ انتهاء','key')}${stat('تنتهي خلال أسبوع',ending,'تجربة أو تفعيل محدد المدة','info')}</div>
  ${state.listError?`<div class="notice error" role="alert">${esc(state.listError)}</div>`:''}
  <section class="panel" aria-labelledby="tenant-list-title"><header class="panel-header"><div><h2 id="tenant-list-title">المنشآت</h2><p>الحسابات والتفعيل، في نظرة واحدة.</p></div><span class="status-badge gray">${number(state.tenants.length)} منشأة</span></header><div class="toolbar"><label class="search-field"><span class="sr-only">ابحث عن منشأة</span>${icon('search')}<input id="tenant-search" placeholder="ابحث باسم المنشأة أو معرّفها…" value="${esc(state.search)}"></label><label><span class="sr-only">تصفية المنشآت</span><select id="tenant-filter"><option value="all">كل الحالات</option><option value="active">مفعّلة</option><option value="inactive">موقوفة</option><option value="deleting">جارٍ الحذف</option><option value="trial">فترة تجريبية</option><option value="permanent">تفعيل دائم</option><option value="expired">انتهت المدة</option></select></label></div><div id="tenant-table-content">${loading()}</div><footer class="table-footer"><span id="tenant-table-count"></span>${state.nextCursor?'<button class="button text small" data-action="load-more">عرض المزيد</button>':'<span>كل منشأة معزولة عن الأخرى</span>'}</footer></section>
  <div class="bottom-note">${icon('phone')}<p><strong>تضيف مديرًا جديدًا؟</strong> تأكد من بريده، وانسخ طلب تسجيل هاتفه من التطبيق قبل البدء.</p></div>`;
}
function stat(label,value,note,name,accent=false){return `<div class="stat-card${accent?' accent':''}"><div><span class="stat-label">${label}</span><strong class="stat-value">${number(value)}</strong><small class="stat-note">${note}</small></div><span class="stat-icon">${icon(name)}</span></div>`;}
function renderTenantRows() {
  const box=$('#tenant-table-content');if(!box)return;
  $('#tenant-filter').value=state.filter;
  if(state.loading&&!state.tenants.length){box.innerHTML=loading();return;}
  const query=state.search.trim().toLowerCase();
  const filtered=state.tenants.filter(raw=>{const t=tenantData(raw);return (!query||[t.name,t.id,t.ownerEmail,t.email].some(v=>String(v||'').toLowerCase().includes(query)))&&(state.filter==='all'||(state.filter==='deleting'?t.deleting:state.filter==='active'?!t.deleting&&t.enabled===true:state.filter==='inactive'?!t.deleting&&t.enabled!==true:!t.deleting&&license(t).type===state.filter));});
  $('#tenant-table-count').textContent=`عرض ${number(filtered.length)} من ${number(state.tenants.length)}${state.nextCursor?' · توجد منشآت أخرى':''}`;
  if(!filtered.length){box.innerHTML=empty(state.tenants.length?'لا توجد نتائج مطابقة':'أول منشأة تبدأ من هنا',state.tenants.length?'جرّب اسمًا آخر أو غيّر التصفية.':'أنشئ منشأة واربطها بحساب مالك مؤكّد وهاتفه.',!state.tenants.length?'<button class="button soft" data-action="new-tenant">'+icon('plus')+'إنشاء منشأة</button>':'');return;}
  box.innerHTML=`<div class="table-wrap"><table><thead><tr><th>المنشأة</th><th>الحساب</th><th>الحالة</th><th>التفعيل</th><th>نهاية المدة</th><th><span class="sr-only">الإجراءات</span></th></tr></thead><tbody>${filtered.map(raw=>{const t=tenantData(raw),l=license(t);return `<tr><td><div class="tenant-identity"><span class="tenant-symbol">${esc(t.name.charAt(0))}</span><div><strong>${esc(t.name)}</strong><small><bdi>${esc(t.id)}</bdi></small></div></div></td><td><bdi>${esc(t.ownerEmail||t.email||'—')}</bdi>${t.managerDeviceCount!==undefined?`<span class="table-secondary">${number(t.managerDeviceCount)} هاتف مدير</span>`:''}</td><td>${t.deleting?badge('جارٍ الحذف','red'):badge(t.enabled===true?'مفعّلة':'موقوفة',t.enabled===true?'green':'gray')}</td><td>${t.deleting?'—':badge(l.text,l.class)}</td><td>${!t.deleting&&l.expiry?date(l.expiry):'—'}</td><td><button class="row-action" data-action="open-tenant" data-id="${esc(t.id)}" aria-label="عرض منشأة ${esc(t.name)}">${t.deleting?'استكمال الحذف':'عرض المنشأة'}${icon('arrow')}</button></td></tr>`;}).join('')}</tbody></table></div>`;
}
async function loadTenants(append=false) {
  state.loading=true;state.listError='';if(state.view==='tenants')render();
  try {const data=await api('/tenants'+(append&&state.nextCursor?'?cursor='+encodeURIComponent(state.nextCursor):''));const items=Array.isArray(data)?data:(data.items||data.tenants||[]);state.tenants=append?[...new Map([...state.tenants,...items].map(t=>[t.tenantId||t.id,t])).values()]:items;state.nextCursor=data.nextCursor||null;}
  catch(error){state.listError=error.message;toast(error.message,true);}
  finally{state.loading=false;if(state.view==='tenants')render();else $('#nav-tenant-count').textContent=number(state.tenants.length);}
}
async function openTenant(id,keepTab=false) {
  state.view='detail';state.tenantId=id;state.detail=null;if(!keepTab)state.detailTab='overview';setNav(false);render();
  try {const data=await api('/tenants/'+encodeURIComponent(id));if(state.tenantId!==id)return;state.detail=data;render();}
  catch(error){state.detail={error:error.message};render();}
}
function detailPage() {
  if(!state.detail)return `<div class="detail-topline"><button class="breadcrumb-button" data-nav="tenants">${icon('arrow')}المنشآت</button></div><section class="panel">${loading()}</section>`;
  if(state.detail.error)return `<div class="page-heading"><h1>تعذر فتح المنشأة</h1><button class="button secondary" data-nav="tenants">الرجوع للمنشآت</button></div><div class="notice error">${esc(state.detail.error)}</div>`;
  const t=tenantData(state.detail.tenant||state.detail),l=license(t),members=state.detail.members||[],devices=state.detail.devices||[];
  if(t.deleting)return deletingTenantPage(t);
  const tabs={overview:'نظرة عامة',managers:'الحسابات والأجهزة',license:'التفعيل',settings:'إعدادات المنشأة'};
  return `<div class="detail-topline"><button class="breadcrumb-button" data-nav="tenants">${icon('arrow')}المنشآت</button><span class="muted">/</span><bdi class="field-help">${esc(t.id)}</bdi></div><div class="page-heading"><div class="detail-heading"><span class="tenant-symbol">${esc(t.name.charAt(0))}</span><div><h1>${esc(t.name)}</h1><p>${badge(t.enabled?'مفعّلة':'موقوفة',t.enabled?'green':'gray')}${badge(l.text,l.class)}</p></div></div><button class="button secondary" data-action="add-manager">${icon('plus')}إضافة مدير</button></div><div class="detail-tabs" role="tablist" aria-label="أقسام المنشأة">${Object.entries(tabs).map(([key,title])=>`<button class="detail-tab${state.detailTab===key?' active':''}" role="tab" aria-selected="${state.detailTab===key}" data-tab="${key}">${title}</button>`).join('')}</div>
  ${state.detailTab==='managers'?membersSection(t,members,devices):state.detailTab==='license'?licenseSection(t,l):state.detailTab==='settings'?settingsSection(t):`<div class="panel-grid"><section class="panel"><header class="panel-header"><h3>بيانات المنشأة</h3>${icon('grid')}</header><div class="panel-body"><div class="info-grid">${info('اسم المنشأة',t.name)}${info('معرّف المنشأة',t.id,true)}${info('بريد المالك',t.ownerEmail||t.email||'غير متاح',true)}${info('الحد الأقصى لهواتف المدير',number(t.maxDevices||1))}${info('الحسابات المعروضة',number(members.length))}${info('الهواتف المعروضة',number(devices.length))}</div></div></section><section class="panel"><header class="panel-header"><h3>التفعيل الحالي</h3>${icon('key')}</header><div class="panel-body"><div class="overview-license">${icon('key')}<div><strong>${l.text}</strong><p>${l.expiry?'تنتهي المدة في '+date(l.expiry):l.type==='permanent'?'التفعيل لا يحمل تاريخ انتهاء':'راجع التفعيل من هذا القسم'}</p></div></div><p class="detail-note">تسري صلاحية المنشأة على حساباتها المرتبطة. الأجهزة غير المتصلة تستلم التغيير عند اتصالها.</p><button class="button soft" data-tab="license">إدارة التفعيل</button></div></section></div>`}`;
}
// nextCheckAfterMs is a trusted-server epoch, despite its legacy name. The server
// enforces the quiet window; bound the local countdown to tolerate laptop clock drift.
function deletionReadyAt(value) {
  const now=Date.now(),target=Number(value);
  return Number.isSafeInteger(target)&&target>0?Math.min(target,now+30000):now;
}
function deletingTenantPage(t) {
  const readyAt=deletionReadyAt(t.nextCheckAfterMs),waiting=readyAt>Date.now();
  return `<div class="detail-topline"><button class="breadcrumb-button" data-nav="tenants">${icon('arrow')}المنشآت</button><span class="muted">/</span><bdi class="field-help">${esc(t.id)}</bdi></div><div class="page-heading"><div class="detail-heading"><span class="tenant-symbol">${icon('trash')}</span><div><h1>${esc(t.name)}</h1><p>${badge('جارٍ الحذف','red')}</p></div></div></div><section class="panel danger-panel"><header class="panel-header"><h3>استكمال حذف المنشأة</h3>${icon('trash')}</header><div class="panel-body"><p>بدأ الحذف النهائي لهذه المنشأة. راجع متابعة الحذف حتى تظهر رسالة اكتماله.</p><p class="detail-note">حسابات تسجيل الدخول والنسخ الموجودة على الهواتف تبقى محفوظة. لا يمكن إضافة مدير أو تغيير التفعيل أثناء الحذف.</p><button class="button danger-outline" data-action="resume-tenant-delete" data-id="${esc(t.id)}" data-ready-at="${readyAt}" ${waiting?'disabled':''}>${icon('trash')}استكمال الحذف</button><p id="detail-delete-help" class="field-help" aria-live="polite"></p></div></section>`;
}
function startDeletionDetailCountdown() {
  const button=$('[data-action="resume-tenant-delete"]');if(!button)return;
  const tick=()=>{
    const left=Math.max(0,Number(button.dataset.readyAt)-Date.now());button.disabled=left>0;
    $('#detail-delete-help').textContent=left?`يمكن مراجعة الاستكمال بعد ${number(Math.ceil(left/1000))} ثانية`:'ستظهر مراجعة جديدة قبل استكمال الحذف.';
    if(!left)clearInterval(state.detailTimer);
  };
  tick();if(button.disabled)state.detailTimer=setInterval(tick,1000);
}
function info(title,value,ltr=false){return `<div class="info-cell"><small>${title}</small><strong>${ltr?`<bdi>${esc(value)}</bdi>`:esc(value)}</strong></div>`;}
function membersSection(t,members,devices) {
  return `<section class="panel"><header class="panel-header"><div><h3>الحسابات المرتبطة</h3><p>أضف مديرًا بحساب مؤكّد، أو غيّر حالة مدير قائم.</p></div><button class="button soft small" data-action="add-manager">${icon('plus')}إضافة مدير</button></header>${members.length?`<div class="table-wrap"><table><thead><tr><th>الاسم والحساب</th><th>الصلاحية</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${members.map(m=>`<tr><td><strong>${esc(m.name||m.displayName||m.uid||m.id)}</strong><small class="table-secondary"><bdi>${esc(m.email||m.uid||m.id)}</bdi></small></td><td>${m.role==='manager'?'مدير':'موظف'}</td><td>${badge(m.active?'مفعّل':'موقوف',m.active?'green':'gray')}</td><td>${m.role==='manager'?`<button class="button ${m.active?'secondary':'soft'} small" data-action="toggle-member" data-uid="${esc(m.uid||m.id)}" data-active="${m.active?'false':'true'}">${m.active?'إيقاف الحساب':'تفعيل الحساب'}</button>`:'<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`:empty('لا توجد حسابات معروضة','يمكنك إضافة مدير بحساب مؤكّد وربط هاتفه.')}${state.detail.membersTruncated?'<div class="notice warning">القائمة المعروضة جزئية. لا تعتمد على عددها باعتباره إجمالي الحسابات.</div>':''}</section><section class="panel"><header class="panel-header"><h3>الهواتف المرتبطة</h3>${icon('phone')}</header><div class="panel-body">${devices.length?`<div class="device-list">${devices.map(d=>`<div class="device-row">${icon('phone')}<div><bdi>${esc(d.deviceId||d.id)}</bdi><small>${esc(d.name||(d.role==='manager'?'هاتف مدير':'هاتف موظف'))}</small></div>${badge(d.active?'مفعّل':'موقوف',d.active?'green':'gray')}</div>`).join('')}</div>`:'<p class="muted">لا توجد هواتف معروضة.</p>'}${state.detail.devicesTruncated?'<p class="field-help">توجد أجهزة أخرى غير معروضة في هذه القائمة.</p>':''}</div></section>`;
}
function licenseSection(t,l) {
  return `<div class="panel-grid"><section class="panel"><header class="panel-header"><div><h3>تعديل التفعيل</h3><p>اختر المدة والعدد المسموح به لهواتف المدير.</p></div>${icon('key')}</header><div class="panel-body"><form id="license-form" data-form="license" novalidate><label class="field"><span>نوع التفعيل</span><select name="unit" id="license-unit"><option value="days">مدة بالأيام</option><option value="months">مدة بالشهور</option><option value="permanent">تفعيل دائم</option></select></label><div id="license-count-field">${inputField('المدة','count',{integer:true,placeholder:'أدخل المدة المطلوبة'})}</div>${inputField('الحد الأقصى لهواتف المدير','maxDevices',{integer:true,min:1,max:1000,value:t.maxDevices||1})}<div class="notice info">يسري التفعيل على المنشأة وحساباتها المرتبطة. لا يغيّر تاريخ التجربة الأصلي. المدة الجديدة تُضاف بعد المدة المتبقية من التجربة أو التفعيل الحالي.</div><button type="submit" class="button primary">مراجعة التفعيل</button></form></div></section><section class="panel"><header class="panel-header"><h3>المدة الحالية</h3></header><div class="panel-body"><div class="overview-license">${icon('key')}<div><strong>${l.text}</strong><p>${l.expiry?date(l.expiry):'دون تاريخ انتهاء محدد'}</p></div></div><div class="info-grid">${info('بداية التجربة',date(t.trialStartMs))}${info('نهاية التجربة',date(t.trialEndMs))}</div><hr class="form-separator"><p class="detail-note">التغيير الجديد لا يصل فورًا إلى هاتف منقطع عن الإنترنت. احتفظ بحزم التفعيل التي تصدر من العملية إذا ظهرت لك.</p></div></section></div>`;
}
function settingsSection(t) {
  return `<section class="panel"><header class="panel-header"><h3>حالة المنشأة</h3>${badge(t.enabled?'مفعّلة':'موقوفة',t.enabled?'green':'gray')}</header><div class="panel-body"><p class="detail-note">إيقاف المنشأة يوقف استخدامها عند استلام الأجهزة للتغيير. السجل والعمليات المحفوظة تبقى موجودة.</p><button class="button ${t.enabled?'secondary':'primary'}" data-action="toggle-tenant" data-enabled="${t.enabled?'false':'true'}">${t.enabled?'مراجعة إيقاف المنشأة':'مراجعة تفعيل المنشأة'}</button></div></section><section class="panel danger-panel"><header class="panel-header"><h3>حذف المنشأة نهائيًا</h3>${icon('trash')}</header><div class="panel-body"><p>يحذف هذا الإجراء المنشأة وكل البيانات التابعة لها على الخدمة، بما فيها الفواتير والعملاء والموردون والمصروفات والرواتب والطلبات والأجهزة. لا يمكن التراجع عنه.</p><p>تبقى حسابات تسجيل الدخول، ويُحفظ سجل حذف مختصر لمنع بدء تجربة جديدة. النسخ الموجودة على هواتف غير متصلة لا تُمحى عن بُعد.</p><button class="button danger-outline" data-action="delete-tenant">${icon('trash')}مراجعة الحذف النهائي</button></div></section>`;
}

function accountsPage() {
  return `<div class="page-heading"><div><span class="eyebrow">حسابات الأشخاص</span><h1>حسابات الدخول</h1><p>تحقق من حساب قائم، أو أنشئ حسابًا جديدًا قبل ربطه بمنشأة.</p></div></div><div class="panel-grid"><section class="panel"><header class="panel-header"><div><h3>البحث عن حساب</h3><p>البحث لا ينشئ حسابًا أو يغيّر صلاحياته.</p></div>${icon('search')}</header><div class="panel-body"><form id="account-search-form" data-form="account-search" novalidate>${inputField('البريد الإلكتروني','email',{type:'email',ltr:true,placeholder:'name@example.com'})}<button type="submit" class="button secondary">${icon('search')}التحقق من الحساب</button><div data-account-result class="lookup-result" aria-live="polite"></div></form></div></section><section class="panel"><header class="panel-header"><div><h3>إنشاء حساب جديد</h3><p>إضافته كمدير تتطلب تأكيد بريده أولًا.</p></div>${icon('users')}</header><div class="panel-body"><form id="create-account-form" data-form="create-account" novalidate>${inputField('اسم صاحب الحساب','displayName',{placeholder:'الاسم الذي يعرّف صاحب الحساب'})}${inputField('البريد الإلكتروني','email',{type:'email',ltr:true,placeholder:'name@example.com'})}${inputField('كلمة مرور الحساب الجديد','password',{type:'password',ltr:true,help:'لن تظهر كلمة المرور في شاشة المراجعة.'})}<label class="checkbox-field"><input type="checkbox" name="sendVerificationEmail"><span>إرسال رسالة تأكيد إلى هذا البريد بعد إنشاء الحساب</span></label><button type="submit" class="button primary">مراجعة إنشاء الحساب</button></form></div></section><section class="panel wide-panel"><header class="panel-header"><div><h3>إرسال رسالة تأكيد البريد</h3><p>للحساب الذي لم يؤكد بريده بعد. لا تُرسل رسالة إلا بعد المراجعة والتأكيد.</p></div>${icon('mail')}</header><div class="panel-body"><form id="verification-form" data-form="send-verification" novalidate><div class="form-grid">${inputField('بريد الحساب','email',{type:'email',ltr:true,placeholder:'name@example.com'})}${inputField('كلمة مرور هذا الحساب','password',{type:'password',ltr:true,help:'يُتحقق منها لهذه العملية ولا تُحفظ في اللوحة.'})}</div><button type="submit" class="button secondary">${icon('mail')}مراجعة إرسال الرسالة</button></form></div></section></div>`;
}
function helpPage() {
  return `<div class="page-heading"><div><span class="eyebrow">خطوات واضحة</span><h1>ابدأ بمنشأة، ثم اربط الحساب والهاتف</h1><p>كل تغيير يُعرض للمراجعة قبل تنفيذه.</p></div></div><div class="help-grid">${[['١','تحقق من الحساب','ابحث بالبريد الإلكتروني. يجب أن يكون الحساب مفعّلًا وبريده مؤكّدًا قبل ربطه كمالك أو مدير.'],['٢','جهّز طلب الهاتف','من تطبيق دفتر الفراولة اضغط «نسخ طلب تسجيل الجهاز»، ثم الصق الطلب عند إنشاء المنشأة أو إضافة المدير.'],['٣','راجع ثم أكّد','راجع اسم المنشأة والبريد والهاتف والمدة. اكتب نص التأكيد الظاهر قبل التنفيذ.']].map(([n,title,text])=>`<section class="panel help-step"><span class="step-number">${n}</span><h3>${title}</h3><p>${text}</p></section>`).join('')}</div><section class="panel"><header class="panel-header"><h3>عند تغيير الصلاحية أو التفعيل</h3>${icon('info')}</header><div class="panel-body"><ul class="help-list"><li>الحساب الجديد يحتاج تأكيد بريده قبل إضافته لمنشأة. إرسال رسالة التأكيد يتم بطلب واضح منك.</li><li>الأجهزة غير المتصلة تستمر وفق آخر صلاحية موثوقة وصلتها، وتستلم التغيير عند اتصالها.</li><li>حذف المنشأة نهائي ويحذف كل بياناتها التابعة على الخدمة. حسابات الدخول والنسخ المحفوظة على الهواتف تبقى، ويُحفظ سجل مختصر لمنع إعادة التجربة.</li><li>قد يحتاج الحذف إلى مرحلة متابعة بعد فترة انتظار. لا تعتبره مكتملًا حتى تظهر رسالة اكتمال الحذف.</li></ul></div></section>`;
}

function accountLookupFields() {return `<label class="field"><span>بريد حساب المدير</span><div class="lookup-row"><input name="email" type="email" dir="ltr" placeholder="name@example.com" required><button class="button secondary" type="button" data-action="lookup-account">تحقق من الحساب</button></div><small class="field-help">استخدم حسابًا قائمًا ومؤكّد البريد.</small></label><div data-account-result aria-live="polite"></div>`;}
function deviceField(){return `<label class="field"><span>طلب تسجيل الهاتف</span><textarea class="device-request" name="deviceRequest" required spellcheck="false" placeholder='{"deviceId":"…","publicKeySpki":"…","algorithm":"P256-SHA256"}'></textarea><small class="field-help">من التطبيق: اضغط «نسخ طلب تسجيل الجهاز»، ثم الصق الطلب كاملًا هنا.</small></label>`;}
function openAction(type) {
  const dialog=$('#action-dialog');state.lookups.clear();$('#action-title').textContent=actionTitles[type];
  const adding=type==='add-manager';
  $('#action-body').innerHTML=`<form id="${adding?'add-manager-form':'new-tenant-form'}" data-form="${adding?'add-manager':'new-tenant'}" data-requires-account novalidate>${adding?'':`<div class="form-grid">${inputField('اسم المنشأة','name',{placeholder:'الاسم الذي يظهر لك في القائمة'})}${inputField('معرّف المنشأة','tenantId',{ltr:true,placeholder:'example-trade',help:'حروف إنجليزية أو أرقام أو شرطة، دون مسافات.'})}</div>`}${accountLookupFields()}${adding?inputField('اسم المدير','name',{placeholder:'اسم صاحب الحساب'}):''}${deviceField()}${adding?'':inputField('الحد الأقصى لهواتف المدير','maxDevices',{integer:true,min:1,max:1000,value:1})}<div class="notice info">${adding?'لن يُربط الحساب قبل التحقق من بريده ومن طلب الهاتف.':'تبدأ تجربة المنشأة عند الإنشاء. المنشأة التي سبق أن حصلت على تجربة تحتاج استعادة هويتها الأصلية.'}</div><button type="submit" class="button primary full">مراجعة ${adding?'إضافة المدير':'إنشاء المنشأة'}</button></form>`;
  dialog.showModal();$('input',dialog)?.focus();
}
async function lookupAccount(form,button=null) {
  const email=$('[name="email"]',form);clearErrors(form);
  if(!email.value.trim()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())){fieldError(email,'أدخل بريدًا إلكترونيًا صحيحًا');email.focus();return;}
  const value=email.value.trim();if(button)button.disabled=true;
  try {const result=await api('/accounts/lookup',{method:'POST',body:{email:value}});if(email.value.trim()!==value)return;state.lookups.set(form.id,{email:value.toLowerCase(),...result});renderLookup(form,result);}
  catch(error){formError(form,error.message);}
  finally{if(button)button.disabled=false;}
}
function renderLookup(form,result) {
  const container=$('[data-account-result]',form),a=result.account;
  const ready=result.found&&a?.emailVerified&&!a.disabled;
  const employeeIdentifier=form.id==='account-search-form'&&result.found&&a&&/^[A-Za-z0-9_-]{1,120}$/.test(a.uid)
    ?`<label class="field"><span>معرّف حساب الموظف</span><input data-account-uid value="${esc(a.uid)}" readonly dir="ltr" spellcheck="false" aria-describedby="account-uid-help"></label><button type="button" class="button secondary small" data-action="copy-account-uid" data-uid="${esc(a.uid)}">نسخ معرّف الحساب</button><p id="account-uid-help" class="field-help" aria-live="polite">بعد تأكيد البريد، الصق هذا المعرّف في «دعوة حساب الموظف» على هاتف المدير. يختلف عن البريد الإلكتروني ومعرّف سجل الموظف.</p>`:'';
  container.innerHTML=`<div class="account-result${ready?'':' invalid'}">${result.found&&a?`<strong>${esc(a.displayName||a.email)}</strong><bdi>${esc(a.email)}</bdi><p>${a.disabled?'هذا الحساب موقوف. لا يمكن ربطه بمنشأة.':a.emailVerified?'البريد مؤكّد · الحساب جاهز للربط':'البريد غير مؤكّد. أرسل رسالة التأكيد من صفحة حسابات الدخول، ثم تحقق منه مجددًا بعد التأكيد.'}</p>${employeeIdentifier}`:'<strong>لا يوجد حساب بهذا البريد</strong><p>أنشئ حساب الدخول أولًا، ثم أكّد بريده قبل ربطه بمنشأة.</p>'}</div>`;
}
async function copyAccountIdentifier(button) {
  const form=button.closest('form'),lookup=form&&state.lookups.get(form.id),input=form&&$('[data-account-uid]',form),help=form&&$('#account-uid-help',form);
  if(form?.id!=='account-search-form'||!lookup?.found||!input||lookup.email!==$('[name="email"]',form).value.trim().toLowerCase()||lookup.account?.uid!==button.dataset.uid||input.value!==button.dataset.uid||!/^[A-Za-z0-9_-]{1,120}$/.test(input.value))throw new Error('تحقق من حساب الموظف مجددًا قبل نسخ معرّفه');
  button.disabled=true;
  try {
    if(typeof navigator.clipboard?.writeText!=='function')throw new Error('clipboard-unavailable');
    await navigator.clipboard.writeText(input.value);
    if(help)help.textContent='نُسخ معرّف الحساب. بعد تأكيد البريد، الصقه في «دعوة حساب الموظف» على هاتف المدير.';
    toast('نُسخ معرّف الحساب');
  } catch {
    input.focus();input.select();input.setSelectionRange(0,input.value.length);
    if(help)help.textContent='تعذر النسخ التلقائي. المعرّف محدد الآن؛ اضغط Ctrl+C أو اختر «نسخ» يدويًا.';
    toast('تعذر النسخ التلقائي؛ انسخ المعرّف المحدد يدويًا',true);
  } finally {button.disabled=false;}
}
function verifiedAccount(form) {
  const email=$('[name="email"]',form),lookup=state.lookups.get(form.id);
  if(!lookup||lookup.email!==email.value.trim().toLowerCase()){fieldError(email,'تحقق من هذا الحساب أولًا');email.focus();return null;}
  if(!lookup.found||!lookup.account?.emailVerified||lookup.account.disabled){fieldError(email,'يلزم حساب مفعّل ومؤكّد البريد قبل الربط');email.focus();return null;}
  return lookup.account;
}
function readDevice(form) {
  const field=$('[name="deviceRequest"]',form);
  try {const value=JSON.parse(field.value);if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['deviceId','publicKeySpki','algorithm'].includes(k))||typeof value.deviceId!=='string'||typeof value.publicKeySpki!=='string'||!value.deviceId||!value.publicKeySpki)throw Error();return value;}
  catch {fieldError(field,'الصق طلب تسجيل الجهاز كاملًا كما نُسخ من التطبيق');field.focus();return null;}
}

function renderSummary(summary) {
  if(!summary||typeof summary!=='object')return `<p class="detail-note">${esc(summary||'راجع العملية ثم أكّد تنفيذها.')}</p>`;
  const rows=Object.entries(summary).filter(([key,value])=>!secretKey(key)&&value!==undefined);
  return `<dl class="review-summary">${rows.map(([key,value])=>{
    if(value&&typeof value==='object'&&!Array.isArray(value))return `<div class="review-row"><dt>${esc(labels[key]||'تفاصيل العملية')}</dt><dd>${renderSummary(value)}</dd></div>`;
    let text;
    if(typeof value==='boolean')text=['from','to','enabled','active'].includes(key)?(value?'مفعّل':'موقوف'):(value?'نعم':'لا');
    else if(value===null)text='غير محدد';
    else if(key==='nextCheckAfterMs')text='بعد فترة الانتظار الموضحة أدناه';
    else if(/(?:ExpiryMs|UntilMs|StartMs|EndMs|expiresAtMs)$/.test(key))text=date(value);
    else if(key==='unit')text=({days:'أيام',months:'شهور',permanent:'دائم'})[value]||value;
    else if(key==='role')text=value==='manager'?'مدير':value==='employee'?'موظف':value;
    else if(key==='status')text=({applied:'اكتمل',partial:'اكتمل جزئيًا','delete-pending':'الحذف يحتاج متابعة',deleted:'اكتمل الحذف'})[value]||value;
    else if(Array.isArray(value))text=value.map(v=>typeof v==='object'?'عنصر إضافي':String(v)).join('، ');
    else if(typeof value==='number')text=number(value);
    else text=value;
    return `<div class="review-row"><dt>${esc(labels[key]||'تفاصيل إضافية')}</dt><dd><bdi>${esc(text)}</bdi></dd></div>`;
  }).join('')}</dl>`;
}
async function previewAction(payload,form=null) {
  if(form)busy(form,true);
  try {
    const preview=await api('/preview',{method:'POST',body:payload});
    state.preview={...preview,type:preview.type||payload.type,previewId:preview.previewId||preview.id,expiresAtMs:preview.expiresAtMs||preview.expiresAt,tenantId:preview.tenantId||payload.tenantId};
    if(!state.preview.previewId)throw new Error('تعذر تجهيز المراجعة. حاول من جديد.');
    $('#review-title').textContent=preview.title||actionTitles[state.preview.type]||'مراجعة العملية';
    $('#review-summary').innerHTML=renderSummary(preview.summary||preview.details);
    const destructive=state.preview.type==='delete-tenant';$('#review-dialog').classList.toggle('destructive',destructive);
    $('#review-warning').hidden=!destructive;$('#review-warning').textContent=destructive?'الحذف نهائي ويشمل بيانات المنشأة وكل فروعها. حسابات تسجيل الدخول والنسخ الموجودة على الهواتف لا تُحذف، ويُحفظ سجل مختصر لمنع إعادة التجربة.':'';
    $('#execute-button').className='button '+(destructive?'danger':'primary');$('#execute-button').textContent=destructive?'تأكيد الحذف النهائي':'تأكيد التنفيذ';
    $('#confirmation-field').hidden=!preview.confirmationText;$('#confirmation-text').textContent=preview.confirmationText||'';$('#confirmation-input').value='';
    showError($('#review-error'),'');$('#review-dialog').showModal();
    updateExpiry();clearInterval(state.previewTimer);state.previewTimer=setInterval(updateExpiry,1000);
    if(preview.confirmationText)$('#confirmation-input').focus();else $('#execute-button').focus();
  } catch(error) {if(form)formError(form,error.message);else toast(error.message,true);}
  finally {if(form){busy(form,false);form.querySelectorAll('input[type="password"]').forEach(input=>input.value='');}}
}
function updateExpiry() {
  if(!state.preview)return;const end=Number(state.preview.expiresAtMs),remaining=end-Date.now();
  $('#preview-expiry').textContent=!end?'':remaining<=0?'انتهت صلاحية المراجعة. ارجع وراجع العملية من جديد.':`صالحة لمدة ${number(Math.ceil(remaining/60000))} دقيقة تقريبًا`;
  $('#execute-button').disabled=state.executing||Boolean(end&&remaining<=0);
}
function closeReview() {if(state.executing)return;$('#review-dialog').close();state.preview=null;clearInterval(state.previewTimer);}
async function executeAction(form) {
  const preview=state.preview;if(!preview||state.executing)return;
  const confirmation=$('#confirmation-input').value;
  if(preview.confirmationText&&confirmation!==preview.confirmationText){showError($('#review-error'),'اكتب نص التأكيد كما يظهر تمامًا للمتابعة');$('#confirmation-input').focus();return;}
  state.executing=true;busy(form,true,'جارٍ التنفيذ…');$('#cancel-preview').disabled=true;showError($('#review-error'),'');
  try {
    const result=await api('/execute',{method:'POST',body:{previewId:preview.previewId,confirmationText:confirmation}});
    $('#review-dialog').close();if($('#action-dialog').open)$('#action-dialog').close();clearInterval(state.previewTimer);state.preview=null;
    const pending=result?.status==='delete-pending';
    if(preview.type==='delete-tenant'&&!pending){state.view='tenants';state.tenantId=null;state.detail=null;}
    await loadTenants();
    if(state.view==='detail'&&state.tenantId)await openTenant(state.tenantId,true);
    showResult(preview,result);
  } catch(error) {showError($('#review-error'),error.message+' لا تكرر التنفيذ قبل التحقق من النتيجة.');}
  finally{state.executing=false;busy(form,false);$('#cancel-preview').disabled=false;updateExpiry();}
}
function activationPackages(result) {
  const candidates=[];
  function add(value,label) {if(value&&typeof value==='object'&&value.version===1&&value.entitlement&&value.membership)candidates.push({package:value,label});}
  add(result?.licensePackage,'حزمة التفعيل');add(result?.activationPackage,'حزمة التفعيل');
  if(result?.package)add(result.package,'حزمة التفعيل');
  for(const item of [...(Array.isArray(result?.packages)?result.packages:[]),...(Array.isArray(result?.licensePackages)?result.licensePackages:[])])add(item.package||item.licensePackage||item,item.deviceId||item.uid||'حزمة التفعيل');
  return candidates;
}
function showResult(preview,result) {
  clearInterval(state.resultTimer);state.downloads=activationPackages(result);const pending=result?.status==='delete-pending',partial=result?.status==='partial';
  $('#result-eyebrow').textContent=pending?'تحتاج متابعة':partial?'نتيجة جزئية':'اكتملت العملية';
  $('#result-title').textContent=pending?'الحذف لم يكتمل بعد':partial?'أُنشئ الحساب، ورسالة التأكيد لم تُرسل':'تم التنفيذ بنجاح';
  let body=`<div class="result-icon${pending?' pending':''}">${icon(pending||partial?'info':'check')}</div><p class="result-note">${partial?'حساب الدخول اتعمل بالفعل، لكن تعذر إرسال رسالة تأكيد البريد. استخدم صفحة حسابات الدخول لإرسال الرسالة بعد المراجعة، ولا تنشئ الحساب مرة أخرى.':pending?'بدأ حذف المنشأة، وتحتاج العملية إلى متابعة بعد فترة انتظار. لا تعتبر الحذف مكتملًا حتى تظهر رسالة اكتماله.':preview.type==='create-account'?'أُنشئ الحساب. يلزم تأكيد بريده قبل ربطه بمنشأة.':preview.type==='send-verification-email'?'اكتملت عملية إرسال رسالة التأكيد. افتح البريد وأكّد الحساب، ثم أعد التحقق منه.':preview.type==='delete-tenant'?'اكتمل حذف المنشأة وبياناتها التابعة. تظل حسابات تسجيل الدخول محفوظة.':'اكتملت العملية. راجع البيانات المحدثة في صفحة المنشأة.'}</p>`;
  const publicResult=result&&typeof result==='object'?Object.fromEntries(Object.entries(result).filter(([key,value])=>labels[key]&&!secretKey(key)&&!['account','result'].includes(key)&&typeof value!=='object')):{};
  if(Object.keys(publicResult).length)body+=renderSummary(publicResult);
  if(pending){state.pendingDeletion={tenantId:result.tenantId||preview.tenantId,readyAt:deletionReadyAt(result.nextCheckAfterMs)};body+='<button class="button danger-outline full" data-action="resume-delete" id="resume-delete" disabled>انتظر قبل متابعة الحذف</button><p id="resume-delete-help" class="field-help"></p>';}
  body+=state.downloads.map((item,index)=>`<div class="package-download"><div><strong>حزمة تفعيل موقّعة</strong><small><bdi>${esc(item.label)}</bdi></small></div><button class="button secondary small" data-action="download-package" data-index="${index}">${icon('download')}حفظ الحزمة</button></div>`).join('');
  $('#result-body').innerHTML=body;$('#result-dialog').showModal();
  if(pending){const tick=()=>{const left=state.pendingDeletion.readyAt-Date.now(),button=$('#resume-delete');if(!button)return;if(left<=0){button.disabled=false;button.textContent='مراجعة متابعة الحذف';$('#resume-delete-help').textContent='ستظهر مراجعة جديدة قبل أي حذف إضافي.';clearInterval(state.resultTimer);}else $('#resume-delete-help').textContent=`يمكن المتابعة بعد ${number(Math.ceil(left/1000))} ثانية`;};tick();state.resultTimer=setInterval(tick,1000);}
}

async function handleForm(form) {
  if(form.dataset.form==='execute'){await executeAction(form);return;}
  if(!validate(form))return;
  const data=new FormData(form),value=name=>String(data.get(name)||'').trim();
  if(form.dataset.form==='auth') {
    const password=$('[name="password"]',form).value,setup=state.session.configured===false;
    if(setup&&password.length<12){fieldError($('[name="password"]',form),'استخدم ١٢ حرفًا على الأقل');return;}
    if(setup&&password!==$('[name="confirmPassword"]',form).value){fieldError($('[name="confirmPassword"]',form),'كلمتا المرور غير متطابقتين');return;}
    busy(form,true,'جارٍ فتح اللوحة…');showError($('#auth-error'),'');form.querySelectorAll('input[type="password"]').forEach(i=>i.value='');
    try {state.session=await api(setup?'/setup':'/login',{method:'POST',body:{password}});showApp();await loadTenants();}
    catch(error){showError($('#auth-error'),error.message);}finally{busy(form,false);}return;
  }
  if(form.dataset.form==='account-search'){busy(form,true,'جارٍ التحقق…');try{await lookupAccount(form);}finally{busy(form,false);}return;}
  if(form.dataset.form==='new-tenant'||form.dataset.form==='add-manager') {
    const account=verifiedAccount(form);if(!account)return;const deviceRequest=readDevice(form);if(!deviceRequest)return;
    const payload=form.dataset.form==='new-tenant'?{type:'create-tenant',tenantId:value('tenantId'),name:value('name'),ownerUid:account.uid,expectedEmail:account.email,deviceRequest,maxDevices:Number(digits(value('maxDevices')))}:{type:'add-manager',tenantId:state.tenantId,uid:account.uid,expectedEmail:account.email,name:value('name'),deviceRequest};
    await previewAction(payload,form);return;
  }
  if(form.dataset.form==='create-account') {await previewAction({type:'create-account',email:value('email'),displayName:value('displayName'),password:$('[name="password"]',form).value,sendVerificationEmail:data.get('sendVerificationEmail')==='on'},form);return;}
  if(form.dataset.form==='send-verification') {await previewAction({type:'send-verification-email',email:value('email'),password:$('[name="password"]',form).value},form);return;}
  if(form.dataset.form==='license') {const unit=value('unit');await previewAction({type:'activate-license',tenantId:state.tenantId,unit,...(unit==='permanent'?{}:{count:Number(digits(value('count')))}),maxDevices:Number(digits(value('maxDevices')))},form);}
}

document.addEventListener('submit',event=>{const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();handleForm(form).catch(error=>formError(form,error.message));});
document.addEventListener('input',event=>{
  if(event.target.id==='tenant-search'){state.search=event.target.value;renderTenantRows();}
  if(event.target.name==='email'&&(event.target.closest('[data-requires-account]')||event.target.closest('#account-search-form'))){const form=event.target.closest('form');state.lookups.delete(form.id);$('[data-account-result]',form).innerHTML='';}
});
document.addEventListener('change',event=>{
  if(event.target.id==='tenant-filter'){state.filter=event.target.value;renderTenantRows();}
  if(event.target.id==='license-unit'){$('#license-count-field').hidden=event.target.value==='permanent';const field=$('[name="count"]',$('#license-form'));field.required=event.target.value!=='permanent';field.dataset.max=event.target.value==='months'?'1200':'36500';}
});
document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-nav]');if(nav){navigate(nav.dataset.nav);return;}
  const tab=event.target.closest('[data-tab]');if(tab){state.detailTab=tab.dataset.tab;render();return;}
  const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
  try {
    if(action==='toggle-nav')setNav(!$('#sidebar').classList.contains('open'));
    else if(action==='close-nav')setNav(false);
    else if(action==='new-tenant')openAction('create-tenant');
    else if(action==='add-manager')openAction('add-manager');
    else if(action==='open-tenant')await openTenant(button.dataset.id);
    else if(action==='refresh'){if(state.view==='detail')await openTenant(state.tenantId,true);else await loadTenants();}
    else if(action==='load-more')await loadTenants(true);
    else if(action==='reload-session')await boot();
    else if(action==='lookup-account')await lookupAccount(button.closest('form'),button);
    else if(action==='copy-account-uid')await copyAccountIdentifier(button);
    else if(action==='close-action')$('#action-dialog').close();
    else if(action==='close-review')closeReview();
    else if(action==='close-result'){$('#result-dialog').close();clearInterval(state.resultTimer);}
    else if(action==='toggle-tenant')await previewAction({type:'set-tenant-enabled',tenantId:state.tenantId,enabled:button.dataset.enabled==='true'});
    else if(action==='toggle-member')await previewAction({type:'set-member-active',tenantId:state.tenantId,uid:button.dataset.uid,active:button.dataset.active==='true'});
    else if(action==='delete-tenant')await previewAction({type:'delete-tenant',tenantId:state.tenantId});
    else if(action==='resume-tenant-delete'&&Date.now()>=Number(button.dataset.readyAt))await previewAction({type:'delete-tenant',tenantId:button.dataset.id});
    else if(action==='resume-delete'&&state.pendingDeletion&&Date.now()>=state.pendingDeletion.readyAt){$('#result-dialog').close();clearInterval(state.resultTimer);await previewAction({type:'delete-tenant',tenantId:state.pendingDeletion.tenantId});}
    else if(action==='download-package'){const item=state.downloads[Number(button.dataset.index)];if(!item)return;const url=URL.createObjectURL(new Blob([JSON.stringify(item.package,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='strawberry-activation.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    else if(action==='logout'){button.disabled=true;try{state.session=await api('/logout',{method:'POST',body:{}});state.tenants=[];state.lookups.clear();showAuth();setNav(false);}finally{button.disabled=false;}}
  } catch(error){toast(error.message,true);}
});
$('#review-dialog').addEventListener('cancel',event=>{if(state.executing)event.preventDefault();else closeReview();});
$('#result-dialog').addEventListener('close',()=>clearInterval(state.resultTimer));
boot();
