import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';
import type { HistoryMutationManifest } from '../../src/index.js';

const { path, namespace, strategy, manifest, targetBranch } = JSON.parse(process.argv[2]!) as {
  path: string;
  namespace: string;
  strategy: Record<string, unknown>;
  manifest: HistoryMutationManifest;
  targetBranch: string;
};
const manager = await ContextManager.open({ path, namespace, strategy: new AutobiographicalStrategy(strategy) });
const plan = manager.planHistoryMutation(manifest);
if (!plan.valid) {
  console.error(JSON.stringify(plan.violations));
  process.exit(2);
}
await manager.applyHistoryMutation(manifest, {
  targetBranch,
  expectedSourceBranch: plan.sourceBranch,
  expectedPlanSha256: plan.planSha256,
  by: { by: 'operator' },
  beforeSwitch: async ({ view }) => {
    const edited = manifest.ops.find((op) => op.kind === 'edit_summary');
    const summaries = (view.getStateJson(`${namespace}/autobio:summaries`) ?? []) as Array<{ id: string; content: string }>;
    console.log(`built: ${summaries.find((s) => s.id === edited?.summaryId)?.content}`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  },
});
console.error('the apply returned');
process.exit(3);
