// The CLI, manager, store and L1 ladder are real. Only provider I/O and the
// operator quarantine binding are replaced; queued merges are fixture state.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/scripts/one-shot-zero-recall-surgery.js')) {
    if (specifier === '../src/context-manager.js') return { url: 'real-fixture:manager', shortCircuit: true };
    if (specifier === '@animalabs/membrane') return { url: 'real-fixture:membrane', shortCircuit: true };
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
        strategy.assertCompressionQuarantineChunk = () => {};
        strategy.clearCompressionRefusalQuarantine = async () => {};
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
          if (scenario === 'carrier') {
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
            mergeFailures: [...strategy.mergeFailureOrder],
            mergeRuns: [...strategy.mergeFailureRuns],
          }));
          close();
        };
        return manager;
      }
    }
  ` };
  if (url === 'real-fixture:membrane') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync } from 'node:fs';
    export class AnthropicAdapter {}
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
