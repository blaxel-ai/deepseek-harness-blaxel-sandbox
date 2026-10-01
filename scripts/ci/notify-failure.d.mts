export interface WorkflowJob { name: string, conclusion: string | null, steps?: { name: string, conclusion: string | null }[] }
export interface WorkflowRun { id: number, run_attempt: number, event: string, head_branch: string, head_sha: string, name: string, run_started_at?: string, created_at?: string }
export interface SlackAlert { url: string, payload: { channel: string, text: string, blocks: { type: string, block_id?: string, text?: { type: string, text: string }, elements?: { type: string, url: string }[] }[] } }
export function failedJobs(jobs: WorkflowJob[]): WorkflowJob[]
export function buildAlert(input: { repository: string, run: WorkflowRun, jobs: WorkflowJob[], userId: string }): SlackAlert | null
