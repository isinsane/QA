import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { api } from '../api/client'
import { errorText } from './bits'

/** Downloads the Excel report for the agents and period the params name. */
export function ExportButton({ params, label = 'Export to Excel' }: { params: () => Record<string, string | undefined>; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  return (
    <span className="builder-row" style={{ flexWrap: 'nowrap' }}>
      {problem ? <span className="text-error">{problem}</span> : null}
      <button
        className="btn btn-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setProblem('')
          try {
            await api.exportAgents(params())
          } catch (err) {
            setProblem(errorText(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <FileSpreadsheet size={16} />
        {busy ? 'Preparing…' : label}
      </button>
    </span>
  )
}
