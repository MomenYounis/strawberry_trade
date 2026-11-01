import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {gzipSync,deflateSync} from 'node:zlib';
import bodyParser from 'body-parser';
// Synthetic loopback regression for GHSA-27r3-jxmh-p828: tail arrives only
// after decoding succeeds. Downstream waits for the complete HTTP request.
test('production parser drains trailing compressed bytes without a process crash',async t=>{
 const value={synthetic:true},head=Buffer.concat([deflateSync(JSON.stringify(value)),Buffer.from([0])]),tail=Buffer.alloc(1024,88);let client;
 const parse=bodyParser.json(),server=createServer((req,res)=>parse(req,res,error=>{
  if(error){res.writeHead(400).end();return;}
  req.once('end',()=>res.end(JSON.stringify(req.body)));client.end(tail);
 }));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{client?.destroy();server.closeAllConnections();server.close();});
 const response=await new Promise((done,reject)=>{
  client=request({host:'127.0.0.1',port:server.address().port,method:'POST',agent:false,headers:{'content-type':'application/json','content-encoding':'deflate','content-length':head.length+tail.length}},res=>{
   const chunks=[];res.on('data',data=>chunks.push(data));res.on('end',()=>done({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });client.once('error',reject);client.setTimeout(3000,()=>client.destroy(Error('synthetic-parser-timeout')));client.write(head);
 });assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),value);
});
test('production parser still accepts normal compressed JSON',async t=>{
 const parse=bodyParser.json(),server=createServer((req,res)=>parse(req,res,error=>error?res.writeHead(400).end():res.end(JSON.stringify(req.body))));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
 const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync('{"synthetic":true}'),signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{synthetic:true});
});
test('production parser survives a gzip frame followed by a large invalid tail',async t=>{
 const parse=bodyParser.json(),server=createServer((req,res)=>parse(req,res,error=>error?res.writeHead(400).end():res.end(JSON.stringify(req.body))));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
 const body=Buffer.concat([gzipSync('{"synthetic":true}'),Buffer.from([0]),Buffer.alloc(100*1024,88)]);
 const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body,signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{synthetic:true});
 await new Promise(done=>setTimeout(done,200));
});
