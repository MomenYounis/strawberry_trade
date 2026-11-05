// Own a bounded copy before returning a Durable Object's early response. A
// forwarded incoming request stream otherwise outlives its client response.
const MAX_BYTES=65_536;
function rejected(reason){return Response.json({error:{status:'INVALID_ARGUMENT',message:reason,details:{reason}}},{status:400,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}

export async function forwardGatewayRequest(request,stub){
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>MAX_BYTES)){
  await request.body?.cancel().catch(()=>{});return rejected('request-too-large');
 }
 if(!request.body)return stub.fetch(request);
 const reader=request.body.getReader(),parts=[];let total=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;
   total+=value.byteLength;if(total>MAX_BYTES){await reader.cancel().catch(()=>{});return rejected('request-too-large');}
   parts.push(value);
  }
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;
 for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 // This body belongs to this worker invocation, independent of the incoming
 // client stream. Authentication/authorization still run in the trusted DO.
 return stub.fetch(new Request(request,{body:bytes}));
}
