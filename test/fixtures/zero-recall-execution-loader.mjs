// Only replace the CLI's external store/provider boundary. Strategy construction,
// the observation hook, source guard and request transform remain production code.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/scripts/one-shot-zero-recall-surgery.js')) {
    if (specifier === '../src/context-manager.js') return { url: 'stub:manager', shortCircuit: true };
    if (specifier === '@animalabs/membrane') return { url: 'stub:membrane', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'stub:membrane') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync } from 'node:fs';
    export class AnthropicAdapter {}
    export class NativeFormatter {}
    export class Membrane {
      bound = true;
      async complete(request, options) {
        if (!this.bound) throw new Error('lost provider receiver');
        if (!options?.formatter?.offline || !(options.signal instanceof AbortSignal)) throw new Error('lost complete options');
        appendFileSync(process.env.SURGERY_TRACE, JSON.stringify({ sent: request }) + '\\n');
        if (process.env.SURGERY_CASE === 'provider-error') throw new Error('stub provider failure');
        return { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' };
      }
    }
  ` };
  if (url === 'stub:manager') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync } from 'node:fs';
    const text = text => ({ type: 'text', text });
    const message = (participant, value) => ({ participant, content: [text(value)] });
    const trace = value => appendFileSync(process.env.SURGERY_TRACE, JSON.stringify(value) + '\\n');
    export class ContextManager {
      static async open({ strategy, membrane }) {
        strategy.chunks = [{ index: 0, messages: [{ id: 'first' }, { id: 'last' }] }];
        strategy.summaries = [];
        strategy.compressionQueue = [];
        strategy.getCompressionQuarantineStatus = () => ({ keys: ['quarantined'] });
        strategy.clearCompressionRefusalQuarantine = async key => trace({ cleared: key });
        let branch = { name: 'main' };
        return {
          getStrategy: () => strategy,
          setToolDefinitions: tools => trace({ tools }),
          queryMessages: () => ({ messages: process.env.SURGERY_CASE === 'unsafe'
            ? [message('Context Manager', '[CM] Recall memory raw.')] : [] }),
          currentBranch: () => branch,
          fork: async name => { trace({ fork: name }); return branch = { name }; },
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
