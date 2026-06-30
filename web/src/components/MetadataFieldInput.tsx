import type { MetadataField } from '../types/metadata'

interface Props {
  field: MetadataField
  value: string
  onChange: (v: string) => void
}

export function MetadataFieldInput({ field, value, onChange }: Props) {
  if (field.allowedValues && field.allowedValues.length > 0) {
    return (
      <select className="inp" aria-label={field.name} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.allowedValues.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  }
  if (field.type === 'bool') {
    return (
      <input
        type="checkbox"
        aria-label={field.name}
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : '')}
      />
    )
  }
  const type = field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'
  return (
    <input
      className="inp"
      type={type}
      aria-label={field.name}
      value={value}
      placeholder={field.example ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
