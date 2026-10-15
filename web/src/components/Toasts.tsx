import { useCallback, useState } from 'react'
import { AlertCircle, CheckCircle2, Info } from 'lucide-react'

export type ToastTone = 'success' | 'info' | 'error'

interface Toast {
  id: number
  tone: ToastTone
  text: string
}

/** How many stay on screen at once. Working quickly through a queue used to
 *  bury the task pane under a column of toasts, each waiting out its own
 *  timer — the confirmations were louder than the work. */
const MAX_VISIBLE = 3

/** An error has to survive long enough to be read and acted on; a
 *  confirmation only has to be noticed. */
const LIFETIME: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  error: 9000,
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((tone: ToastTone, text: string) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => {
      // The same line again replaces the one already up rather than stacking
      // beside it, so a run of identical results reads as one message.
      const rest = prev.filter((t) => !(t.tone === tone && t.text === text))
      return [...rest, { id, tone, text }].slice(-MAX_VISIBLE)
    })
    // A timer for a toast that has already been pushed out simply matches
    // nothing, so there is nothing to cancel.
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), LIFETIME[tone])
  }, [])

  return { toasts, push }
}

const ICONS = {
  success: CheckCircle2,
  info: Info,
  error: AlertCircle,
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone]
        return (
          <div
            className={`toast toast-${toast.tone}`}
            key={toast.id}
            // A failure is worth interrupting a screen reader for; a
            // confirmation waits its turn.
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon">
              <Icon size={17} />
            </span>
            {toast.text}
          </div>
        )
      })}
    </div>
  )
}
