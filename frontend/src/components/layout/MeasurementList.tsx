// Presentational measurement readout shared by the part and assembly editors.
// Each caller computes its own strings; this owns only the readout markup.
//
// `pending` reserves one more row with no text: a kernel readout is on its way
// and the row is held so the readout does not jump when the number lands. `more`
// holds the extras the cell emitted past the first two: they stay reachable
// behind a disclosure instead of widening the row across the viewport. The
// extras panel is out of the row's flow (ViewportHud.css), so opening it cannot
// grow the readout up under the navigator cards.
export default function MeasurementList({ measurements, more = [], pending = false, measurementIcon }: {
  measurements: string[]
  more?: string[]
  pending?: boolean
  measurementIcon?: string
}) {
  if (measurements.length === 0 && more.length === 0 && !pending) return null
  return (
    <div className="measurement-display">
      {measurements.map((m, idx) => (
        <div key={idx} className="measurement-item">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span>{m}</span>
        </div>
      ))}
      {more.length > 0 && (
        <details className="measurement-more">
          <summary>more</summary>
          <div className="measurement-extras">
            {more.map((m, idx) => (
              <div key={idx} className="measurement-item">
                <img className="measurement-icon" src={measurementIcon} alt="" />
                <span>{m}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {pending && (
        <div className="measurement-item measurement-pending" aria-hidden="true">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span />
        </div>
      )}
    </div>
  )
}
