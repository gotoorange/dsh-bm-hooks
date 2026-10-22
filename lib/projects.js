/**
 * Basic Memory project discovery for the dsh-bm-hooks plugin.
 *
 * Kept apart from `lib/index.js` so the plugin body stays exactly as it was
 * validated: this module owns only the project list, the working-directory
 * match, and the small amount of parsing they need. Nothing here imports a
 * harness-internal package — `lib/index.js` runs the CLI and passes the result
 * in, which keeps the "profile plugins resolve peers from the profile's own
 * node_modules" constraint intact.
 *
 * @module dsh-bm-hooks/projects
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * Expand a `~` prefix and canonicalize one path for comparison.
 *
 * `bm project list` reports `local_path` as the user configured it, which may
 * be `~`-relative or a symlinked location; a session cwd arrives canonical.
 * Comparing raw strings would therefore miss matches that exist, so both sides
 * go through here. A path that cannot be canonicalized (it does not exist yet)
 * falls back to a lexical resolve rather than throwing: the caller only needs a
 * comparable string.
 *
 * @param {string} value - a path from configuration, the CLI, or a session header.
 * @returns {string} a lowercase absolute path, or `''` for empty input.
 */
export function expandPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const expanded = value.startsWith('~') ? homedir() + value.slice(1) : value
  try {
    return realpathSync(expanded).toLowerCase()
  } catch {
    return resolve(expanded).toLowerCase()
  }
}

/**
 * Whether `child` is `root` or lives beneath it.
 *
 * Separator-aware on purpose: a plain `startsWith` would treat `/work/ab` as
 * living under `/work/a`.
 *
 * @param {string} child - expanded candidate path.
 * @param {string} root - expanded project root.
 * @returns {boolean} true when the child is inside the root.
 */
function isUnder(child, root) {
  if (child === root) return true
  if (!child.startsWith(root)) return false
  const next = child.charAt(root.length)
  return next === '\\' || next === '/'
}

/**
 * Normalize `bm project list --json` into the shape the plugin and the client
 * both use.
 *
 * The CLI has shipped more than one envelope over its life (`{ projects: [...] }`,
 * a bare array, and `{ results: [...] }`), so accept all three. Field names are
 * normalized too: the CLI writes `local_path` and `is_default`, while an older
 * shape used `path`. Unknown extra keys are dropped so nothing machine-specific
 * reaches the client.
 *
 * @param {unknown} parsed - the parsed JSON output of `bm project list --json`.
 * @returns {Array<{ name: string, localPath: string, isDefault: boolean }>} normalized rows.
 */
export function normalizeProjects(parsed) {
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.projects)
      ? parsed.projects
      : Array.isArray(parsed?.results)
        ? parsed.results
        : []

  const projects = []
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : ''
    if (!name) continue
    const localPath =
      typeof row?.local_path === 'string'
        ? row.local_path
        : typeof row?.localPath === 'string'
          ? row.localPath
          : typeof row?.path === 'string'
            ? row.path
            : ''
    projects.push({
      name,
      localPath,
      isDefault: row?.is_default === true || row?.isDefault === true,
    })
  }
  return projects
}

/**
 * Pick the project whose root contains `cwd`, by longest prefix.
 *
 * Longest-prefix matters when projects nest: a session inside
 * `D:/project-memory/notes` must resolve to that project even when a project
 * rooted at `D:/` exists, because the most specific root is the intended one.
 *
 * @param {string} cwd - the session's working directory.
 * @param {Array<{ name: string, localPath: string }>} projects - normalized projects.
 * @returns {string | undefined} the matching project name, if any.
 */
export function matchProject(cwd, projects) {
  const child = expandPath(cwd)
  if (!child) return undefined

  let best
  for (const project of projects ?? []) {
    const root = expandPath(project?.localPath)
    if (!root) continue
    if (!isUnder(child, root)) continue
    if (best === undefined || root.length > best.root.length) {
      best = { name: project.name, root }
    }
  }
  return best?.name
}

/**
 * Resolve the project a session should use.
 *
 * Priority, most specific first:
 *   1. an explicit per-session switch (`/bm-project` or the `bm_set_project` tool),
 *   2. a project whose root contains the session's cwd,
 *   3. the configured `project`,
 *   4. Basic Memory's own `default_project`.
 *
 * The cwd match deliberately outranks the configured value: a user who keeps one
 * profile across several repositories expects the session to follow the
 * repository it is in. `fallback` is the last resort so a workspace directory
 * that sits under no project still gets a brief instead of silence.
 *
 * @param {object} input - the candidates, highest priority first.
 * @param {string | undefined} input.sessionProject - explicit per-session choice.
 * @param {string} [input.cwd] - the session working directory.
 * @param {Array<object>} [input.projects] - normalized projects.
 * @param {string} [input.configured] - the `project` config value.
 * @param {string} [input.fallback] - bm's `default_project`.
 * @returns {{ project: string, source: 'session' | 'cwd' | 'config' | 'default' | 'none' }} the choice and why.
 */
export function resolveProject({ sessionProject, cwd, projects, configured, fallback }) {
  const explicit = typeof sessionProject === 'string' ? sessionProject.trim() : ''
  if (explicit) return { project: explicit, source: 'session' }

  const matched = matchProject(cwd, projects)
  if (matched) return { project: matched, source: 'cwd' }

  const config = typeof configured === 'string' ? configured.trim() : ''
  if (config) return { project: config, source: 'config' }

  const dflt = typeof fallback === 'string' ? fallback.trim() : ''
  if (dflt) return { project: dflt, source: 'default' }

  return { project: '', source: 'none' }
}
