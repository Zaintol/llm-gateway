import { MAX_CUSTOM_DAYS, PRESETS, type Range } from '@/lib/range';

/** Date range first, in one row above everything it scopes. Plain links and a GET form. */
export function RangePicker({ range }: { range: Range }) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return (
    <nav className="filters" aria-label="Time range">
      {PRESETS.map((p) => (
        <a
          key={p.key}
          href={`/?range=${p.key}`}
          className="preset"
          aria-current={range.key === p.key ? 'true' : undefined}
        >
          {p.label}
        </a>
      ))}
      <form method="get" action="/" className="custom">
        <input type="hidden" name="range" value="custom" />
        <label>
          From <input type="date" name="from" defaultValue={day(range.from)} required />
        </label>
        <label>
          To{' '}
          <input
            type="date"
            name="to"
            defaultValue={day(new Date(range.to.getTime() - 86_400_000))}
            required
          />
        </label>
        <button type="submit" title={`Up to ${MAX_CUSTOM_DAYS} days`}>
          Apply
        </button>
      </form>
    </nav>
  );
}
