interface NamedListProps {
  title: string
  names: string[]
  onAdd: () => void
  onRemove: (name: string) => void
}

export function NamedList({ title, names, onAdd, onRemove }: NamedListProps) {
  return (
    <div className="sbsection">
      <div className="sech">
        {title}
        <button type="button" className="btn ghost" style={{ marginLeft: 'auto' }} aria-label={`Add ${title}`} onClick={onAdd}>
          + Add
        </button>
      </div>
      {names.length === 0 ? (
        <p className="none">None yet.</p>
      ) : (
        names.map((name) => (
          <div key={name} className="chip k" style={{ marginRight: 6, marginBottom: 6 }}>
            <b>{name}</b>
            <button type="button" className="copybtn" aria-label={`Remove ${name}`} onClick={() => onRemove(name)}>✕</button>
          </div>
        ))
      )}
    </div>
  )
}
