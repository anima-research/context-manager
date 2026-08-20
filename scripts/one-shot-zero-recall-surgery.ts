#!/usr/bin/env node
/** Explicit, reusable, default-off zero-recall compression surgery.
 *
 * Usage: bun dist/scripts/one-shot-zero-recall-surgery.js --config op.json --execute
 * Without --execute it validates hashes/config and makes no branch or provider call.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { ContextManager } from '../src/context-manager.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { transformZeroRecallCompression } from '../src/surgery/zero-recall-compression.js';
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
if(!execute){console.log(JSON.stringify(preview,null,2));process.exit(0);}
if(!process.env.ANTHROPIC_API_KEY)throw new Error('ANTHROPIC_API_KEY required only with --execute');
const actual=new Membrane(new AnthropicAdapter({apiKey:process.env.ANTHROPIC_API_KEY}),{formatter:new NativeFormatter()});
let call: Record<string,unknown>|null=null;
const proxy=new Proxy(actual,{get(target,prop,receiver){if(prop!=='complete'){const v=Reflect.get(target,prop,receiver);return typeof v==='function'?v.bind(target):v;}return async(req:NormalizedRequest)=>{if(call)throw new Error('ONE_CALL_CAP');const tr=transformZeroRecallCompression(req.messages);const sent={...req,messages:tr.messages};const raw=JSON.stringify(sent);const startedAt=new Date().toISOString();call={startedAt,removedRecallIds:tr.removedRecallIds,originalMessages:tr.originalMessageCount,sentMessages:tr.sentMessageCount,originalRequestSha256:tr.originalSha256,transformedRequestSha256:tr.transformedSha256,transformedBytes:Buffer.byteLength(raw),status:'started'};try{const response=await target.complete(sent);const usage=response.details?.usage??response.usage;call={...call,endedAt:new Date().toISOString(),status:'completed',stopReason:response.stopReason,usage,contentTypes:response.content.map(b=>b.type)};return response;}catch(e){call={...call,endedAt:new Date().toISOString(),status:'error',providerError:{name:(e as Error).name,message:(e as Error).message}};throw e;}};}});
const strategy=new AutobiographicalStrategy({...config.strategyConfig,summaryParticipant:config.summaryParticipant,autoTickOnNewMessage:false} as never);
const manager=await ContextManager.open({path:config.storePath,strategy,membrane:proxy,namespace:config.namespace});
manager.setToolDefinitions(tools);
const parent=manager.currentBranch(); if(parent.name!==config.expectedParentBranch)throw new Error(`parent branch mismatch ${parent.name}`);
const chunks=(strategy as unknown as {chunks:Array<{index:number,messages:Array<{id:string}>}>}).chunks;const chunk=chunks.find(c=>c.index===config.targetChunkIndex);if(!chunk)throw new Error(`chunk ${config.targetChunkIndex} absent`);const range:[string,string]=[String(chunk.messages[0]?.id),String(chunk.messages.at(-1)?.id)];if(JSON.stringify(range)!==JSON.stringify(config.expectedSourceRange))throw new Error(`source range mismatch ${range}`);const parentQuarantine=strategy.getCompressionQuarantineStatus();if(!parentQuarantine.keys.includes(config.expectedQuarantineKey))throw new Error(`expected quarantine key absent on parent ${config.expectedQuarantineKey}`);
const branch=await manager.fork(config.branchName);const activeStrategy=manager.getStrategy() as AutobiographicalStrategy;const qBefore=activeStrategy.getCompressionQuarantineStatus();if(!qBefore.keys.includes(config.expectedQuarantineKey))throw new Error(`expected quarantine key absent after fork ${config.expectedQuarantineKey}`);await activeStrategy.clearCompressionRefusalQuarantine(config.expectedQuarantineKey);(activeStrategy as unknown as {compressionQueue:number[]}).compressionQueue=[config.targetChunkIndex];const beforeSummaryIds=new Set((activeStrategy as unknown as {summaries:Array<{id:string}>}).summaries.map(s=>s.id));let error:null|{name?:string;message?:string}=null;try{await manager.tick();}catch(e){error={name:(e as Error).name,message:(e as Error).message};}
const newSummaries=(activeStrategy as unknown as {summaries:Array<{id:string,sourceRange?:unknown,content?:unknown}>}).summaries.filter(s=>!beforeSummaryIds.has(s.id)).map(s=>({id:s.id,sourceRange:s.sourceRange}));const after={branch:manager.currentBranch(),queue:[...(activeStrategy as unknown as {compressionQueue:number[]}).compressionQueue],quarantine:activeStrategy.getCompressionQuarantineStatus(),newSummaries};manager.close();
const receipt={...preview,parentBranch:parent,branch,targetChunkIndex:config.targetChunkIndex,sourceRange:range,provenanceMode:'external-receipt-only',clearedQuarantineKey:config.expectedQuarantineKey,call,error,after};writeFileSync(config.receiptPath,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));console.log('RECEIPT_SHA256',await hashFile(config.receiptPath));if(error||newSummaries.length!==1||!call)process.exitCode=1;
