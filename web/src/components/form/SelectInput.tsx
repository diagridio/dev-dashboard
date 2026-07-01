interface SelectOption {
  label: string
  value: string
}

interface SelectInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  'aria-label'?: string
}

export function SelectInput({ id, value, onChange, options, ...rest }: SelectInputProps) {
  return (
    <select
      id={id}
      className="select"
      value={value}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
