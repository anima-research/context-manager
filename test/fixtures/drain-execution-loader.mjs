// Exercise the drain executable, production manager/store and public strategy
// tick. Membrane, NativeFormatter and AnthropicAdapter are stubs: requests are
// captured before formatting/adapter conversion; scheduling uses the seeded store.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@animalabs/membrane' && context.parentURL?.endsWith('/scripts/drain-autobiographical.js')) {
    return { url: 'drain-fixture:membrane', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'drain-fixture:membrane') return { format: 'module', shortCircuit: true, source: `
    import { appendFileSync } from 'node:fs';
    export class AnthropicAdapter {}
    export class NativeFormatter {}
    export class Membrane {
      async complete(request) {
        appendFileSync(process.env.DRAIN_TRACE, JSON.stringify(request) + '\\n');
        return {content:[{type:'text',text:'offline drained memory'}],stopReason:'end_turn',usage:{inputTokens:100,outputTokens:20}};
      }
    }
  ` };
  return nextLoad(url, context);
}
