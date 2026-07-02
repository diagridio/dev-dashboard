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

export function TimeoutDialog({ open, initialName, initialDuration, editing, onClose, onSave }: {
  open: boolean; initialName: string; initialDuration?: string; editing?: boolean; onClose: () => void; onSave: (name: string, duration: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [duration, setDuration] = useState(initialDuration ?? '5s')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durOk = duration !== '' && validateGoDuration(duration).valid
  return (
    <DialogShell open={open} title={editing ? 'Edit timeout policy' : 'Add timeout policy'} onClose={onClose} canSave={!nameErr && durOk}
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

export function RetryDialog({ open, initialName, initialPolicy, editing, lockName, keepDurationForExponential, onClose, onSave }: {
  open: boolean; initialName: string; initialPolicy?: RetryPolicy; editing?: boolean; lockName?: boolean; keepDurationForExponential?: boolean
  onClose: () => void; onSave: (name: string, policy: RetryPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [policy, setPolicy] = useState<'constant' | 'exponential'>(initialPolicy?.policy ?? 'constant')
  const [duration, setDuration] = useState(initialPolicy?.duration ?? '5s')
  const [maxInterval, setMaxInterval] = useState(initialPolicy?.maxInterval ?? '60s')
  const [maxRetries, setMaxRetries] = useState(initialPolicy?.maxRetries?.toString() ?? '-1')
  const [http, setHttp] = useState(initialPolicy?.matching?.httpStatusCodes ?? '')
  const [grpc, setGrpc] = useState(initialPolicy?.matching?.grpcStatusCodes ?? '')
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
    if (policy === 'constant') {
      p.duration = duration
    } else {
      p.maxInterval = maxInterval
      if (keepDurationForExponential && duration !== '') p.duration = duration
    }
    onSave(name, p)
  }
  return (
    <DialogShell open={open} title={editing ? 'Edit retry policy' : 'Add retry policy'} onClose={onClose} canSave={canSave} onSave={save}>
      {lockName ? (
        <Field label="Name"><b>{name}</b></Field>
      ) : (
        <Field label="Name" required error={name === '' ? null : nameErr}>
          <TextInput aria-label="Retry name" value={name} onChange={setName} />
        </Field>
      )}
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

export function CircuitBreakerDialog({ open, initialName, initialPolicy, editing, onClose, onSave }: {
  open: boolean; initialName: string; initialPolicy?: CircuitBreakerPolicy; editing?: boolean; onClose: () => void; onSave: (name: string, policy: CircuitBreakerPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [maxRequests, setMaxRequests] = useState(initialPolicy?.maxRequests?.toString() ?? '1')
  const [timeoutDur, setTimeoutDur] = useState(initialPolicy?.timeout ?? '45s')
  const [trip, setTrip] = useState(initialPolicy?.trip ?? 'consecutiveFailures >= 5')
  const [intervalDur, setIntervalDur] = useState(initialPolicy?.interval ?? '8s')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const numOk = integerError(maxRequests) === null
  const toOk = validateGoDuration(timeoutDur).valid
  const ivOk = validateGoDuration(intervalDur).valid
  const canSave = !nameErr && numOk && toOk && ivOk
  function save() {
    onSave(name, {
      maxRequests: maxRequests === '' ? undefined : Number(maxRequests),
      timeout: timeoutDur, trip, interval: intervalDur,
    })
  }
  return (
    <DialogShell open={open} title={editing ? 'Edit circuit breaker policy' : 'Add circuit breaker policy'} onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Circuit breaker name" value={name} onChange={setName} />
      </Field>
      <Field label="Max requests" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max requests" value={maxRequests} onChange={setMaxRequests} />
      </Field>
      <Field label="Timeout" error={timeoutDur === '' ? null : (toOk ? null : validateGoDuration(timeoutDur).error)}>
        <TextInput aria-label="Timeout" placeholder="30s" value={timeoutDur} onChange={setTimeoutDur} />
      </Field>
      <Field label="Trip (CEL)">
        <TextInput aria-label="Trip" placeholder="consecutiveFailures >= 5" value={trip} onChange={setTrip} />
      </Field>
      <Field label="Interval" error={intervalDur === '' ? null : (ivOk ? null : validateGoDuration(intervalDur).error)}>
        <TextInput aria-label="Interval" placeholder="8s" value={intervalDur} onChange={setIntervalDur} />
      </Field>
    </DialogShell>
  )
}
