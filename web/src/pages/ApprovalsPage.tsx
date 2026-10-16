import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { EvaluationChange } from '../api/types'
import { AckBadge, Empty, errorText, fmtDate, fmtDateTime, Pager } from '../components/bits'
import { ToastStack, useToasts } from '../components/Toasts'
import { ReasonDialog } from './TaskPage'

type Tab = 'pending' | 'approved' | 'rejected'

const TABS: [Tab, string, string][] = [
  ['pending', 'Waiting', 'QA agents asked to change the score of an audit they submitted. Until you approve, the audit keeps its score.'],
  ['approved', 'Approved', 'Applied, newest first.'],
  ['rejected', 'Rejected', 'The score stayed, newest first.'],
]

const pct = (n: number | null) => (n === null ? '—' : `${n}%`)

/** Supervisors: QA agents' score changes waiting for approval. */
export function ApprovalsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('pending')
  const [page, setPage] = useState(1)
  const [deciding, setDeciding] = useState<{ c: EvaluationChange; approve: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const { toasts, push } = useToasts()
  const list = useApi(() => api.changes({ status: tab, page }), [tab, page], { pollMs: 60_000 })
  const waiting = useApi(() => api.changes({ status: 'pending' }), [], { pollMs: 60_000 })
  const rows = list.data?.changes ?? []

  async function decide(note: string) {
    if (!deciding) return
    setBusy(true)
    try {
      await (deciding.approve ? api.approveChange(deciding.c.id, note) : api.rejectChange(deciding.c.id, note))
      push('success', deciding.approve ? 'Approved: the new score applies' : 'Rejected: the score stays')
      setDeciding(null)
      void list.reload()
      void waiting.reload()
    } catch (err) {
      push('error', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-subtitle">Score changes QA agents asked for. Notes-only edits don't come here; they apply at once.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? ' active' : ''}`}
            onClick={() => {
              setTab(key)
              setPage(1)
            }}
          >
            {label}
            {key === 'pending' && waiting.data?.total ? (
              <span className="badge badge-error" style={{ marginLeft: 8 }}>
                {waiting.data.total}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <section className="card">
        <div className="card-header">
          <p className="card-subtitle">{TABS.find(([k]) => k === tab)?.[2]}</p>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title={tab === 'pending' ? 'Nothing waiting' : 'None here'} /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Score</th>
                  <th style={{ width: '34%' }}>Why</th>
                  <th>Asked by</th>
                  <th>{tab === 'pending' ? '' : 'Decided'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="is-clickable" onClick={() => navigate(`/tasks/${c.task_id}`)}>
                    <td>
                      <strong>{c.employee_name}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {c.task_type_name} · worked {fmtDate(c.work_date ?? null)}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {pct(c.score_before)} → <strong>{pct(c.score)}</strong>
                      {c.ack_status === 'disputed' || c.ack_status === 'dispute_qa' ? (
                        <div>
                          <AckBadge status={c.ack_status} />
                        </div>
                      ) : null}
                    </td>
                    <td className="dispute-text">"{c.reason}"</td>
                    <td>
                      {c.requested_by_name}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {fmtDateTime(c.created_at)}
                      </div>
                    </td>
                    <td onClick={(e) => tab === 'pending' && e.stopPropagation()}>
                      {tab === 'pending' ? (
                        <span className="builder-row" style={{ flexWrap: 'nowrap' }}>
                          <button className="btn btn-primary btn-sm" onClick={() => setDeciding({ c, approve: true })}>
                            Approve
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setDeciding({ c, approve: false })}>
                            Reject
                          </button>
                        </span>
                      ) : (
                        <>
                          {c.decided_by_name || '—'}
                          <div className="text-tertiary" style={{ fontSize: 12 }}>
                            {fmtDateTime(c.decided_at)}
                            {c.decision_note ? ` · ${c.decision_note}` : ''}
                          </div>
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Pager page={page} total={list.data?.total ?? 0} size={list.data?.page_size ?? 50} onPage={setPage} />
      </section>
      {deciding ? (
        <ReasonDialog
          title={deciding.approve ? 'Approve the score change' : 'Reject the score change'}
          placeholder={deciding.approve ? 'Note for the QA agent (optional)' : 'Why, for the QA agent'}
          action={deciding.approve ? 'Approve' : 'Reject'}
          busy={busy}
          optional={deciding.approve}
          onClose={() => setDeciding(null)}
          onSubmit={(note) => void decide(note)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}
