// Read only a disposable store copy. Export timing/boundary/cost metadata, no prose.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [runtime, storePath, recipePath, output] = process.argv.slice(2);
if (!output) throw new Error('usage: runtime store-copy recipe output');
if (fs.existsSync(output)) throw new Error('refusing to overwrite replay metadata');
const load = (relative) => import(pathToFileURL(path.join(runtime, relative)).href);
const { ContextManager } = await load('context-manager/src/context-manager.ts');
const { AutobiographicalStrategy } = await load('context-manager/src/strategies/autobiographical.ts');
const { buildFrameworkStrategy } = await load('forking-knowledge-miner/src/framework-strategy.ts');
const { validateRecipe } = await load('forking-knowledge-miner/src/recipe.ts');
const recipe = validateRecipe(JSON.parse(fs.readFileSync(recipePath, 'utf8')));
const configured = buildFrameworkStrategy(recipe, recipe.agent.model, 'America/Los_Angeles');
const strategy = new AutobiographicalStrategy(configured.config);
const manager = await ContextManager.open({ path: storePath, strategy, namespace: 'agents/Sill' });
try {
  const view = manager.strategyMessageView();
  strategy.loadCalibration(view);
  const messages = view.getAll();
  const estimates = strategy.postStripEstimates(view);
  const pins = strategy.pinnedPositions(messages);
  const bounds = strategy.pinLevelBounds(messages);
  const metadata = messages.map((message, index) => ({
    id: message.id, index, timestamp: message.timestamp.getTime(),
    postStripTokens: estimates[index], toolResult: strategy.hasToolResult(message),
    salience: AutobiographicalStrategy.staticSalience(message),
    pinned: pins.has(index) && !bounds.has(index),
    pinLevel: bounds.get(index)?.level, pinMaxLevel: bounds.get(index)?.maxLevel,
  }));
  fs.writeFileSync(output, JSON.stringify({
    headStart: strategy.getHeadWindowStartIndex(view), headEnd: strategy.getHeadWindowEnd(view),
    recentWindowTokens: strategy.config.recentWindowTokens,
    maxMessageTokens: strategy.config.maxMessageTokens, messages: metadata,
  }));
  console.log(JSON.stringify({ messages: metadata.length, first: metadata[0], last: metadata.at(-1), output }));
} finally { await manager.close(); }
