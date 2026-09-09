import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientId = '@blaxel/dsh-sandbox'
const result = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['react', 'react/jsx-runtime', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const body = result.outputFiles[0].text.trim()
const output = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(clientId)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')
await mkdir(join(root, 'dist'), { recursive: true })
await writeFile(join(root, 'dist/client.cjs'), output)
console.log(`client bundle: dist/client.cjs (${String(Buffer.byteLength(output))} bytes)`)

// DSH discovers browser modules from active host rows. These client-only companions
// preserve its exact pinned browser packages while our adapters own the host services.
const require = createRequire(import.meta.url)
for (const [directory, name] of [['gateway', '@deepseek-ai/dsh-api-gateway'], ['connection', '@deepseek-ai/dsh-client-connection']]) {
  const manifestPath = require.resolve(`${name}/package.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const destination = join(root, 'dist/native-client', directory)
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'package.json'), JSON.stringify({ name, version: manifest.version, type: 'module', exports: { './client': './client.js' }, dsh: manifest.dsh }))
  await writeFile(join(destination, 'index.js'), 'export function apply() {}\n')
  await cp(join(dirname(manifestPath), 'lib/client.js'), join(destination, 'client.js'))
  await cp(join(dirname(manifestPath), 'LICENSE'), join(destination, 'LICENSE'))
}
