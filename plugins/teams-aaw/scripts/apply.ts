/**
 * Development apply: pack a dev version and POST it to a running iCode Teams
 * Core, mirroring demo/scripts/dev-plugin.ts.  Requires the demo stack to be
 * up (Core on 45832 by default) and ICODE_LOCAL_CREDENTIAL in the environment.
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack } from '../pack.js'

const credential = process.env.ICODE_LOCAL_CREDENTIAL
if (!credential) throw new Error('ICODE_LOCAL_CREDENTIAL is required (see demo .demo-data or DEPLOY docs)')
const coreUrl = process.env.ICODE_CORE_URL ?? 'http://127.0.0.1:45831'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const version = process.argv[2] ?? `0.1.0-dev.${Date.now()}`
const artifact = await pack(version, join(root, 'dist', `artifact-${version}.json`))
const artifactPath = join(root, 'dist', 'package')

const response = await fetch(`${coreUrl}/api/bundles/apply`, {
  method: 'POST',
  headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: artifact.manifest, artifactPath }),
})
const body = await response.text()
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, status: response.status, body }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, version, artifactPath, response: body }))
