// The CLI, manager, store, quarantine binding/clearing and L1 ladder are real.
// Provider I/O is stubbed; merge scenarios also force scheduling/queue state,
// carrier injects authored thinking, and rejection reuses authored bytes on its
// otherwise empty-recall retry, specifically to reach second proxy admission.
let membraneUrl;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/scripts/one-shot-zero-recall-surgery.js')) {
    if (specifier === '../src/context-manager.js') return { url: 'real-fixture:manager', shortCircuit: true };
    if (specifier === '@animalabs/membrane') {
      membraneUrl = (await nextResolve(specifier, context)).url;
      return { url: 'real-fixture:membrane', shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'real-fixture:manager') return { format: 'module', shortCircuit: true, source: `
    import { ContextManager as Real } from ${JSON.stringify(new URL('../../dist/src/context-manager.js', import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    export class ContextManager {
      static async open(options) {
        const manager = await Real.open(options);
        const strategy = options.strategy;
        const clear = strategy.clearCompressionRefusalQuarantine.bind(strategy);
        strategy.clearCompressionRefusalQuarantine = async key => {
          await clear(key);
          if (strategy.getCompressionQuarantineStatus().keys.includes(key)) throw new Error('real quarantine clear did not retire the fixture');
        };
        const fork = manager.fork.bind(manager);
        const tick = manager.tick.bind(manager);
        manager.tick = async () => {
          if (process.env.SURGERY_CASE === 'merge-empty') strategy.compressionQueue = [];
          return tick();
        };
        manager.fork = async name => {
          const branch = await fork(name);
          const scenario = process.env.SURGERY_CASE;
          if (scenario.startsWith('merge-')) {
            strategy.mergeQueue = [{ level: 2, sourceIds: ['L1-100', 'L1-101'] }];
            if (scenario === 'merge-relief') strategy.mergeTakesTurnByRelief = () => true;
            if (scenario === 'merge-failed') {
              strategy.compressionFailureOrder.set(strategy.chunkKey(strategy.chunks[2]), 1);
              strategy.mergeTakesTurnBefore = () => true;
            }
          }
          if (scenario === 'rejection') {
            // A real source-only surgery retry refuses empty recalls during
            // authoring, before proxy admission. Reuse the last trusted authored
            // bytes here specifically to test the proxy cap after a rejection.
            const author = strategy.authorL1CompressionRequest.bind(strategy);
            let prior;
            strategy.authorL1CompressionRequest = (request, ids) => {
              if (ids.length === 0 && prior) return prior;
              return prior = author(request, ids);
            };
          }
          if (scenario === 'mismatch') {
            const author = strategy.authorL1CompressionRequest.bind(strategy);
            strategy.authorL1CompressionRequest = (request, ids) => {
              const result = author(request, ids);
              return { ...result, config: { ...result.config, model: 'tampered' } };
            };
          }
          if (scenario === 'carrier' || scenario === 'sdk-carrier') {
            // Exercise the transport's carrier-rejection path with a carrier
            // outside the deleted recalls (ordinary raw thinking is stripped).
            const author = strategy.authorL1CompressionRequest.bind(strategy);
            strategy.authorL1CompressionRequest = (request, ids) => {
              const result = author(request, ids);
              result.messages[0].content.unshift({type:'thinking', thinking:'fixture', signature:'signed'});
              strategy.authoredRequest = structuredClone(result);
              return result;
            };
          }
          return branch;
        };
        const close = manager.close.bind(manager);
        manager.close = () => {
          writeFileSync(process.env.SURGERY_STATE, JSON.stringify({
            progress: manager.getStore().getStateJson(strategy.compressionFamilyProgressStateId),
            pause: strategy.compressionPause?.latest,
            mergeQueue: strategy.mergeQueue,
            l1Failures: [...strategy.compressionFailureOrder],
            l1Runs: [...strategy.compressionFailureRuns],
            mergeFailures: [...strategy.mergeFailureOrder],
            mergeRuns: [...strategy.mergeFailureRuns],
          }));
          close();
        };
        return manager;
      }
    }
  ` };
  if (url === 'real-fixture:membrane' && process.env.SURGERY_CASE.startsWith('sdk-')) return {
    format: 'module', shortCircuit: true, source: `
      import { AnthropicAdapter as RealAdapter, Membrane as RealMembrane, NativeFormatter } from ${JSON.stringify(membraneUrl)};
      import { appendFileSync } from 'node:fs';
      export { NativeFormatter };
      export class AnthropicAdapter extends RealAdapter {
        constructor(options) {
          super(options);
          // Only HTTP is fake: CLI must install the guard and SDK retry policy.
          this.client.fetch = async (_input, init) => {
            appendFileSync(process.env.SURGERY_TRACE, JSON.stringify({sdkRetries:this.client.maxRetries, redirect:init?.redirect}) + '\\n');
            const status = process.env.SURGERY_CASE === 'sdk-carrier' ? 400 : process.env.SURGERY_CASE === 'sdk-rate' ? 429 : 500;
            return new Response(JSON.stringify({type:'error', error:{type:status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error', message:status === 400 ? 'thinking blocks cannot be modified' : 'offline'}}),
              {status, headers:{'content-type':'application/json', 'retry-after-ms':'1', 'x-should-retry':status === 400 ? 'false' : 'true'}});
          };
        }
      }
      export class Membrane extends RealMembrane {
        complete(request, options) {
          if (options?.retry !== false) throw new Error('CLI must disable Membrane retries');
          return super.complete(request, options);
        }
      }
    `
  };
  if (url === 'real-fixture:membrane') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync } from 'node:fs';
    export class AnthropicAdapter { client = { fetch: async () => { throw new Error('offline only'); }, maxRetries: 2, withOptions(options) { return { ...this, ...options }; } }; }
    export class NativeFormatter {}
    class ProviderError extends Error {}
    export class Membrane {
      async complete(request) {
        appendFileSync(process.env.SURGERY_TRACE, JSON.stringify(request) + '\\n');
        const scenario = process.env.SURGERY_CASE;
        if (scenario.startsWith('merge-')) return {content:[{type:'text',text:'new summary'}], stopReason:'end_turn'};
        const type = scenario === 'carrier' || scenario === 'rejection' ? 'invalid_request' : scenario === 'rate' ? 'rate_limit' : 'overloaded';
        throw Object.assign(new ProviderError('private source echoed ' + (scenario === 'carrier' ? 'thinking cannot be modified' : 'provider failure')), {
          name:'ProviderError', type, httpStatus: type === 'invalid_request' ? 400 : scenario === 'rate' ? 429 : 529, retryable:type !== 'invalid_request',
          privatePayload: 'private source echoed',
        });
      }
    }
  ` };
  return nextLoad(url, context);
}
