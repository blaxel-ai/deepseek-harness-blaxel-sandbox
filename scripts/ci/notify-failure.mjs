#!/usr/bin/env node
// Direct-message the maintainer on Slack when a main-branch CI run fails.
// Same shape as the Blaxel benchmark failure alerts: a header, a copyable
// investigation prompt, and a button to the run.
//
// Environment (GitHub Actions secrets and context):
//   CI_ALERT_SLACK_BOT_TOKEN  bot token with chat:write
//   CI_ALERT_SLACK_USER_ID    Slack member ID that receives the DM
//   CI_ALERT_SLACK_TEAM_ID    expected Slack workspace ID (checked with auth.test)
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
// Pass --dry-run to print the message instead of sending it.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
// Jobs that are allowed to fail without alerting (early warning for the next DSH release).
const IGNORED_JOBS = new Set(['check-dsh-next'])
const clean = value => String(value ?? '').replace(/\p{Cc}/gu, ' ').replaceAll('`', "'").slice(0, 200)
const slackEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function failedJobs(jobs) {
  return jobs.filter(job => FAILED.has(job.conclusion) && !IGNORED_JOBS.has(job.name))
}

export function buildAlert({ repository, run, jobs, userId }) {
  const failed = failedJobs(jobs)
  if (failed.length === 0) return null
  const url = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`
  const heading = clean(`${repository.split('/')[1]} CI failed on ${run.head_branch} (${run.event})`).slice(0, 150)
  const details = failed.slice(0, 6).map(job => {
    const steps = (job.steps ?? []).filter(step => FAILED.has(step.conclusion)).map(step => clean(step.name))
    return `${clean(job.name)}: ${steps.join('; ') || 'no failed step recorded'}`
  })
  if (failed.length > 6) details.push(`${failed.length - 6} more failed jobs are listed in the run.`)
  const started = new Date(run.run_started_at ?? run.created_at)
  const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }).format(started)
  const prompt = [
    `Investigate this CI failure in ${repository}.`,
    `Workflow: ${clean(run.name)} · ${clean(run.event)} on ${clean(run.head_branch)} @ ${String(run.head_sha).slice(0, 7)}`,
    `Started: ${pacific} (${started.toISOString()})`,
    `Run: ${url}`,
    '', 'Failed jobs:', ...details,
    '', '1. Read the failed job logs and summarize what broke.',
    '2. Find the cause: compare with the last green run, recent commits, and upstream dependency releases (DSH, Cordis, @blaxel/core). Separate confirmed causes from hypotheses.',
    '3. Recommend the fix and how to verify it, then fix it.',
  ].join('\n')
  const code = '```' + slackEscape(prompt) + '```'
  assert(code.length <= 3000, 'Investigation prompt exceeds the Slack block limit')
  return {
    url,
    payload: {
      channel: userId,
      text: `${heading}\n${prompt}`,
      unfurl_links: false, unfurl_media: false,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: heading } },
        { type: 'section', block_id: `ci_failure_${run.id}_${run.run_attempt}`, text: { type: 'mrkdwn', text: code, verbatim: true } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View CI run' }, url }] },
      ],
    },
  }
}

async function github(route, token) {
  const response = await fetch(`https://api.github.com/${route}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } })
  assert(response.ok, `GitHub ${route} returned ${response.status}`)
  return response.json()
}

async function slack(method, body, token) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  assert(result.ok === true, `Slack ${method} failed: ${result.error ?? response.status}`)
  return result
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  assert(GITHUB_TOKEN && GITHUB_REPOSITORY && /^\d+$/.test(GITHUB_RUN_ID ?? '') && /^\d+$/.test(GITHUB_RUN_ATTEMPT ?? ''), 'GitHub run context is missing')
  const base = `repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`
  const run = await github(base, GITHUB_TOKEN)
  const { jobs } = await github(`${base}/jobs?per_page=100`, GITHUB_TOKEN)
  const dryRun = process.argv.includes('--dry-run')
  const alert = buildAlert({ repository: GITHUB_REPOSITORY, run, jobs, userId: process.env.CI_ALERT_SLACK_USER_ID ?? 'U_DRY_RUN' })
  if (!alert) { console.log('No alerting job failed; nothing to send.'); return }
  if (dryRun) { console.log(JSON.stringify(alert.payload, null, 2)); return }
  const token = process.env.CI_ALERT_SLACK_BOT_TOKEN
  const userId = process.env.CI_ALERT_SLACK_USER_ID
  assert(/^xoxb-[A-Za-z0-9-]+$/.test(token ?? ''), 'CI_ALERT_SLACK_BOT_TOKEN is missing or malformed')
  assert(/^[UW][A-Z0-9]+$/.test(userId ?? ''), 'CI_ALERT_SLACK_USER_ID is missing or malformed')
  const auth = await slack('auth.test', {}, token)
  assert(auth.team_id === process.env.CI_ALERT_SLACK_TEAM_ID, 'Slack token belongs to an unexpected workspace')
  const sent = await slack('chat.postMessage', alert.payload, token)
  assert(/^D[A-Z0-9]+$/.test(sent.channel ?? ''), 'Slack did not deliver to a direct-message channel')
  console.log(`Sent failure DM for ${alert.url} (ts ${sent.ts})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
