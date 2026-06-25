export function Placeholder({ title }: { title: string }) {
  return (
    <main
      style={{
        padding: 'var(--space-6, 24px)',
        color: 'var(--text)',
      }}
    >
      <h1 style={{ margin: 0, fontWeight: 600 }}>{title}</h1>
    </main>
  )
}
