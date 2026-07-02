interface TextInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  'aria-label'?: string
}

export function TextInput({ id, value, onChange, placeholder, type = 'text', ...rest }: TextInputProps) {
  return (
    <input
      id={id}
      className="inp"
      type={type}
      value={value}
      placeholder={placeholder}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
