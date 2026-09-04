/**
 * Build the aaw-workflow feature bundle.
 *
 * Outputs:
 *   dist/package/{manifest.json, business.js, ui.js, contract.js}
 *   dist/artifact.json                     ({manifest, files})
 *
 * ui.js is built twice (OpsCopilot pattern): the first pass collects the CSS
 * emitted by `import './ui.css'` and the Vue Flow stylesheets, `:root` is
 * rewritten to `:host` for Shadow DOM, and the second pass injects the result
 * as the UI_STYLES define.
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contributions, bundleId } from './src/contributions.js'

const root = dirname(fileURLToPath(import.meta.url))

export interface BundleArtifact {
  manifest: {
    id: string
    version: string
    hostApi: '3'
    business: string
    ui: string
    contract: string
    publisher: string
    contributions: typeof contributions
  }
  files: Record<string, string>
}

async function buildBusiness(bundleVersion: string): Promise<string> {
  const result = await build({
    entryPoints: [join(root, 'src/entry.ts')],
    bundle: true,
    write: false,
    outdir: 'dist/.esbuild',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    define: { BUNDLE_VERSION: JSON.stringify(bundleVersion) },
  })
  return result.outputFiles[0]!.text
}

async function buildUi(bundleVersion: string, styles: string): Promise<string> {
  const result = await build({
    entryPoints: [join(root, 'src/ui.ts')],
    bundle: true,
    write: false,
    outdir: 'dist/.esbuild',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    alias: { vue: 'vue/dist/vue.esm-bundler.js' },
    define: {
      BUNDLE_VERSION: JSON.stringify(bundleVersion),
      UI_STYLES: JSON.stringify(styles),
      'process.env.NODE_ENV': '"production"',
    },
  })
  return result.outputFiles.find((file) => file.path.endsWith('.js'))!.text
}

/** First pass: collect every CSS output (plugin css + Vue Flow css). */
async function collectStyles(bundleVersion: string): Promise<string> {
  const result = await build({
    entryPoints: [join(root, 'src/ui.ts')],
    bundle: true,
    write: false,
    outdir: 'dist/.esbuild',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: { vue: 'vue/dist/vue.esm-bundler.js' },
    define: {
      BUNDLE_VERSION: JSON.stringify(bundleVersion),
      UI_STYLES: '""',
      'process.env.NODE_ENV': '"production"',
    },
  })
  const css = result.outputFiles
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => file.text)
    .join('\n')
  // Rewrite for Shadow DOM injection.
  return css.replace(/:root/g, ':host')
}

export async function pack(bundleVersion: string, artifactFile = join(root, 'dist', 'artifact.json')): Promise<BundleArtifact> {
  const styles = await collectStyles(bundleVersion)
  const [business, ui] = await Promise.all([buildBusiness(bundleVersion), buildUi(bundleVersion, styles)])
  const manifest = {
    id: bundleId,
    version: bundleVersion,
    hostApi: '3' as const,
    business: 'business.js',
    ui: 'ui.js',
    contract: 'contract.js',
    publisher: 'AAW',
    contributions,
  }
  const files = {
    'business.js': business,
    'ui.js': ui,
    'contract.js': 'export const schemaVersion = 1;\n',
  }

  const packageDir = join(root, 'dist', 'package')
  await mkdir(packageDir, { recursive: true })
  await Promise.all([
    writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'),
    ...Object.entries(files).map(([name, contents]) => writeFile(join(packageDir, name), contents, 'utf8')),
  ])

  const artifact: BundleArtifact = { manifest, files }
  await mkdir(dirname(artifactFile), { recursive: true })
  await writeFile(artifactFile, JSON.stringify(artifact), 'utf8')
  return artifact
}

const invokedDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false
if (invokedDirectly) {
  const version = process.argv[2] ?? `0.1.0-dev.${Date.now()}`
  const artifact = await pack(version)
  console.log(JSON.stringify({ ok: true, version, files: Object.keys(artifact.files), manifest: artifact.manifest }))
}
