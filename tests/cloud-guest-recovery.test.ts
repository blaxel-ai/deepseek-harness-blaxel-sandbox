import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

const io = vi.hoisted(() => ({ write: vi.fn(), rm: vi.fn() }))
vi.mock('../src/cloud/private-json.js', () => ({ writePrivateJson: io.write }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), rm: io.rm }))
vi.mock('../src/cloud/related-sessions.js', () => ({ relatedSessions: async () => [], validateRelated: () => [] }))
vi.mock('../src/cloud/attachments.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/cloud/attachments.js')>(), exportImages: async () => [] }))
import BlaxelCloudGuest from '../src/cloud-guest.js'

afterEach(() => vi.resetAllMocks())
function fixture() {
  const session = Session.create(SessionId('guest-root'))
  const root = { id: session.id, session, status: 'idle', runMaintenance: async () => undefined }
  const child = { id: SessionId('guest-child'), session, status: 'running', whenIdle: vi.fn(async () => { child.status = 'idle' }) }
  const agents = [root, child]
  const service = Object.create(BlaxelCloudGuest.prototype)
  Object.defineProperty(service, 'ctx', { value: { agents: { list: () => agents, get: (id: string) => agents.find(item => item.id === id) }, sessions: { flush: async () => true }, attachments: {} } })
  Object.assign(service, { agent: root, seed: { session: { meta: session.header } }, held: false, freezing: false, resumeMessages: [], drafts: { get: async () => undefined } })
  return { service, root, child, agents }
}

describe('cloud checkpoint recovery', () => {
  it('settles a working child before freezing without queuing an unresumable child continuation', async () => {
    const { service, child } = fixture()
    const frozen = await service.control('freeze')
    expect(child.whenIdle).toHaveBeenCalledOnce()
    expect(frozen.continueTask).toBe(true)
    expect(service.resumeMessages).toEqual([])
    expect(service.blocksAll()).toBe(true)
    expect(await service.control('freeze')).toBe(frozen)
  })
  it('keeps admission closed when release cleanup fails and allows retry', async () => {
    const { service } = fixture()
    await service.control('freeze')
    io.rm.mockRejectedValueOnce(new Error('temporary filesystem failure'))
    await expect(service.control('release')).rejects.toThrow('temporary filesystem failure')
    expect(service.blocksAll()).toBe(true)
    expect(io.write).toHaveBeenCalledWith('/opt/dsh-blaxel/release.json', [])
    await expect(service.control('release')).resolves.toEqual({ released: true })
    expect(service.blocksAll()).toBe(false)
  })
  it('retains the freeze fence after a child wait fails and retries the checkpoint', async () => {
    const { service, child } = fixture()
    child.whenIdle.mockRejectedValueOnce(new Error('interrupted wait'))
    await expect(service.control('freeze')).rejects.toThrow('interrupted wait')
    expect(service.blocksAll()).toBe(true)
    await expect(service.control('freeze')).resolves.toHaveProperty('session')
    expect(child.whenIdle).toHaveBeenCalledTimes(2)
  })
})
