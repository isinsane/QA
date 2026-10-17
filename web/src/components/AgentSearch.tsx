import { useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ReportAgent } from '../api/types'

/** Lower case, no accents, letters and digits only: "Abdel-Qader" → "abdel qader". */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()
}

/**
 * How well an agent matches: every word typed must appear in their name,
 * alias, team or HR department, in any order; a word that starts a name or
 * alias counts most. 0: no match.
 */
function agentScore(a: ReportAgent, q: string): number {
  const names = `${norm(a.name)} ${norm(a.alias_name)}`
  const all = `${names} ${norm(a.team)} ${norm(a.department)}`
  const words = names.split(' ')
  let score = 1
  for (const t of q.split(' ')) {
    if (!all.includes(t)) return 0
    score += words.some((w) => w.startsWith(t)) ? 3 : names.includes(t) ? 2 : 1
  }
  return score + (norm(a.name).startsWith(q) || norm(a.alias_name).startsWith(q) ? 5 : 0)
}

/**
 * For a typo, when nothing matches as typed: the letters typed, in order,
 * within one name or alias, from the start of one of its words and not
 * spread out ("abdlqadr" finds Abdelqader). 0: no match.
 */
function typoScore(a: ReportAgent, q: string): number {
  const typed = q.replace(/ /g, '')
  let best = 0
  for (const name of [norm(a.name), norm(a.alias_name)]) {
    const s = name.replace(/ /g, '')
    let at = 0
    for (const w of name.split(' ')) {
      let i = 0
      let j = at
      for (; j < s.length && i < typed.length; j++) if (s[j] === typed[i]) i++
      if (s[at] === typed[0] && i === typed.length) best = Math.max(best, typed.length / (j - at))
      at += w.length
    }
  }
  return best >= 0.6 ? best : 0
}

/** Up to 8 agents for what was typed, best first. */
function search(agents: ReportAgent[], query: string): ReportAgent[] {
  const q = norm(query)
  if (!q) return []
  const rank = (score: (a: ReportAgent) => number) =>
    agents
      .map((a) => ({ a, s: score(a) }))
      .filter((h) => h.s > 0)
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
      .slice(0, 8)
      .map((h) => h.a)
  const hits = rank((a) => agentScore(a, q))
  return hits.length ? hits : rank((a) => typoScore(a, q))
}

/** Pick an agent by typing part of their name or alias (or team), instead of scrolling a list. */
export function AgentSearch({
  agents,
  value,
  onChange,
  label,
}: {
  agents: ReportAgent[]
  value: string
  onChange: (id: string) => void
  label: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const picked = agents.find((a) => a.id === value)
  const hits = useMemo(() => search(agents, q), [agents, q])

  function pick(a: ReportAgent) {
    onChange(a.id)
    setQ('')
    setOpen(false)
  }

  if (picked) {
    return (
      <div className="agent-picked">
        <span>
          <span>
            <strong>{picked.name}</strong>
            {picked.alias_name ? <span className="text-secondary"> · known as {picked.alias_name}</span> : null}
          </span>
          <small>{[picked.team || 'No team', picked.department].filter(Boolean).join(' · ')}</small>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          title="Pick another agent"
          aria-label="Pick another agent"
          onClick={() => {
            onChange('')
            setTimeout(() => input.current?.focus())
          }}
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="agent-search">
      <div className="input-group">
        <span className="input-group-icon">
          <Search size={15} />
        </span>
        <input
          ref={input}
          className="input"
          aria-label={label}
          placeholder={agents.length ? `Type a name or alias (${agents.length} agents)` : 'Loading agents…'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0))
            else if (e.key === 'Escape') setOpen(false)
            else if (e.key === 'Enter') {
              e.preventDefault() // not the form's submit
              if (hits[active]) pick(hits[active])
            } else return
            e.preventDefault()
          }}
        />
      </div>
      {open && q.trim() ? (
        <ul className="agent-search-list" role="listbox">
          {hits.length === 0 ? <li className="agent-search-none">No agent matches "{q.trim()}"</li> : null}
          {hits.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus until picked
                pick(a)
              }}
            >
              <span>
                <strong>{a.name}</strong>
                {a.alias_name ? <span className="text-secondary"> · {a.alias_name}</span> : null}
              </span>
              <small>{[a.team || 'No team', a.department].filter(Boolean).join(' · ')}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
