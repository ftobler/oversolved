import { KERNEL_PAIR_RULES, PAIR_RULES, SINGLE_RULES } from '@/utils/measure/rules'
import { Badge } from './shared'

// The Registry page's view of the measurement table. Pair rows come from the
// dispatch table itself, so the page cannot describe a cell the rules do not
// implement; the single rows sit next to `measureOne` in the same module, and
// the kernel rows come from the same dispatch function that routes a pair to
// OCCT.
export function MeasurementsTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>A</th>
          <th>B</th>
          <th>Readout</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colSpan={3} className="reg-cell-section">Single pick</td>
        </tr>
        {SINGLE_RULES.map((r, i) => (
          <tr key={`single-${i}`}>
            <td><Badge text="single" variant="neutral" /></td>
            <td>{r.pick}</td>
            <td className="reg-cell-desc">{r.readout}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className="reg-cell-section">Pick pairs</td>
        </tr>
        {PAIR_RULES.map((r, i) => (
          <tr key={`pair-${i}`}>
            <td>{r.a}</td>
            <td>{r.b}</td>
            <td className="reg-cell-desc">{r.readout}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className="reg-cell-section">Pick pairs answered by the kernel</td>
        </tr>
        {KERNEL_PAIR_RULES.map((r, i) => (
          <tr key={`kernel-${i}`}>
            <td>{r.a}</td>
            <td>{r.b}</td>
            <td className="reg-cell-desc">{r.readout}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
