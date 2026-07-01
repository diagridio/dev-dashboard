interface NumberInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
}

// value is kept as a string so the field can be empty; callers coerce on emit.
export function NumberInput({ id, value, onChange, placeholder, ...rest }: NumberInputProps) {
  return (
    <input
      id={id}
      className="inp"
      type="number"
      value={value}
      placeholder={placeholder}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
