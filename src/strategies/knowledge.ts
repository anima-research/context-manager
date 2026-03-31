import type {
  StoredMessage,
  MessageStoreView,
  KnowledgeConfig,
  SummaryEntry,
  SummaryLevel,
  PhaseType,
} from '../types/index.js';
import { AutobiographicalStrategy, type Chunk } from './autobiographical.js';

const DEFAULT_RESEARCH_PREFIXES = ['mcpl:', 'zulip:'];
const DEFAULT_SUBAGENT_PREFIXES = ['subagent:'];
const DEFAULT_LESSON_NAMES = ['lessons:create', 'lessons:update'];

/**
 * Domain-aware compression strategy for knowledge extraction workflows.
 *
 * Builds on AutobiographicalStrategy's hierarchical pyramid (L1/L2/L3)
 * but changes three things:
 * 1. Semantic chunking — chunks at phase transitions instead of fixed token counts
 * 2. Phase-aware compression — different prompts per phase type
 * 3. Asymmetric budget — caps research, prioritizes synthesis in L1 selection
 *
 * Also adds [LEAD] tracking: unresolved questions/leads are flagged in summaries
 * and preserved across compression levels.
 */
export class KnowledgeStrategy extends AutobiographicalStrategy {
  readonly name = 'knowledge' as const;

  private knowledgeConfig: KnowledgeConfig;

  constructor(config: Partial<KnowledgeConfig> = {}) {
    // Force hierarchical mode
    super({ ...config, hierarchical: true });
    this.knowledgeConfig = this.config as KnowledgeConfig;
  }

  // ============================================================================
  // Override: Semantic chunking
  // ============================================================================

  protected rebuildChunks(store: MessageStoreView): void {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    // Chunk messages outside head window and recent window:
    // [0, headStart) ∪ [headEnd, recentStart)
    const messagesToChunk = messages.slice(0, recentStart)
      .filter((_, i) => i < headStart || i >= headEnd);

    // Preserve existing compressed chunks
    const existingCompressed = new Map<string, Chunk>();
    for (const chunk of this.chunks) {
      if (chunk.compressed) {
        existingCompressed.set(this.chunkKey(chunk), chunk);
      }
    }

    this.chunks = [];
    this.compressionQueue = [];

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
    let currentPhase: PhaseType | null = null;
    let lastToolPhase: PhaseType = 'synthesis';
    let chunkFilteredStart = 0;

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      const phase = this.classifyMessage(msg, lastToolPhase);

      // Track tool phase for tool_result inheritance
      if (this.getToolNames(msg).length > 0) {
        lastToolPhase = phase;
      }

      let msgTokens = store.estimateTokens(msg);
      if (this.config.attachmentsIgnoreSize) {
        msgTokens = this.estimateTextOnlyTokens(msg);
      }

      // Check if we should close before adding this message
      const phaseChanged = currentPhase !== null && phase !== currentPhase;
      const maxTokens = this.getMaxChunkTokens(currentPhase ?? phase);
      const sizeExceeded = currentTokens >= maxTokens;
      const shouldClose = currentChunk.length >= 2 && (phaseChanged || sizeExceeded);

      if (shouldClose) {
        const chunk = this.createChunk(
          this.chunks.length,
          chunkFilteredStart,
          i,
          currentChunk,
          currentTokens,
          existingCompressed
        );
        chunk.phaseType = currentPhase!;
        this.chunks.push(chunk);
        if (!chunk.compressed) this.compressionQueue.push(chunk.index);

        currentChunk = [];
        currentTokens = 0;
        chunkFilteredStart = i;
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;
      currentPhase = phase;
    }

    // Final remaining chunk (minimum 1 message to avoid silent drops)
    if (currentChunk.length >= 1 && currentPhase) {
      const chunk = this.createChunk(
        this.chunks.length,
        chunkFilteredStart,
        messagesToChunk.length,
        currentChunk,
        currentTokens,
        existingCompressed
      );
      chunk.phaseType = currentPhase;
      this.chunks.push(chunk);
      if (!chunk.compressed) this.compressionQueue.push(chunk.index);
    }
  }

  // ============================================================================
  // Override: Phase-aware compression prompts
  // ============================================================================

  protected getCompressionInstruction(chunk: Chunk, targetTokens: number): string {
    const leadSuffix = 'If any leads or open questions were identified but not yet pursued, mark them with [LEAD].';

    switch (chunk.phaseType) {
      case 'research':
        return (
          `Summarize the research performed. What was searched for, what sources were consulted, ` +
          `and what was found? Note any leads discovered. Be terse — the raw data is not needed, ` +
          `only what was learned. ${leadSuffix} Aim for about ${targetTokens} tokens.`
        );

      case 'synthesis':
        return (
          `Capture the reasoning and conclusions from this discussion. What connections were drawn? ` +
          `What hypotheses were formed or rejected? What decisions were made about what to ` +
          `investigate next? Preserve the logic chain. ${leadSuffix} Aim for about ${targetTokens} tokens.`
        );

      case 'lesson':
        return (
          `Record what knowledge was captured. What lessons were created or updated? ` +
          `What was the evidence basis? Note any confidence gaps or unresolved questions. ` +
          `${leadSuffix} Aim for about ${targetTokens} tokens.`
        );

      case 'subagent':
        return (
          `Summarize the subagent work. What tasks were dispatched, what did each return, ` +
          `and what was the coordinator's synthesis of the results? Collapse dispatch/wait mechanics. ` +
          `${leadSuffix} Aim for about ${targetTokens} tokens.`
        );

      default:
        return super.getCompressionInstruction(chunk, targetTokens);
    }
  }

