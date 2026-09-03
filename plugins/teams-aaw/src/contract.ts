/**
 * Typed contract between the aaw-workflow UI bundle and its business service.
 *
 * Call requests use the same envelope as the platform's other native bundles:
 * `{ schemaVersion: 1, requestId, operation, payload }`.  Errors are thrown as
 * `AawError` and surface through the gateway as `{ error, code }`.
 */

export const SCHEMA_VERSION = 1

export interface CallEnvelope<P = Record<string, unknown>> {
  schemaVersion: 1
  requestId: string
  operation: string
  payload: P
}

// -- workspaces -------------------------------------------------------------

export interface Workspace {
  id: string
  /** Absolute path to the repository holding `.sdd/<SR>/workflow.yaml`. */
  path: string
  /** argv prefix used to invoke the AAW CLI, e.g. `["python", "D:/.../aaw.py"]`. */
  aawCommand: string[]
  createdAt: string
}

export interface WorkspaceListResult {
  workspaces: Workspace[]
}

export interface WorkspaceAddPayload {
  path: string
  /** Optional; defaults to `["aaw"]` (CLI expected on PATH). */
  aawCommand?: string[]
}

export interface WorkspaceRemovePayload {
  id: string
}

// -- workflow instances ------------------------------------------------------

export interface SrsListPayload {
  workspaceId: string
}

export interface SrsListResult {
  srs: string[]
}

export interface SrsStatusPayload {
  workspaceId: string
  sr: string
}

export interface SrsStatusResult {
  /** The raw `aaw status --sr <SR> --json` payload (schema_version envelope). */
  status: Record<string, unknown>
}

export interface SrsStartPayload {
  workspaceId: string
  entry: string
  sr?: string
  vars?: Record<string, string>
  /** Original requirement text; written to a temp file for `--requirement-file`. */
  requirement?: string
}

export interface SrsStartResult {
  /** The raw `aaw start --json` payload. */
  started: Record<string, unknown>
}

export interface PluginStatusResult {
  ok: true
  version: string
  workspaces: number
}
