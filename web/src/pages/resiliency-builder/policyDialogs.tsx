import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { Field, TextInput, NumberInput, SelectInput } from '../../components/form'
import { validateResourceName, validateGoDuration, validateStatusCodes, integerError } from '../../lib/validation'
import type { RetryPolicy, CircuitBreakerPolicy } from '../../types/resiliency'
export { NamedList } from './NamedList'

function DialogShell({ open, title, onClose, onSave, canSave, children }: {
  open: boolean; title: string; onClose: () => void; onSave: () => void; canSave: boolean; children: React.ReactNode
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      {children}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn ghost" disabled={!canSave} onClick={onSave}>Save</button>
      </div>
    </Modal>
  )
}

export function TimeoutDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, duration: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [duration, setDuration] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durOk = duration !== '' && validateGoDuration(duration).valid
  return (
    <DialogShell open={open} title="Add timeout policy" onClose={onClose} canSave={!nameErr && durOk}
      onSave={() => onSave(name, duration)}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Timeout name" value={name} onChange={setName} />
      </Field>
      <Field label="Duration" required error={duration === '' ? null : (durOk ? null : validateGoDuration(duration).error)}>
        <TextInput aria-label="Duration" placeholder="30s" value={duration} onChange={setDuration} />
      </Field>
    </DialogShell>
  )
}

export function RetryDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, policy: RetryPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [policy, setPolicy] = useState<'constant' | 'exponential'>('constant')
  const [duration, setDuration] = useState('5s')
  const [maxInterval, setMaxInterval] = useState('60s')
  const [maxRetries, setMaxRetries] = useState('-1')
  const [http, setHttp] = useState('')
  const [grpc, setGrpc] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durField = policy === 'constant' ? duration : maxInterval
  const durOk = validateGoDuration(durField).valid
  const numOk = integerError(maxRetries) === null
  const codesOk = validateStatusCodes(http) === null && validateStatusCodes(grpc) === null
  const canSave = !nameErr && durOk && numOk && codesOk
  function save() {
    const p: RetryPolicy = {
      policy,
      maxRetries: maxRetries === '' ? undefined : Number(maxRetries),
      matching: { httpStatusCodes: http, grpcStatusCodes: grpc },
    }
    if (policy === 'constant') p.duration = duration
    else p.maxInterval = maxInterval
    onSave(name, p)
  }
  return (
    <DialogShell open={open} title="Add retry policy" onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Retry name" value={name} onChange={setName} />
      </Field>
      <Field label="Policy" required>
        <SelectInput aria-label="Retry policy type" value={policy}
          options={[{ label: 'constant', value: 'constant' }, { label: 'exponential', value: 'exponential' }]}
          onChange={(v) => setPolicy(v === 'exponential' ? 'exponential' : 'constant')} />
      </Field>
      {policy === 'constant' ? (
        <Field label="Duration" required error={durOk ? null : validateGoDuration(duration).error}>
          <TextInput aria-label="Duration" placeholder="5s" value={duration} onChange={setDuration} />
        </Field>
      ) : (
        <Field label="Max interval" required error={durOk ? null : validateGoDuration(maxInterval).error}>
          <TextInput aria-label="Max interval" placeholder="60s" value={maxInterval} onChange={setMaxInterval} />
        </Field>
      )}
      <Field label="Max retries" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max retries" value={maxRetries} onChange={setMaxRetries} />
      </Field>
      <Field label="HTTP status codes" error={validateStatusCodes(http)}>
        <TextInput aria-label="HTTP status codes" placeholder="429,500-504" value={http} onChange={setHttp} />
      </Field>
      <Field label="gRPC status codes" error={validateStatusCodes(grpc)}>
        <TextInput aria-label="gRPC status codes" placeholder="4,8,14" value={grpc} onChange={setGrpc} />
      </Field>
    </DialogShell>
  )
}

export function CircuitBreakerDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, policy: CircuitBreakerPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [maxRequests, setMaxRequests] = useState('')
  const [timeout, setTimeout] = useState('')
  const [trip, setTrip] = useState('')
  const [interval, setInterval] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const numOk = integerError(maxRequests) === null
  const toOk = validateGoDuration(timeout).valid
  const ivOk = validateGoDuration(interval).valid
  const canSave = !nameErr && numOk && toOk && ivOk
  function save() {
    onSave(name, {
      maxRequests: maxRequests === '' ? undefined : Number(maxRequests),
      timeout, trip, interval,
    })
  }
  return (
    <DialogShell open={open} title="Add circuit breaker policy" onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Circuit breaker name" value={name} onChange={setName} />
      </Field>
      <Field label="Max requests" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max requests" value={maxRequests} onChange={setMaxRequests} />
      </Field>
      <Field label="Timeout" error={timeout === '' ? null : (toOk ? null : validateGoDuration(timeout).error)}>
        <TextInput aria-label="Timeout" placeholder="30s" value={timeout} onChange={setTimeout} />
      </Field>
      <Field label="Trip (CEL)">
        <TextInput aria-label="Trip" placeholder="consecutiveFailures >= 5" value={trip} onChange={setTrip} />
      </Field>
      <Field label="Interval" error={interval === '' ? null : (ivOk ? null : validateGoDuration(interval).error)}>
        <TextInput aria-label="Interval" placeholder="8s" value={interval} onChange={setInterval} />
      </Field>
    </DialogShell>
  )
}
