import { mkdir, writeFile } from 'node:fs/promises'
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
