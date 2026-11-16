import { err, ok, type Result } from './result';

/** Question lifecycle (spec §5, "Question lifecycle"). */
export type QuestionStatus = 'open' | 'locked' | 'resolving' | 'resolved' | 'annulled';
export type QuestionEvent = 'lock' | 'start_resolving' | 'resolve' | 'annul' | 'correct';

const transitions: Record<QuestionStatus, Partial<Record<QuestionEvent, QuestionStatus>>> = {
  open: { lock: 'locked' },
  locked: { start_resolving: 'resolving' },
  resolving: { resolve: 'resolved', annul: 'annulled' },
  resolved: { correct: 'resolved' },
  annulled: {},
};

export type TransitionError = { readonly code: 'illegal_transition'; readonly from: QuestionStatus; readonly event: QuestionEvent };

export function transition(from: QuestionStatus, event: QuestionEvent): Result<QuestionStatus, TransitionError> {
  const to = transitions[from][event];
  return to ? ok(to) : err({ code: 'illegal_transition', from, event });
}

/** A forecast is accepted only strictly before lock time (also enforced by a DB trigger). */
export function acceptsForecastAt(lockAt: Date, madeAt: Date): boolean {
  return madeAt.getTime() < lockAt.getTime();
}
