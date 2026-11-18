#!/usr/bin/env node
/** Explicit, reusable, default-off zero-recall compression surgery.
 *
 * Usage: bun dist/scripts/one-shot-zero-recall-surgery.js --config op.json --execute
 * Without --execute it validates hashes and instruction settings (not source history) and makes no branch or provider call.
 * Execution is not transactional: even a transform refusal can leave a fork,
 * cleared quarantine and interrupted queue progress. Keep the original stopped
 * store untouched and execute on a disposable copy. On failure, retain any receipt and the config/output (early failures may
 * precede receipt creation), discard that copy and restore a fresh copy of the original backup;
 * do not just update the expected hash or reuse the treatment branch.
 */
import { sanitizeSurgeryProviderError } from '../src/surgery/provider-error.js';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, openSync, closeSync, fsyncSync, ftruncateSync, writeSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { ContextManager } from '../src/context-manager.js';
import { ZeroRecallSurgeryStrategy as SurgeryStrategy } from '../src/surgery/zero-recall-strategy.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { assertZeroRecallConstruction, assertZeroRecallSourceSafe } from '../src/surgery/zero-recall-compression.js';
import { Membrane, AnthropicAdapter, NativeFormatter, type NormalizedRequest } from '@animalabs/membrane';

interface Config {
  storePath: string;
  namespace: string;
  branchName: string;
  expectedParentBranch: string;
  expectedRecordsSha256: string;
  toolsPath: string;
  expectedToolsSha256: string;
  targetChunkIndex: number;
  expectedSourceRange: [string, string];
  expectedQuarantineKey: string;
  summaryParticipant: string;
  strategyConfig: Record<string, unknown>;
  receiptPath: string;
  acknowledgeStoppedCopiedOrBackedUpStore: true;
}
const args = process.argv.slice(2); const ci = args.indexOf('--config');
if (ci < 0 || !args[ci + 1]) throw new Error('Usage: --config op.json [--execute]');
const execute = args.includes('--execute');
const config = JSON.parse(readFileSync(args[ci + 1], 'utf8')) as Config;
if (config.acknowledgeStoppedCopiedOrBackedUpStore !== true) throw new Error('Explicit stopped/copy acknowledgement required');
if (!/^(treatment|surgery)\//.test(config.branchName)) throw new Error('branchName must begin treatment/ or surgery/');
if (!Number.isInteger(config.targetChunkIndex)) throw new Error('targetChunkIndex must be an integer');

async function hashFile(path: string): Promise<string> { const h=createHash('sha256'); for await (const c of createReadStream(path)) h.update(c); return h.digest('hex'); }
const recordsSha256=await hashFile(`${config.storePath}/records.log`); if(recordsSha256!==config.expectedRecordsSha256)throw new Error(`records hash mismatch ${recordsSha256}`);
const toolBytes=readFileSync(config.toolsPath); const toolsSha256=createHash('sha256').update(toolBytes).digest('hex'); if(toolsSha256!==config.expectedToolsSha256)throw new Error(`tools hash mismatch ${toolsSha256}`);
const tools=JSON.parse(toolBytes.toString('utf8'));
const preview={createdAt:new Date().toISOString(),execute,config:{...config,strategyConfig:'[recorded in config file]'},recordsSha256,toolsSha256,toolCount:tools.length};
// Constructor validation is also part of preview; no store is opened here.
const strategy=new SurgeryStrategy({...config.strategyConfig,summaryParticipant:config.summaryParticipant,autoTickOnNewMessage:false} as never);
if(!execute){console.log(JSON.stringify(preview,null,2));process.exit(0);}
if(!process.env.ANTHROPIC_API_KEY)throw new Error('ANTHROPIC_API_KEY required only with --execute');
// Resolve the parent directory so a symlink cannot hide a destination in the store.
const receiptDestination = resolve(realpathSync(dirname(resolve(config.receiptPath))), basename(config.receiptPath));
const fromStore = relative(realpathSync(config.storePath), receiptDestination);
if (!fromStore || (!fromStore.startsWith('..' + sep) && fromStore !== '..' && !isAbsolute(fromStore))) {
  throw new Error('Receipt must be outside the disposable store');
}
// Exclusive creation rejects existing files AND dangling symlinks before opening
// the store. Retain the descriptor; later writes never follow a replaced path.
const receiptFd = openSync(receiptDestination, 'wx');
const recovery = 'Execution may have changed the disposable copy. Preserve this receipt and config, discard the copy, and restore a fresh copy of the original stopped backup before retrying.';
let receipt: Record<string, unknown> = { ...preview, status: 'preflight', recovery };
function saveReceipt() {
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2));
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(receiptFd, bytes, offset, bytes.length - offset, offset);
  ftruncateSync(receiptFd, bytes.length);
  fsyncSync(receiptFd);
  return createHash('sha256').update(bytes).digest('hex');
}
saveReceipt();
console.error('Execution may change the disposable copy. On failure preserve output/config and any receipt, discard the copy, and restore a fresh copy of the original stopped backup before retrying.');

