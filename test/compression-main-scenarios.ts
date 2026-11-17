import type { Mode } from './compression-instructions-harness.js';

export const mainScenarios = [
  ...(['base', 'reminders', 'knowledge'] as const).flatMap(variant =>
    (['chunk', 'reading', 'split', 'readingSplit', 'merge', 'readingMerge', 'fallback', 'readingFallback', 'transition'] as const)
      .flatMap(mode => (['own', 'mixed', 'inherited'] as const).map(pin => ({ variant, mode, pin, level: 2 as const })))),
  ...(['merge', 'readingMerge', 'fallback', 'readingFallback'] as const).flatMap(mode =>
    (['own', 'mixed', 'inherited'] as const).map(pin => ({ variant: 'base' as const, mode, pin, level: 3 as const }))),
];
export function scenarioKey(s: { variant: string; mode: Mode; pin: string; level: number }): string {
  return `${s.variant}/${s.mode}/${s.pin}/L${s.level}`;
}
export const goldenReminders = { identityReminder: 'LIVE REMINDER', witnessedIdentityReminder: 'WITNESS REMINDER' };
