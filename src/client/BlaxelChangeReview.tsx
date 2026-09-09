import type { ReactNode } from 'react'
import type { ChangeReview } from './api.js'

const added = 'color-mix(in srgb, var(--dsw-alias-label-primary, #eee) 65%, #22c55e)'
const removed = 'color-mix(in srgb, var(--dsw-alias-label-primary, #eee) 65%, #ec1313)'
const hunk = 'var(--dsw-alias-state-business-primary, #8bbcff)'

/** Real changed paths and the exact patch the server will check again on Apply. */
export function BlaxelChangeReview({ review }: { review: ChangeReview }): ReactNode {
  return <section aria-label="Changes to bring back" style={{ marginBottom: 20 }}>
    <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', marginBottom: 12 }}>
      <strong>{review.divergence.changed} changed {review.divergence.changed === 1 ? 'file' : 'files'}</strong>
      <span style={{ color: added }}>+{review.divergence.insertions ?? 0}</span>
      <span style={{ color: removed }}>−{review.divergence.deletions ?? 0}</span>
    </div>
    <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', maxHeight: 140, overflow: 'auto' }}>
      {review.divergence.files.map(file => <li key={file.path} style={{ display: 'flex', gap: 12, padding: '4px 0', fontFamily: 'monospace' }}>
        <span style={{ color: added, minWidth: 22 }}>{file.status.trim() || 'M'}</span><span style={{ overflowWrap: 'anywhere' }}>{file.path}</span>
      </li>)}
    </ul>
    {review.patch !== '' && <pre tabIndex={0} aria-label="Patch preview" style={{ background: 'var(--dsw-alias-bg-base, #151517)', border: '1px solid var(--dsw-alias-border-l2, #444)', borderRadius: 8, fontSize: 12, lineHeight: 1.6, maxHeight: '42vh', overflow: 'auto', padding: 14, whiteSpace: 'pre' }}>{review.patch.split('\n').map((line, index) => <span key={index} style={{ display: 'block', color: line.startsWith('+') && !line.startsWith('+++') ? added : line.startsWith('-') && !line.startsWith('---') ? removed : line.startsWith('@@') ? hunk : undefined }}>{line || '\u00a0'}</span>)}</pre>}
  </section>
}
