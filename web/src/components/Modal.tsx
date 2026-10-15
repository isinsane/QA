import { useEffect } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * A dialog: title bar, a body that scrolls on its own, and a footer that
 * stays put. With onSubmit the whole dialog is a form, so Enter submits.
 */
export function Modal({
  title,
  subtitle,
  size = 'md',
  onClose,
  onSubmit,
  footer,
  children,
}: {
  title: string
  subtitle?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  onSubmit?: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const content = (
    <>
      <header className="dialog-head">
        <div>
          <h2 className="dialog-title">{title}</h2>
          {subtitle ? <p className="dialog-subtitle">{subtitle}</p> : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
          <X size={17} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer ? <footer className="dialog-foot">{footer}</footer> : null}
    </>
  )

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      {onSubmit ? (
        <form
          className={`dialog dialog-${size}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onMouseDown={(e) => e.stopPropagation()}
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {content}
        </form>
      ) : (
        <div className={`dialog dialog-${size}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
          {content}
        </div>
      )}
    </div>
  )
}
