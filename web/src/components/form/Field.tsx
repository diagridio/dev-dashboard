interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  error?: string | null
  children: React.ReactNode
}

export function Field({ label, htmlFor, required, error, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {children}
      {error && <div className="field-err">{error}</div>}
    </div>
  )
}
