import test from 'node:test';
import assert from 'node:assert/strict';
import {readPostingStatus, PostingStatusUnavailable} from './bank-posting-status-recovery.ts';

test('lost connection, timeout and gateway failures recover the same status read', async () => {
  let reads = 0, reconnects = 0;
  const pauses = [];
  const payload = await readPostingStatus(async () => {
    reads++;
    if (reads === 1) throw new TypeError('Failed to fetch');
    if (reads === 2) throw new DOMException('Timed out', 'TimeoutError');
    if (reads === 3) return new Response('Bad gateway', {status:502});
    return Response.json({job:{id:'same-job',status:'succeeded'}});
  }, {wait:async ms => pauses.push(ms), onReconnect:() => reconnects++});
  assert.equal(reads,4); assert.equal(reconnects,3);
  assert.deepEqual(pauses,[1000,2000,4000]);
  assert.equal(payload.job.id,'same-job');
});

test('an interrupted response body and rate limit can recover without a posting request', async () => {
  let reads=0;
  const result=await readPostingStatus(async()=>{
    reads++;
    if(reads===1)return new Response('{');
    if(reads===2)return new Response('',{status:429});
    return Response.json({commands:[]});
  },{wait:async()=>{}});
  assert.equal(reads,3); assert.deepEqual(result,{commands:[]});
});

test('a sustained outage gives an unknown-running message, never a failed-posting claim', async () => {
  let reads=0;
  await assert.rejects(readPostingStatus(async()=>{reads++;throw new TypeError('Failed to fetch');},
    {attempts:3,wait:async()=>{}}), error => error instanceof PostingStatusUnavailable &&
      error.message.includes('Do not post again') && !error.message.includes('Failed to fetch'));
  assert.equal(reads,3);
});

test('authorization and missing-job errors do not retry indefinitely',async()=>{
  for(const status of [401,403,404]){
    let reads=0;
    await assert.rejects(readPostingStatus(async()=>{reads++;return Response.json({error:'Not available'},{status});},
      {wait:async()=>{}}),/Not available/);
    assert.equal(reads,1);
  }
});
