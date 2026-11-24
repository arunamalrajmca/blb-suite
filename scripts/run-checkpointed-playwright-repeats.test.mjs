import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepeatManifest, isCompatibleRepeatManifest, runCheckpointedPlaywrightRepeats } from './run-checkpointed-playwright-repeats.mjs';

const sourceSha='a'.repeat(40);
const fingerprint='b'.repeat(64);
const expected={sourceSha,fingerprint,spec:'tests/browser/sample.spec.js',grep:'stress case',repeats:10,batchSize:4,workers:4,maxFailures:1};

test('repeat manifests preserve the intended concurrency and batch inventory',()=>{
 const manifest=createRepeatManifest(expected);
 assert.deepEqual(manifest.batches.map(batch=>batch.repeats),[4,4,2]);
 assert.equal(isCompatibleRepeatManifest(manifest,expected),true);
 assert.equal(isCompatibleRepeatManifest(manifest,{...expected,workers:1}),false);
 assert.equal(isCompatibleRepeatManifest(manifest,{...expected,grep:'different test'}),false);
 assert.equal(isCompatibleRepeatManifest(manifest,{...expected,sourceSha:'c'.repeat(40)}),false);
});

test('completed repeat batches are reused while only the failed batch is retried',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'blb-repeat-checkpoint-'));
 const calls=[];
 const executeBatch=({batchIndex,repeats})=>{
  calls.push(batchIndex);
  return {passed:batchIndex!==2,exitCode:batchIndex===2?1:0,reportCount:repeats};
 };
 try{
  assert.throws(()=>runCheckpointedPlaywrightRepeats({...expected,directory,executeBatch}),/Repeat batch 2 failed/);
  assert.deepEqual(calls,[1,2]);
  calls.length=0;
  const result=runCheckpointedPlaywrightRepeats({...expected,directory,executeBatch:args=>{calls.push(args.batchIndex);return {passed:true,exitCode:0,reportCount:args.repeats};}});
  assert.deepEqual(calls,[2,3]);
  assert.equal(result.batches.every(batch=>batch.status==='passed'),true);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('changed repeat parameters invalidate prior successful batches',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'blb-repeat-invalidate-'));
 const calls=[];
 try{
  runCheckpointedPlaywrightRepeats({...expected,directory,executeBatch:args=>{calls.push(args.batchIndex);return {passed:true,exitCode:0,reportCount:args.repeats};}});
  calls.length=0;
  runCheckpointedPlaywrightRepeats({...expected,directory,workers:2,executeBatch:args=>{calls.push(args.batchIndex);return {passed:true,exitCode:0,reportCount:args.repeats};}});
  assert.deepEqual(calls,[1,2,3]);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