  protected getMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    targetTokens: number
  ): string {
    return (
      `Please consolidate the memories since my last message into a single cohesive memory. ` +
      `Aim for about ${targetTokens} tokens. Write as you would to yourself — this is your ` +
      `autobiography, capturing the arc of what happened. ` +
      `IMPORTANT: Preserve any items marked with [LEAD] — these are unresolved questions ` +
      `that must survive consolidation until explicitly resolved or dropped.`
    );
  }

  // ============================================================================
  // Override: Asymmetric L1 budget allocation
  // ============================================================================

  protected selectL1Summaries(
    shownL1: SummaryEntry[],
    budget: number,
    maxTokens: number
  ): { selected: SummaryEntry[]; tokensUsed: number } {
    const effectiveBudget = Math.min(budget, maxTokens);

    const researchCap = effectiveBudget * (this.knowledgeConfig.researchL1BudgetCap ?? 0.3);
    const synthesisFloor = effectiveBudget * (this.knowledgeConfig.synthesisL1BudgetFloor ?? 0.4);

    // Partition by phase
    const synthesis: SummaryEntry[] = [];
    const lessons: SummaryEntry[] = [];
    const subagent: SummaryEntry[] = [];
    const research: SummaryEntry[] = [];
    const other: SummaryEntry[] = [];

    for (const s of shownL1) {
      switch (s.phaseType) {
        case 'synthesis': synthesis.push(s); break;
        case 'lesson': lessons.push(s); break;
        case 'subagent': subagent.push(s); break;
        case 'research': research.push(s); break;
        default: other.push(s); break;
      }
    }

    const selected: SummaryEntry[] = [];
    let used = 0;

    // Priority 1: Synthesis — guaranteed floor, can go higher if budget allows
    for (const s of synthesis) {
      if (used + s.tokens > effectiveBudget) break;
      // Keep going past the floor if there's room
      if (used >= synthesisFloor && used + s.tokens > effectiveBudget * 0.7) break;
      selected.push(s);
      used += s.tokens;
    }

    // Priority 2: Lessons — high value, no cap
    for (const s of lessons) {
      if (used + s.tokens > effectiveBudget) break;
      selected.push(s);
      used += s.tokens;
    }

    // Priority 3: Subagent — moderate value, no cap
    for (const s of [...subagent, ...other]) {
      if (used + s.tokens > effectiveBudget) break;
      selected.push(s);
      used += s.tokens;
    }

    // Priority 4: Research — capped
    let researchUsed = 0;
    for (const s of research) {
      if (researchUsed + s.tokens > researchCap) break;
      if (used + s.tokens > effectiveBudget) break;
      selected.push(s);
      researchUsed += s.tokens;
      used += s.tokens;
    }

    return { selected, tokensUsed: used };
  }

  // ============================================================================
  // Phase detection
  // ============================================================================

  /**
   * Classify a single message by the phase it belongs to.
   * Uses tool_use block names for classification.
   * Messages with only tool_result (no tool_use) inherit from the last tool phase.
   */
  private classifyMessage(msg: StoredMessage, lastToolPhase: PhaseType): PhaseType {
    const toolNames = this.getToolNames(msg);

    if (toolNames.length > 0) {
      return this.classifyByToolNames(toolNames);
    }

    // tool_result without tool_use → inherit from preceding tool phase
    if (this.hasToolResult(msg)) {
      return lastToolPhase;
    }

    // Pure dialogue
    return 'synthesis';
  }

  /**
   * Classify by tool names with priority: lesson > subagent > research > synthesis.
   */
  private classifyByToolNames(toolNames: string[]): PhaseType {
    const lessonNames = this.knowledgeConfig.lessonToolNames ?? DEFAULT_LESSON_NAMES;
    const subagentPrefixes = this.knowledgeConfig.subagentToolPrefixes ?? DEFAULT_SUBAGENT_PREFIXES;
    const researchPrefixes = this.knowledgeConfig.researchToolPrefixes ?? DEFAULT_RESEARCH_PREFIXES;

    if (toolNames.some(n => lessonNames.includes(n))) return 'lesson';
    if (toolNames.some(n => subagentPrefixes.some(p => n.startsWith(p)))) return 'subagent';
    if (toolNames.some(n => researchPrefixes.some(p => n.startsWith(p)))) return 'research';

    return 'synthesis';
  }

  /**
   * Extract tool names from tool_use blocks in a message.
   */
  private getToolNames(msg: StoredMessage): string[] {
    const names: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        names.push((block as { type: 'tool_use'; name: string }).name);
      }
    }
    return names;
  }

  /**
   * Get the maximum chunk token size for a given phase.
   * Research and subagent chunks can grow larger since they compress aggressively.
   */
  private getMaxChunkTokens(phase: PhaseType): number {
    const base = this.config.targetChunkTokens;
    switch (phase) {
      case 'research':
        return this.knowledgeConfig.maxResearchChunkTokens ?? base * 2;
      case 'subagent':
        return this.knowledgeConfig.maxSubagentChunkTokens ?? base * 2;
      case 'synthesis':
        return this.knowledgeConfig.maxSynthesisChunkTokens ?? Math.round(base * 1.5);
      case 'lesson':
        return this.knowledgeConfig.maxLessonChunkTokens ?? base;
      default:
        return base;
    }
  }
}
