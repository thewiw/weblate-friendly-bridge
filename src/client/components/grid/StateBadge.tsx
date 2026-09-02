import type { UnitState } from '../../../shared/weblate-dto.js';
import { STATE_LABELS } from '../../../shared/rows.js';

const COLORS: Record<number, string> = {
  0: 'bg-slate-400',
  10: 'bg-amber-500',
  20: 'bg-blue-500',
  30: 'bg-emerald-600',
  100: 'bg-slate-300',
};

/** Small colorized state dot with a title tooltip. */
export function StateBadge({ state }: { state: UnitState }) {
  return (
    <span
      title={STATE_LABELS[state] ?? String(state)}
      className={`inline-block size-2.5 rounded-full shrink-0 ${COLORS[state] ?? 'bg-slate-400'}`}
    />
  );
}