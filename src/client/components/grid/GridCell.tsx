import type { Cell } from '../../../shared/rows.js';
import { StateBadge } from './StateBadge.js';

/** Read-only grid cell: state dot, target text, flags; click opens editor. */
export function GridCell({
  cell,
  onEdit,
}: {
  cell: Cell | undefined;
  onEdit: () => void;
}) {
  if (cell === undefined) {
    return (
      <div
        className="wl-cell w-full text-slate-300 italic"
        title="No unit in this language"
      >
        —
      </div>
    );
  }

  const text = cell.target.filter((t) => t !== '').join(' | ');
  const flags: string[] = [];
  if (cell.hasComment) flags.push('💬');
  if (cell.hasSuggestion) flags.push('💡');
  if (cell.hasFailingCheck) flags.push('⚠');

  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={cell.state === 100}
      className="wl-cell w-full text-left hover:bg-sky-50 focus:bg-sky-50 outline-none cursor-pointer disabled:cursor-not-allowed"
      title={cell.target.join('\n')}
    >
      <StateBadge state={cell.state} />
      <span className={`wl-text ${text === '' ? 'text-slate-300 italic' : ''}`}>
        {text === '' ? 'empty' : text}
      </span>
      {flags.length > 0 && (
        <span className="ml-auto shrink-0 text-xs">{flags.join(' ')}</span>
      )}
    </button>
  );
}