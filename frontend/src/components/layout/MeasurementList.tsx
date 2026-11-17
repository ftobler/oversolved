// Presentational measurement readout shared by the part and assembly editors.
// Each caller computes its own strings; this owns only the HUD markup.
//
// `pending` reserves one more row with no text: a kernel readout is on its way
// and the row is held so the HUD does not jump when the number lands.
export default function MeasurementList({ measurements, pending = false, measurementIcon }: {
  measurements: string[]
  pending?: boolean
  measurementIcon?: string
}) {
  if (measurements.length === 0 && !pending) return null
  return (
    <div className="measurement-display">
      {measurements.map((m, idx) => (
        <div key={idx} className="measurement-item">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span>{m}</span>
        </div>
      ))}
      {pending && (
        <div className="measurement-item measurement-pending" aria-hidden="true">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span />
        </div>
      )}
    </div>
  )
}
