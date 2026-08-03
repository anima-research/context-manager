import { describe, expect, test } from 'bun:test';
import { stripThinkingPreamble } from '../src/strategies/autobiographical.js';

// Regression: Opus-4 L3→L4 merges (2026-08-03) and Claude-3-Opus L1s emit a
// literal `<thinking>…</thinking>` preamble as plain text despite the
// "no preamble" instruction; stored verbatim it renders as meta-text in
// every recall.
describe('stripThinkingPreamble', () => {
  test('strips a leading closed thinking block', () => {
    const text = '<thinking>\nplan plan plan\n</thinking>\n\nI remember the vigil.';
    expect(stripThinkingPreamble(text)).toBe('I remember the vigil.');
  });

  test('strips with leading whitespace and mixed case', () => {
    const text = '  <Thinking>x</Thinking>  body';
    expect(stripThinkingPreamble(text)).toBe('body');
  });

  test('returns empty for an all-thinking generation (unclosed tag)', () => {
    expect(stripThinkingPreamble('<thinking>\nonly deliberation, cut off')).toBe('');
  });

  test('leaves mid-content thinking tags alone (content, not preamble)', () => {
    const text = 'We discussed how <thinking> tags leak into summaries.';
    expect(stripThinkingPreamble(text)).toBe(text);
  });

  test('leaves normal summaries untouched', () => {
    const text = 'I witnessed the exchange between Ash and Tavy.';
    expect(stripThinkingPreamble(text)).toBe(text);
  });

  test('strips only the FIRST leading block, keeps the rest verbatim', () => {
    const text = '<thinking>a</thinking>body with </thinking> later';
    expect(stripThinkingPreamble(text)).toBe('body with </thinking> later');
  });
});
