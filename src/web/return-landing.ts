/** Establish a local document before navigating with the native SameSite=Strict cookie. */
export function returnLanding(address: string): string | undefined {
  const url = new URL(address, 'http://localhost')
  const id = url.searchParams.get('sessionId')
  if (url.pathname !== '/blaxel/return' || id === null || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return undefined
  const target = `/?blaxel-return=${encodeURIComponent(id)}`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Returning to DeepSeek Harness</title><body><p>Opening your local session...</p><a href="${target}">Review your cloud changes</a><script>window.location.replace(${JSON.stringify(target)})</script></body></html>`
}
