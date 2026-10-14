import { formatCount, formatUsd } from '@/lib/format';
import type { TenantRow } from '@/lib/overview';

export function TenantTable({ rows }: { rows: TenantRow[] }) {
  if (rows.length === 0) return <p className="muted">No tenant has usage in this range.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Tenant</th>
            <th scope="col" className="num">
              Spend
            </th>
            <th scope="col" className="num">
              Requests
            </th>
            <th scope="col" className="num">
              Average per request
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}</th>
              <td className="num">{formatUsd(r.spendUsd)}</td>
              <td className="num">{formatCount(r.requests)}</td>
              <td className="num">{r.avgCostUsd === null ? '—' : formatUsd(r.avgCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
