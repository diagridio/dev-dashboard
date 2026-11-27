import { useRef } from 'react'

interface ClearableInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  /** Field label, used for the button's aria-label ("Clear <label>"). */
  label: string
}

/**
 * Text input with a small × that empties it. Used for fields with datalist
 * suggestions: a browser only suggests entries matching the current text, so a
 * prefilled value hides the rest until it is cleared.
 */
export function ClearableInput({ value, onChange, label, className, readOnly, disabled, ...rest }: ClearableInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const showClear = value !== '' && !readOnly && !disabled
  return (
    <span className="inp-clear">
      <input
        {...rest}
        ref={ref}
        className={className ?? 'inp'}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {showClear && (
        <button
          type="button"
          className="inp-x"
          aria-label={`Clear ${label}`}
          onClick={() => {
            onChange('')
            ref.current?.focus()
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}
