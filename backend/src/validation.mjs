import {createHash, createPublicKey, sign, verify} from 'node:crypto';
export class GatewayError extends Error { constructor(code,message=code){super(message);this.code=code;} }
export const fail=(code)=>{throw new GatewayError(code);};
export function object(v){if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid-argument');return v;}
export function text(v,max=160,empty=false){if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))fail('invalid-argument');return v;}
export function id(v){text(v,120);if(!/^[A-Za-z0-9_-]+$/.test(v))fail('invalid-argument');return v;}
export function integer(v,min=0,max=1_000_000_000_000){if(!Number.isSafeInteger(v)||v<min||v>max)fail('invalid-argument');return v;}
export function keys(v,allowed){object(v);if(Object.keys(v).some(k=>!allowed.includes(k)))fail('invalid-argument');}
export function isoDate(v){text(v,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T12:00:00Z'))||new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v)fail('invalid-argument');return v;}
export function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export function amount(qtyMilli,priceMinor){integer(qtyMilli,1,1_000_000_000);integer(priceMinor,1,1_000_000_000);if(BigInt(qtyMilli)*BigInt(priceMinor)>9007199254740991n)fail('invalid-argument');const n=(BigInt(qtyMilli)*BigInt(priceMinor)+500n)/1000n;if(n>1_000_000_000_000n)fail('invalid-argument');return Number(n);}
const entryKeys=['id','tenantId','kind','partyId','partyName','qtyMilli','priceMinor','totalMinor','paidMinor','unit','grade','date','originalId','note','employeeId','salaryMonth','creatorUid','revision','category','shippingEmployeeId','shipmentRef','shipmentStatus','shipmentOrder','adjustmentDirection'];
export const invoiceKinds=['sale','purchase'],returnKinds=['sale_return','purchase_return'];
export function entry(v,{allowReturnResidual=false}={}){
  keys(v,entryKeys);id(v.id);if(v.tenantId!==undefined)id(v.tenantId);isoDate(v.date);text(v.kind,40);text(v.note??'',1000,true);text(v.partyName??'',160,true);text(v.unit??'',40,true);text(v.grade??'',80,true);integer(v.revision??1,1,1);text(v.category??'',80,true);text(v.adjustmentDirection??'',20,true);if(['expense_business','expense_home'].includes(v.kind)&&!v.category)v={...v,category:'مصاريف أخرى'};
  if(!['sale','purchase','merchant_payment','supplier_payment','expense_business','expense_home','sale_return','purchase_return','payroll','reversal','balance_adjustment','shipment_update'].includes(v.kind))fail('invalid-argument');
  if(v.kind==='balance_adjustment'){if(!['increase','decrease'].includes(v.adjustmentDirection)||!v.note?.trim())fail('invalid-adjustment');}else if(v.adjustmentDirection)fail('invalid-adjustment');
  if(v.category&&!['expense_business','expense_home'].includes(v.kind)&&!(v.kind==='payroll'&&v.category==='رواتب وأجور'))fail('invalid-category');
  for(const k of ['totalMinor','paidMinor','priceMinor','qtyMilli'])integer(v[k]??0,0);
  integer(v.shipmentOrder??0,0,1_000_000_000);if(v.kind!=='shipment_update'&&(v.shipmentOrder??0)!==0)fail('invalid-shipment-update');text(v.shipmentRef??'',120,true);if(v.shippingEmployeeId)id(v.shippingEmployeeId);if(!['','pending','in_transit','delivered'].includes(v.shipmentStatus??''))fail('invalid-argument');if(v.partyId)id(v.partyId);if(v.originalId)id(v.originalId);if(v.employeeId)id(v.employeeId);
  if([...invoiceKinds,...returnKinds].includes(v.kind)){
    id(v.partyId);integer(v.qtyMilli,1,1_000_000_000);integer(v.priceMinor,1,1_000_000_000);amount(v.qtyMilli,v.priceMinor);text(v.unit,40);text(v.grade,80);integer(v.totalMinor,1);integer(v.paidMinor,0,v.totalMinor);
    if((!allowReturnResidual||!v.originalId)&&amount(v.qtyMilli,v.priceMinor)!==v.totalMinor)fail('invalid-total');
    if(v.employeeId||v.salaryMonth)fail('invalid-argument');if(returnKinds.includes(v.kind)){if(v.originalId)id(v.originalId);}else if(v.originalId)fail('invalid-argument');
  }else if(v.kind==='shipment_update'){
    id(v.originalId);integer(v.shipmentOrder,1,1_000_000_000);text(v.note,1000);if(!['pending','in_transit','delivered'].includes(v.shipmentStatus)||[v.qtyMilli??0,v.priceMinor??0,v.totalMinor??0,v.paidMinor??0].some(n=>n!==0)||v.partyId||v.partyName||v.employeeId||v.salaryMonth||v.grade||v.unit||v.category||v.adjustmentDirection)fail('invalid-shipment-update');
  }else if(v.kind==='reversal'){id(v.originalId);text(v.note,1000);if([v.qtyMilli??0,v.priceMinor??0,v.totalMinor??0,v.paidMinor??0].some(n=>n!==0)||v.partyId||v.employeeId||v.salaryMonth)fail('invalid-reversal');}else{
    integer(v.totalMinor,1);if((v.qtyMilli??0)!==0||(v.priceMinor??0)!==0)fail('invalid-argument');
    if(v.kind==='payroll'){id(v.employeeId);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.salaryMonth))fail('invalid-argument');}
    if(['merchant_payment','supplier_payment','balance_adjustment'].includes(v.kind))id(v.partyId);
    if((v.kind==='balance_adjustment'?v.paidMinor!==0:v.paidMinor!==v.totalMinor)||v.grade||v.unit||v.originalId)fail('invalid-paid');if(v.kind!=='payroll'&&(v.employeeId||v.salaryMonth))fail('invalid-argument');if(!['merchant_payment','supplier_payment','balance_adjustment'].includes(v.kind)&&(v.partyId||v.partyName))fail('invalid-argument');
  }
  return structuredClone(v);
}
export function directory(entity,v,tenantId){
 const common=['id','tenantId','name','phone','revision'];
 if(entity==='party'){keys(v,[...common,'kind','openingMinor','favorite']);id(v.id);text(v.name,160);text(v.phone??'',40,true);if(!['merchant','supplier'].includes(v.kind))fail('invalid-argument');integer(v.openingMinor??0,-1_000_000_000_000);if(v.favorite!==undefined&&typeof v.favorite!=='boolean')fail('invalid-argument');}
 else if(entity==='employee'){keys(v,[...common,'active']);id(v.id);text(v.name,160);text(v.phone??'',40,true);if(typeof v.active!=='boolean')fail('invalid-argument');}
 else if(entity==='salary_term'){keys(v,['id','tenantId','employeeId','effectiveMonth','monthlyMinor','revision']);id(v.id);id(v.employeeId);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.effectiveMonth))fail('invalid-argument');integer(v.monthlyMinor,1);}
 else fail('invalid-argument');
 if(v.tenantId!==undefined&&v.tenantId!==tenantId)fail('permission-denied');integer(v.revision??1,1);return {...v,tenantId,revision:1};
}
export function signed(payload,privateKey,kid){const encoded=Buffer.from(canonical(payload)).toString('base64url');return {payload:encoded,signature:sign(null,Buffer.from(encoded,'base64url'),privateKey).toString('base64url'),kid};}
export function verifySigned(envelope,publicKey){keys(envelope,['payload','signature','kid']);text(envelope.payload,12000);text(envelope.signature,100);if(!verify(null,Buffer.from(envelope.payload,'base64url'),createPublicKey(publicKey),Buffer.from(envelope.signature,'base64url')))fail('invalid-license');try{const raw=Buffer.from(envelope.payload,'base64url').toString('utf8'),payload=JSON.parse(raw);if(canonical(payload)!==raw)fail('invalid-license');return payload;}catch{fail('invalid-license');}}
