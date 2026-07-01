interface ToggleProps {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

export function Toggle({ id, checked, onChange, label }: ToggleProps) {
  return (
    <label className="childtoggle">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
