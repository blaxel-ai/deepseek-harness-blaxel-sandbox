import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'
import { startDshWeb, type DshWeb } from './dsh-web.js'

let host: DshWeb
const consoleErrors: string[] = []

test.beforeAll(async () => {
  host = await startDshWeb()
})

test.afterAll(async () => {
  await host.stop()
})

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto(host.url)
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await dismissFirstRunDialogs(page)
})

/** A fresh profile greets with the testing notice and an API-key prompt; both block clicks. */
async function dismissFirstRunDialogs(page: Page): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const dialog = page.getByRole('dialog')
    if (await dialog.count() === 0) return
    const dismiss = dialog.getByRole('button', { name: /^(Continue|Configure later)$/ })
    if (await dismiss.count() === 0) return
    await dismiss.first().click()
    await expect(dialog).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined)
  }
}

/** Selects an existing session row or starts a blank one, so session-scoped slots mount. */
async function openAnySession(page: Page): Promise<void> {
  const rows = page.getByRole('treeitem').filter({ hasNot: page.locator('[aria-expanded]') })
  const sessionRow = rows.filter({ hasNotText: /^$/ }).first()
  if (await sessionRow.count() > 0 && await sessionRow.getAttribute('aria-expanded') === null) {
    await sessionRow.click()
  } else {
    await page.getByRole('button', { name: 'New session' }).first().click()
  }
}

test('every Blaxel slot entry mounts without crashing the DSH slot boundary', async ({ page }) => {
  await openAnySession(page)
  await expect(page.getByRole('button', { name: /Blaxel/ }).first()).toBeVisible()
  await expect(page.locator('[data-slot-error]')).toHaveCount(0)
  expect(consoleErrors.filter(text => /slot entry crashed|Blaxel/i.test(text))).toEqual([])
})

test('a session offers one-click sandboxing or shows its live sandbox state', async ({ page }) => {
  await openAnySession(page)
  const action = page.getByRole('button', { name: /Move this session to Blaxel|Open current Git repository on Blaxel/ })
  const chip = page.locator('[data-blaxel-sandbox-chip]')
  await expect(action.or(chip).first()).toBeVisible()
  if (await chip.count() === 0) {
    // Local session: exactly one entry point into Blaxel, and no sandbox banner competing with it.
    await expect(action).toHaveCount(1)
    await expect(page.locator('[data-blaxel-sandbox-surface]')).toHaveCount(0)
    return
  }
  // Sandboxed session: the chip and the banner must agree on the connection state.
  const state = await chip.getAttribute('data-blaxel-sandbox-chip')
  await expect(chip).toHaveText(/On Blaxel|Reconnect Blaxel|Connecting/)
  const banner = page.locator('[data-blaxel-sandbox-surface] [data-state]')
  await expect(banner).toHaveAttribute('data-state', state ?? '')
})

test('Settings exposes the Blaxel section', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Blaxel', { exact: true }).first()).toBeVisible()
})
