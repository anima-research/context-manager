import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinkingPreamble } from '../src/strategies/autobiographical.js';

// Regression: Opus-4 L3→L4 merges (2026-08-03) and Claude-3-Opus L1s emit a
// literal `<thinking>…</thinking>` preamble as plain text despite the
// "no preamble" instruction; stored verbatim it renders as meta-text in
// every recall.
describe('stripThinkingPreamble', () => {
  it('strips a leading closed thinking block', () => {
    const text = '<thinking>\nplan plan plan\n</thinking>\n\nI remember the vigil.';
    assert.equal(stripThinkingPreamble(text), 'I remember the vigil.');
  });

  it('strips with leading whitespace and mixed case', () => {
    assert.equal(stripThinkingPreamble('  <Thinking>x</Thinking>  body'), 'body');
  });

  it('returns empty for an all-thinking generation (unclosed tag)', () => {
    assert.equal(stripThinkingPreamble('<thinking>\nonly deliberation, cut off'), '');
  });

  it('leaves mid-content thinking tags alone (content, not preamble)', () => {
    const text = 'We discussed how <thinking> tags leak into summaries.';
    assert.equal(stripThinkingPreamble(text), text);
  });

  it('leaves normal summaries untouched', () => {
    const text = 'I witnessed the exchange between Ash and Tavy.';
    assert.equal(stripThinkingPreamble(text), text);
  });

  it('strips only the FIRST leading block, keeps the rest verbatim', () => {
    const text = '<thinking>a</thinking>body with </thinking> later';
    assert.equal(stripThinkingPreamble(text), 'body with </thinking> later');
  });
});
