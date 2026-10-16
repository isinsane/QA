import { Fragment, useState } from 'react'
import { CloudDownload, FileSpreadsheet, Upload } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { ImportResult } from '../api/types'
import { errorText, fmtDate, fmtDateTime, yesterday } from '../components/bits'
import { ToastStack, useToasts } from '../components/Toasts'

export function ImportsPage() {
  const types = useApi(() => api.taskTypes(), [])
  const history = useApi(() => api.imports(), [])
  const { toasts, push } = useToasts()
  const sheetTypes = (types.data ?? []).filter((t) => t.source === 'sheet' && t.active)
  const ticketType = (types.data ?? []).find((t) => t.source === 'tickets_api' && t.active)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Imports</h1>
          <p className="page-subtitle">
            Each morning, bring in yesterday's work. Rows already imported are skipped, so uploading a sheet twice is safe.
          </p>
        </div>
      </div>
      {sheetTypes.length ? (
        <SheetUpload
          types={sheetTypes}
          onDone={(msg) => {
            push('success', msg)
            void history.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {ticketType ? (
        <TicketsPull
          name={ticketType.name}
          onDone={(msg) => {
            push('success', msg)
            void history.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">History</h2>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Work date</th>
                <th>Type</th>
                <th>Source</th>
                <th>Rows</th>
                <th>New</th>
                <th>Already in</th>
                <th>Unknown agent</th>
                <th>Skipped</th>
                <th>Sampled</th>
                <th>By</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.work_date)}</td>
                  <td>{r.task_type_name}</td>
                  <td title={r.filename}>{r.source === 'api' ? 'API' : r.filename}</td>
                  <td>{r.rows_read}</td>
                  <td>{r.created}</td>
                  <td>{r.duplicates}</td>
                  <td>{r.rejected ? <span className="badge badge-warning">{r.rejected}</span> : 0}</td>
                  <td>{r.skipped}</td>
                  <td>
                    <strong>{r.sampled}</strong>
                  </td>
                  <td>{r.user_name ?? 'schedule'}</td>
                  <td>{fmtDateTime(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ToastStack toasts={toasts} />
    </div>
  )
}

function SheetUpload({
  types,
  onDone,
  onError,
}: {
  types: { id: string; name: string }[]
  onDone: (msg: string) => void
  onError: (e: string) => void
}) {
  const [typeId, setTypeId] = useState(types[0].id)
  const [day, setDay] = useState(yesterday())
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)

  function pick(f: File | null) {
    setFile(f)
    setPreview(null)
  }

  async function run(dryRun: boolean) {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.upload(typeId, day, file, dryRun)
      if (dryRun) setPreview(res)
      else {
        const all = [res, ...(res.also ?? []).flatMap((p) => (p.result ? [p.result] : []))]
        const sum = (f: (x: ImportResult) => number) => all.reduce((n, x) => n + f(x), 0)
        onDone(`Imported ${sum((x) => x.run.created)} rows; ${sum((x) => x.run.sampled)} audits queued.`)
        pick(null)
      }
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Upload a Vonage sheet</h2>
          <p className="card-subtitle">"Disposition codes by interaction" export, .xlsx or .csv</p>
        </div>
      </div>
      <div className="card-body form-grid">
        <div className="form-row">
          <div className="field">
            <label className="field-label">Task type</label>
            <select className="select" value={typeId} onChange={(e) => (setTypeId(e.target.value), setPreview(null))}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">The day this work was done</label>
            <input className="input" type="date" value={day} onChange={(e) => (setDay(e.target.value), setPreview(null))} />
          </div>
        </div>
        <label
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            pick(e.dataTransfer.files[0] ?? null)
          }}
        >
          <span className="dropzone-icon">{file ? <FileSpreadsheet size={20} /> : <Upload size={20} />}</span>
          <strong>{file ? file.name : 'Drop the sheet here, or click to choose'}</strong>
          <input type="file" accept=".xlsx,.csv" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        {!preview ? (
          <div>
            <button className="btn btn-primary" disabled={!file || busy} onClick={() => void run(true)}>
              {busy ? 'Reading…' : 'Preview'}
            </button>
          </div>
        ) : null}
      </div>
      {preview ? (
        <Preview
          res={preview}
          typeName={types.find((t) => t.id === typeId)?.name ?? ''}
          busy={busy}
          onCommit={() => void run(false)}
          onCancel={() => pick(null)}
        />
      ) : null}
    </section>
  )
}

/** One task type's part of an upload. */
function RunSummary({ res }: { res: ImportResult }) {
  const r = res.run
  return (
    <>
      <div className="card-body" style={{ paddingTop: 0 }}>
        <div className={r.created ? 'inline-note' : 'inline-warning'}>
          {r.rows_read} rows: <strong>{r.created} new</strong>, {r.duplicates} already imported, {r.rejected} for unknown agents,{' '}
          {r.skipped} on the skip list{res.no_agent ? `, ${res.no_agent} with no agent (abandoned)` : ''}.{' '}
          <strong>{r.sampled} audits</strong> will be queued.
          {res.live_matched || res.live_flagged
            ? ` Live monitoring: ${res.live_matched} audit(s) matched to their call, ${res.live_flagged} flagged (no call within 20 s).`
            : ''}
        </div>
        {res.linked?.length ? (
          <div className="inline-note">
            <div>Agents matched for the first time (remembered from now on):</div>
            <div>
              {res.linked
                .map((l) => `${l.name}${l.key ? ` (${l.key})` : ''} → ${l.user_name}${l.how === 'name' ? '' : ` by ${l.how}`}`)
                .join(' · ')}
            </div>
          </div>
        ) : null}
        {res.rejected.some((a) => a.reason) ? (
          <div className="inline-warning">
            <div>Left out because this task type doesn't audit them (wrong team line):</div>
            <div>
              {res.rejected
                .filter((a) => a.reason)
                .map((a) => `${a.reason} (${a.rows} rows)`)
                .join(' · ')}
            </div>
          </div>
        ) : null}
        {res.rejected.some((a) => !a.reason) ? (
          <div className="inline-warning">
            <div>
              These agents are not on the team yet, so their rows are left out. Add them on Team with their Agent ID / email, then upload
              the sheet again:
            </div>
            <div>
              {res.rejected
                .filter((a) => !a.reason)
                .map((a) => `${a.name || '?'} (${a.key}, ${a.rows} rows)`)
                .join(' · ')}
            </div>
          </div>
        ) : null}
      </div>
      {res.employees.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>New rows</th>
                <th>Skipped</th>
                <th>Audits</th>
                <th>Picked codes / tags</th>
              </tr>
            </thead>
            <tbody>
              {res.employees.map((e) => (
                <tr key={e.employee_id}>
                  <td>{e.name}</td>
                  <td>{e.rows}</td>
                  <td>{e.skipped}</td>
                  <td>
                    <strong>{e.sampled}</strong>
                  </td>
                  <td className="text-secondary">
                    {e.labels.join(', ')}
                    {e.untagged ? `${e.labels.length ? ' + ' : ''}${e.untagged} without a code/tag` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}

/** All an upload would do: for a shared sheet, each task type it fills. */
function Preview({
  res,
  typeName,
  busy,
  onCommit,
  onCancel,
}: {
  res: ImportResult
  typeName: string
  busy: boolean
  onCommit: () => void
  onCancel: () => void
}) {
  const parts = res.also ?? []
  const created = res.run.created + parts.reduce((n, p) => n + (p.result?.run.created ?? 0), 0)
  const sampled = res.run.sampled + parts.reduce((n, p) => n + (p.result?.run.sampled ?? 0), 0)
  const unclaimed = Object.entries(res.unclaimed ?? {})
  return (
    <>
      {parts.length ? (
        <div className="form-section" style={{ padding: '0 24px' }}>
          {typeName}
        </div>
      ) : null}
      <RunSummary res={res} />
      {parts.map((p) => (
        <Fragment key={p.task_type}>
          <div className="form-section" style={{ padding: '0 24px' }}>
            {p.task_type}
          </div>
          {p.result ? (
            <RunSummary res={p.result} />
          ) : (
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="inline-warning">Not imported: {p.problem}</div>
            </div>
          )}
        </Fragment>
      ))}
      {unclaimed.length ? (
        <div className="card-body" style={{ paddingTop: 0 }}>
          <div className="inline-warning">
            No task type takes these rows, so they are left out: {unclaimed.map(([v, n]) => `${v || '(empty)'} (${n} rows)`).join(' · ')}.
            Add the value to a task type's settings to audit them.
          </div>
        </div>
      ) : null}
      <div className="card-foot">
        <span className="text-tertiary" style={{ marginRight: 'auto' }}>
          The exact rows are picked again at import, with the same counts per agent.
        </span>
        <button className="btn btn-secondary" onClick={onCancel}>
          Choose another file
        </button>
        <button className="btn btn-primary" disabled={busy || created === 0} onClick={onCommit}>
          Import and queue {sampled} audits
        </button>
      </div>
    </>
  )
}

function TicketsPull({ name, onDone, onError }: { name: string; onDone: (msg: string) => void; onError: (e: string) => void }) {
  const [day, setDay] = useState(yesterday())
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult | null>(null)

  async function pull() {
    setBusy(true)
    try {
      const r = await api.pullTickets(day)
      setRes(r)
      onDone(`${r.run.created} tickets imported; ${r.run.sampled} audits queued.`)
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">{name}</h2>
          <p className="card-subtitle">Pulled automatically every morning for the previous reporting day (05:00 to 05:00 Amman).</p>
        </div>
      </div>
      <div className="card-body builder-row">
        <div className="field">
          <label className="field-label">Reporting day</label>
          <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void pull()}>
          <CloudDownload size={16} />
          {busy ? 'Pulling… (can take a minute)' : 'Pull now'}
        </button>
      </div>
      {res?.rejected.length ? (
        <div className="card-body" style={{ paddingTop: 0 }}>
          <div className="inline-warning">
            Not on the team (add them on Team with this email): {res.rejected.map((a) => `${a.name} (${a.key})`).join(' · ')}
          </div>
        </div>
      ) : null}
    </section>
  )
}
