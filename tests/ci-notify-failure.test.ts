import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAlert, failedJobs, type WorkflowJob, type WorkflowRun } from '../scripts/ci/notify-failure.mjs'

const repository = 'blaxel-ai/deepseek-harness-blaxel-sandbox'
const load = async <T>(name: string): Promise<T> => JSON.parse(await readFile(resolve('tests/fixtures', name), 'utf8')) as T

describe('CI failure DM', () => {
  it('reports the failed jobs and steps of the 2026-09-28 scheduled run, without the allowed-to-fail DSH-next check', async () => {
    const run = await load<WorkflowRun>('ci-failed-run.json')
    const { jobs } = await load<{ jobs: WorkflowJob[] }>('ci-failed-jobs.json')
    expect(failedJobs(jobs).map(job => job.name).sort()).toEqual(['e2e (24)', 'live-smoke'])
    const alert = buildAlert({ repository, run, jobs, userId: 'U123' })!
    expect(alert.url).toBe(`https://github.com/${repository}/actions/runs/${run.id}/attempts/1`)
    expect(alert.payload.channel).toBe('U123')
    const [header, section, actions] = alert.payload.blocks
    expect(header?.text?.text).toBe('deepseek-harness-blaxel-sandbox CI failed on main (schedule)')
    expect(section?.block_id).toBe(`ci_failure_${run.id}_1`)
    expect(section?.text?.text.startsWith('```Investigate this CI failure')).toBe(true)
    expect(section?.text?.text).toContain('live-smoke: Live sandbox smoke')
    expect(section?.text?.text).not.toContain('check-dsh-next')
    expect(actions?.elements?.[0]?.url).toBe(alert.url)
  })

  it('sends nothing when only the allowed-to-fail check failed', async () => {
    const run = await load<WorkflowRun>('ci-failed-run.json')
    const jobs: WorkflowJob[] = [{ name: 'check-dsh-next', conclusion: 'failure' }, { name: 'check (22)', conclusion: 'success' }]
    expect(buildAlert({ repository, run, jobs, userId: 'U123' })).toBeNull()
  })

  it('escapes Slack control characters and backticks from job names', async () => {
    const run = await load<WorkflowRun>('ci-failed-run.json')
    const alert = buildAlert({ repository, run, jobs: [{ name: 'e2e <@here> `x` & y', conclusion: 'failure' }], userId: 'U123' })!
    const text = alert.payload.blocks[1]?.text?.text ?? ''
    expect(text).toContain('e2e &lt;@here&gt; \'x\' &amp; y')
    expect(text.slice(3, -3)).not.toContain('`')
  })
})
