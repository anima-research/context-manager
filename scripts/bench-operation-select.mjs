// Offline warm resident raw-window adaptive select/compile and real picker.run.
// No provider calls. Counters include all installed helper wrappers and mirrors.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AutobiographicalStrategy, ContextManager } from '../dist/src/index.js';
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)];
const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1024, 4096, 16384];
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n > 0), 'sizes must be positive integers');
for (const size of sizes) {
  const path = mkdtempSync(join(tmpdir(), 'select-cost-'));
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false,
    targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    l1HoldbackChunks: 0, quarantineAlarmIntervalMs: 0, adaptiveResolution: true,
    foldingStrategy: 'kv-stable' });
  const manager = await ContextManager.open({ path, strategy });
  try {
    for (let i=0; i<size; i++) manager.addMessage(i%2 ? 'Claude' : 'User', [{type:'text', text:`MSG-${i} ${'word '.repeat(110)}`}]);
    let contexts=0, mirrors=0, capped=0, pickerRuns=0, pickerMs=0;
    const scope = strategy.branchOperations, context = scope.context, guard = scope.assertBindingCurrent;
    scope.context = function (...args) { contexts++; return Reflect.apply(context,this,args); };
    scope.assertBindingCurrent = function (...args) { mirrors++; return Reflect.apply(guard,this,args); };
    // The capped counter counts calls to the original installed wrapper.
    const cap = strategy.cappedForSend, build = strategy.buildPicker;
    strategy.cappedForSend = function (...args) { capped++; return Reflect.apply(cap,this,args); };
    strategy.buildPicker = function (...args) {
      const picker = Reflect.apply(build,this,args), run=picker.run;
      picker.run = function (...args) { const start=performance.now(); try { return Reflect.apply(run,this,args); } finally { pickerMs += performance.now()-start; pickerRuns++; } };
      return picker;
    };
    const budget={maxTokens:size*300+10000,reserveForResponse:100};
    const view=manager.createStrategyContext().messageStore;
    const sample = async work => {
      const times=[], picks=[]; let counts;
      for (let i=0;i<13;i++) {
        contexts=mirrors=capped=pickerRuns=pickerMs=0;
        const start=performance.now(); await work(); const elapsed=performance.now()-start;
        assert.ok(pickerRuns>0 && capped>=size, 'real adaptive picker and history pricing reached');
        if(i>=3) { times.push(elapsed); picks.push(pickerMs); counts={contexts,mirrors,capped,pickerRuns}; }
      }
      return {medianMs:median(times),pickerMedianMs:median(picks),...counts};
    };
    const select=await sample(()=>strategy.select(view, {}, budget));
    const compile=await sample(()=>manager.compile(budget));
    console.log(JSON.stringify({size,select,compile}));
  } finally { manager.close(); rmSync(path,{recursive:true,force:true}); }
}
