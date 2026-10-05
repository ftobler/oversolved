// Presentational measurement readout shared by the part and assembly editors.
// Each caller computes its own strings; this owns only the HUD markup.
export default function MeasurementList({ measurements, measurementIcon }: {
  measurements: string[]
  measurementIcon?: string
}) {
  if (measurements.length === 0) return null
  return (
    <div className="measurement-display">
      {measurements.map((m, idx) => (
        <div key={idx} className="measurement-item">
          <img className="measurement-icon" src={measurementIcon} alt="" />
          <span>{m}</span>
        </div>
      ))}
    </div>
  )
}