const actual=new Membrane(new AnthropicAdapter({apiKey:process.env.ANTHROPIC_API_KEY}),{formatter:new NativeFormatter()});
let call: Record<string,unknown>|null=null;
const proxy=new Proxy(actual,{get(target,prop,receiver){if(prop!=='complete'){const v=Reflect.get(target,prop,receiver);return typeof v==='function'?v.bind(target):v;}return async(req:NormalizedRequest, options?: Parameters<Membrane['complete']>[1])=>{if(call)throw new Error('ONE_CALL_CAP');const active=manager!.getStrategy() as SurgeryStrategy;const tr=active.transformation;if(!tr||!active.authoredRequest)throw new Error('No trusted L1 authoring');assertZeroRecallConstruction(req,active.authoredRequest);const sent=req;const raw=JSON.stringify(sent);const startedAt=new Date().toISOString();call={startedAt,removedRecallIds:tr.removedRecallIds,originalMessages:tr.originalMessageCount,sentMessages:tr.sentMessageCount,originalMessagesSha256:tr.originalSha256,transformedMessagesSha256:tr.transformedSha256,originalRequestSha256:tr.originalSha256,transformedRequestSha256:tr.transformedSha256,transformedBytes:Buffer.byteLength(raw),status:'started'};receipt={...receipt,status:'calling',call};saveReceipt();try{const response=await target.complete(sent,options);const usage=response.details?.usage??response.usage;call={...call,endedAt:new Date().toISOString(),status:'completed',stopReason:response.stopReason,usage,contentTypes:response.content.map(b=>b.type)};return response;}catch(e){const safe=sanitizeSurgeryProviderError(e);call={...call,endedAt:new Date().toISOString(),status:'error',providerError:{name:safe.name,message:safe.message,type:safe.type,httpStatus:safe.httpStatus,retryable:safe.retryable}};throw safe;}};}});
let manager: ContextManager | undefined;
try {
manager=await ContextManager.open({path:config.storePath,strategy,membrane:proxy,namespace:config.namespace});
manager.setToolDefinitions(tools);
const cmSource=manager.queryMessages({ participant: 'Context Manager' }).messages;
assertZeroRecallSourceSafe(cmSource, strategy.opening());
const parent=manager.currentBranch(); if(parent.name!==config.expectedParentBranch)throw new Error(`parent branch mismatch ${parent.name}`);
const chunks=(strategy as unknown as {chunks:Array<{index:number,messages:Array<{id:string}>}>}).chunks;const chunk=chunks.find(c=>c.index===config.targetChunkIndex);if(!chunk)throw new Error(`chunk ${config.targetChunkIndex} absent`);const range:[string,string]=[String(chunk.messages[0]?.id),String(chunk.messages.at(-1)?.id)];if(JSON.stringify(range)!==JSON.stringify(config.expectedSourceRange))throw new Error(`source range mismatch ${range}`);strategy.assertCompressionQuarantineChunk(config.expectedQuarantineKey, config.targetChunkIndex);
receipt={...receipt,parentBranch:parent,targetChunkIndex:config.targetChunkIndex,sourceRange:range,status:'forking'};saveReceipt();
const branch=await manager.fork(config.branchName);const activeStrategy=manager.getStrategy() as AutobiographicalStrategy;activeStrategy.assertCompressionQuarantineChunk(config.expectedQuarantineKey, config.targetChunkIndex);await activeStrategy.clearCompressionRefusalQuarantine(config.expectedQuarantineKey);(activeStrategy as unknown as {compressionQueue:number[]}).compressionQueue=[config.targetChunkIndex];const beforeSummaryIds=new Set((activeStrategy as unknown as {summaries:Array<{id:string}>}).summaries.map(s=>s.id));let error:null|{name?:string;message?:string}=null;try{await manager.tick();}catch(e){error={name:(e as Error).name,message:(call as Record<string,unknown>|null)?.status === 'error' ? 'Provider call failed; message omitted to protect source content' : (e as Error).message};}
const newSummaries=(activeStrategy as unknown as {summaries:Array<{id:string,sourceRange?:unknown,content?:unknown}>}).summaries.filter(s=>!beforeSummaryIds.has(s.id)).map(s=>({id:s.id,sourceRange:s.sourceRange}));const after={branch:manager.currentBranch(),queue:[...(activeStrategy as unknown as {compressionQueue:number[]}).compressionQueue],quarantine:activeStrategy.getCompressionQuarantineStatus(),newSummaries};
const succeeded = !error && newSummaries.length === 1 && !!call && (call as Record<string, unknown>).status === 'completed'
  && JSON.stringify(newSummaries[0].sourceRange) === JSON.stringify({ first: range[0], last: range[1] });
receipt={...preview,status:succeeded?'closing':'failed',parentBranch:parent,branch,targetChunkIndex:config.targetChunkIndex,sourceRange:range,provenanceMode:'authored-request',clearedQuarantineKey:config.expectedQuarantineKey,call,error,after,recovery:!succeeded?'Execution failed or did not produce exactly one summary. Execution may have forked and changed quarantine/queue/ladder state. Preserve this receipt, discard the disposable store copy, and restore a fresh copy of the original stopped backup before retrying; do not merely update the expected hash.':undefined};if(!succeeded)process.exitCode=1;
} catch (error) {
  receipt = { ...receipt, status: 'failed', call, error: { name: (error as Error).name, message: (error as Error).message }, recovery };
  process.exitCode = 1;
} finally {
  try {
    manager?.close();
    if (receipt.status === 'closing') receipt.status = 'finished';
  } catch {
    receipt = { ...receipt, status: 'uncertain', closeError: 'Store close failed; final durability is uncertain', recovery };
    process.exitCode = 1;
  }
}
// Publish only after final store sync. Hash the exact saved bytes, not a path
// another process could have moved or replaced after the write.
try {
  const digest = saveReceipt();
  console.log(JSON.stringify(receipt, null, 2));
  console.log('RECEIPT_SHA256', digest);
} finally {
  closeSync(receiptFd);
}
