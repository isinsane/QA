import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { AckBadge, Empty, fmtDate, fmtDateTime, ScoreBadge } from '../components/bits'

type Tab = 'dispute_supervisor' | 'dispute_qa' | 'dispute_resolved'

const TABS: [Tab, string, string][] = [
  ['dispute_supervisor', 'Waiting for you', 'Review each one, then keep the score, edit it, or send it to the QA agent who scored it.'],
  ['dispute_qa', 'With the QA agent', 'Sent to the QA agent who scored it. You can still keep or change the score yourself.'],
  ['dispute_resolved', 'Resolved', 'Answered disputes, newest first.'],
]

/** Every dispute agents raised, by where it stands. */
export function DisputesPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('dispute_supervisor')
  const [page, setPage] = useState(1)
  const list = useApi(() => api.tasks({ state: tab, page }), [tab, page], { pollMs: 60_000 })
  const waiting = useApi(() => api.tasks({ state: 'dispute_supervisor' }), [], { pollMs: 60_000 })
  const withQA = useApi(() => api.tasks({ state: 'dispute_qa' }), [], { pollMs: 60_000 })
  const rows = list.data?.tasks ?? []
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (list.data?.page_size ?? 50)))
  const count: Partial<Record<Tab, number | undefined>> = { dispute_supervisor: waiting.data?.total, dispute_qa: withQA.data?.total }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Disputes</h1>
          <p className="page-subtitle">Evaluations an agent disagreed with. A dispute comes to you first.</p>
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
            {count[key] ? <span className={`badge ${key === 'dispute_supervisor' ? 'badge-error' : 'badge-gray'}`} style={{ marginLeft: 8 }}>{count[key]}</span> : null}
          </button>
        ))}
      </div>

      <section className="card">
        <div className="card-header">
          <p className="card-subtitle">{TABS.find(([k]) => k === tab)?.[2]}</p>
        </div>
        {rows.length === 0 && !list.loading ? (
          <Empty title={tab === 'dispute_supervisor' ? 'Nothing waiting for you' : 'No disputes here'} />
        ) : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Score</th>
                  <th style={{ width: '38%' }}>{tab === 'dispute_resolved' ? 'Answer' : 'What the agent says'}</th>
                  <th>Scored by</th>
                  <th>{tab === 'dispute_resolved' ? 'Status' : 'Disputed'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                    <td>
                      <strong>{t.employee_name}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {t.task_type_name} · worked {fmtDate(t.work_date)}
                      </div>
                    </td>
                    <td>
                      <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                    </td>
                    <td className="dispute-text">
                      {tab === 'dispute_resolved' ? (
                        <>
                          {t.dispute_resolution || <span className="text-tertiary">No reply written</span>}
                          <div className="text-tertiary" style={{ fontSize: 12 }}>
                            Agent: "{t.ack_comment}"
                          </div>
                        </>
                      ) : (
                        `"${t.ack_comment}"`
                      )}
                    </td>
                    <td>{t.qa_name ?? '—'}</td>
                    <td>{tab === 'dispute_resolved' ? <AckBadge status={t.ack_status} /> : <span className="text-secondary">{fmtDateTime(t.ack_at)}</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {pages > 1 ? (
          <div className="card-foot">
            <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="text-secondary">
              Page {page} of {pages}
            </span>
            <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
