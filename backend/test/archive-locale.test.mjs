import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('source opening identity and restored controls are identical across English and Turkish locales',()=>{
 const fixture=fileURLToPath(new URL('./archive-locale.fixture.mjs',import.meta.url));
 const results=['en_US.UTF-8','tr_TR.UTF-8'].map(locale=>{
  const child=spawnSync(process.execPath,[fixture],{env:{...process.env,LC_ALL:locale,LANG:locale},encoding:'utf8',timeout:15000,maxBuffer:100000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
 });
 assert.match(results[0].locale,/^en/);assert.match(results[1].locale,/^tr/);
 assert.deepEqual(results[0].controls.accounts.map(account=>account.id),['recorded_net','I','J','i']);
 assert.deepEqual(results[0].controls,results[1].controls);
 assert.deepEqual(results[0].restored,results[1].restored);
 assert.equal(results[0].controls.identitySha256,results[1].restored.identitySha256);
});
