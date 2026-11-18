// Stub CLI orchestration, including manager.tick (not the production ladder).
// The observation hook, source guard and request transform remain production code.
// Ladder integration is covered separately in zero-recall-construction.test.ts.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/scripts/one-shot-zero-recall-surgery.js')) {
    if (specifier === '../src/context-manager.js') return { url: 'stub:manager', shortCircuit: true };
    if (specifier === '@animalabs/membrane') return { url: 'stub:membrane', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'stub:membrane') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync, readFileSync } from 'node:fs';
    export class AnthropicAdapter {}
    export class NativeFormatter {}
    export class Membrane {
      bound = true;
      async complete(request, options) {
        if (!this.bound) throw new Error('lost provider receiver');
        if (!options?.formatter?.offline || !(options.signal instanceof AbortSignal)) throw new Error('lost complete options');
        const receipt = JSON.parse(readFileSync(process.env.SURGERY_RECEIPT, 'utf8'));
        if (receipt.status !== 'calling' || receipt.call.status !== 'started') throw new Error('missing pre-call receipt');
        appendFileSync(process.env.SURGERY_TRACE, JSON.stringify({ sent: request }) + '\\n');
        if (process.env.SURGERY_CASE === 'provider-error') throw new Error('stub provider failure');
        return { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' };
      }
    }
  ` };
  if (url === 'stub:manager') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const text = text => ({ type: 'text', text });
    const message = (participant, value) => ({ participant, content: [text(value)] });
    const trace = value => appendFileSync(process.env.SURGERY_TRACE, JSON.stringify(value) + '\\n');
    export class ContextManager {
      static async open({ strategy, membrane }) {
        trace({ opened: true });
        strategy.chunks = [{ index: 0, messages: [{ id: 'first' }, { id: 'last' }] }];
        strategy.summaries = [];
        strategy.compressionQueue = [];
        strategy.getCompressionQuarantineStatus = () => ({ keys: ['quarantined'] });
        strategy.readCompressionQuarantineProjection = () => {
          if (process.env.SURGERY_CASE === 'unreadable') throw new Error('quarantine ledger unreadable');
          return new Map([['quarantined', { record: { chunkSourceHash: createHash('sha256').update(JSON.stringify(
            process.env.SURGERY_CASE === 'wrong-chunk' ? ['other'] : ['first', 'last'])).digest('hex') } }]]);
        };
        strategy.clearCompressionRefusalQuarantine = async key => { if (process.env.SURGERY_CASE === 'clear-error') throw new Error('clear failed'); trace({ cleared: key }); };
        let branch = { name: 'main' };
        return {
          getStrategy: () => strategy,
          setToolDefinitions: tools => trace({ tools }),
          queryMessages: () => ({ messages: process.env.SURGERY_CASE === 'unsafe'
            ? [message('Context Manager', '[CM] Recall memory raw.')]
            : process.env.SURGERY_CASE === 'opening-collision' ? [message('Context Manager', strategy.opening())] : [] }),
          currentBranch: () => branch,
          fork: async name => { trace({ fork: name }); branch = { name }; return name; },
          tick: async () => {
            let request = { messages: [message('Context Manager', '[CM] Recall memory memory.'),
              message('Claude', 'stored answer'), message('Context Manager', strategy.opening()),
              message('user', 'raw source must survive')], config: { model: 'offline' } };
            trace({ original: request });
            request = strategy.authorL1CompressionRequest(request, ['memory']);
            if (process.env.SURGERY_CASE === 'mismatch') request.config.model = 'tampered';
            await membrane.complete(request, { formatter: { offline: true }, signal: new AbortController().signal });
            if (process.env.SURGERY_CASE === 'repeat') await membrane.complete(request, { formatter: { offline: true }, signal: new AbortController().signal });
            strategy.summaries.push({ id: 'new', sourceRange: { first: 'first', last: 'last' } });
          },
          close: () => trace({ closed: true }),
        };
      }
    }
  ` };
  return nextLoad(url, context);
}
