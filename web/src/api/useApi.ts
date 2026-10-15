import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './client'

interface State<T> {
  data: T | null
  error: string | null
  loading: boolean
}

/**
 * Loads data on mount and whenever a dependency changes, with a manual reload
 * for after a mutation. Keeps the previous data visible while refetching so the
 * page does not flash empty on every poll.
 *
 * Each load is generation-tagged so a slower response from a previous
 * selection cannot overwrite the one the agent is looking at now.
 */
export function useApi<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: { pollMs?: number } = {},
) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: true })
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const alive = useRef(true)
  const gen = useRef(0)

  const reload = useCallback(async () => {
    const my = ++gen.current
    try {
      const data = await loaderRef.current()
      if (!alive.current || my !== gen.current) return data
      setState({ data, error: null, loading: false })
      return data
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong.'
      if (!alive.current || my !== gen.current) return null
      setState((prev) => ({ ...prev, error: message, loading: false }))
      return null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true }))
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // A fixed-cadence setInterval fires again even while the previous reload is
  // still in flight — harmless when the server answers quickly, but the
  // moment one response is slow (a heavy import holding the database, a
  // network hiccup) it stacks a second request on top of the first, then a
  // third on top of that, each one adding to the same load that made the
  // first one slow. Scheduling the next poll only after the current one
  // settles means at most one request for this hook is ever in flight, and
  // a slow patch naturally backs off instead of piling on.
  useEffect(() => {
    if (!options.pollMs) return
    let cancelled = false
    let timer: number | undefined
    const tick = () => {
      void reload().finally(() => {
        if (!cancelled) timer = window.setTimeout(tick, options.pollMs)
      })
    }
    timer = window.setTimeout(tick, options.pollMs)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [options.pollMs, reload])

  return { ...state, reload, setData: (data: T) => setState({ data, error: null, loading: false }) }
}
