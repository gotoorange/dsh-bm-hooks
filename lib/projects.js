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
import { resolve, dirname, basename, join } from 'node:path'
import realFs, { realpathSync } from 'node:fs'

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
 * The basenames we will accept as project-folder candidates.
 *
 * A cwd segment is treated as a *name*, never as a path, and the match is
 * validated against this set before any filesystem path is built from it —
 * so a cwd segment of `.` or `..` can never escape the memory project root,
 * and a drive root (`C:`) can never be mistaken for a folder name.
 *
 * @param {string} base - one path segment from the cwd ancestor chain.
 * @returns {boolean} whether it is a plausible project-folder name.
 */
function isSafeBase(base) {
  if (typeof base !== 'string') return false
  if (base.length === 0 || base.length > 64) return false
  if (base === '.' || base === '..') return false
  // Letters, digits, underscore, hyphen, CJK; nothing else (no separators,
  // no drive colon, no quotes). `[A-Za-z0-9_\-\u4e00-\u9fa5]` covers real
  // folder names (`dangan2`, `kx-vision-learning`, `basic-memory_记忆`,
  // `blish_hud`) while excluding everything path-shaped.
  return /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(base)
}

/**
 * Fold a cwd segment onto the memory folder's spelling convention.
 *
 * Real-world repos write hyphens (`D:\Blish-HUD`, `D:\tauri\kx-vision`),
 * memory folders write underscores (`blish_hud`, `kx_vision`). The memory
 * side is canonical, so the cwd segment is folded `-` → `_` when the exact
 * name misses. This is a *fallback* after the exact match, never before it:
 * a folder named `kx-vision-learning` must not be shadowed by folding.
 *
 * @param {string} base - a validated basename.
 * @returns {string} the folded candidate.
 */
function foldName(base) {
  return base.replace(/-/g, '_')
}

/**
 * Find the on-disk folder name that resolves to `projects/<name>/_index.md`.
 *
 * Existence is checked with `fs` against `join(root, 'projects', name, '_index.md')`.
 * The caller has already validated the name with {@link isSafeBase}, so this
 * join cannot escape the root. Any filesystem failure (missing `projects/`,
 * permission error, …) reads as "no match" — fail-open per the plugin's rule.
 *
 * Returns the *actual* folder name from the directory listing so the brief's
 * `base` and `filePath` always match the disk casing, even when the cwd
 * spelling differs (`D:\GLOF` → folder `glof`).
 *
 * @param {string} root - expanded memory project root.
 * @param {string} name - validated candidate folder name.
 * @param {object} fs - `node:fs` (or a test double).
 * @returns {string | null} the on-disk folder name, or null.
 */
function hasIndex(root, name, fs) {
  let entries
  try {
    entries = fs.readdirSync(join(root, 'projects'))
  } catch {
    return null
  }
  const lower = name.toLowerCase()
  const onDisk = entries.find((entry) => entry.toLowerCase() === lower)
  if (!onDisk) return null
  try {
    return fs.existsSync(join(root, 'projects', onDisk, '_index.md')) ? onDisk : null
  } catch {
    return null
  }
}

/**
 * Read the first `# heading` of an entry note, tolerantly.
 *
 * Every entry note in this memory project opens with a YAML frontmatter block
 * (`---`, `title: …`, `---`), so the *first line* of the file is `---`, not the
 * heading. Reading line 1 therefore produced the literal title `---`, which is
 * exactly what showed up in the brief. The frontmatter block is skipped and the
 * first real `# ` heading wins.
 *
 * A UTF-8 BOM is stripped first (these files are written by several tools), and
 * a trailing `\r` never reaches the title because lines are split on `\r?\n`.
 * Returns `null` when there is no heading, so the caller can fall back to the
 * folder name.
 *
 * @param {string} file - absolute path to the `_index.md`.
 * @param {object} fs - filesystem module.
 * @returns {string | null} the heading text, or null.
 */
function readTitle(file, fs) {
  try {
    const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)

    // Skip a leading frontmatter block: its opening `---` is line 1 and must not
    // be mistaken for the heading. An unclosed block is treated as "no
    // frontmatter" rather than swallowing the whole file.
    let start = 0
    if (lines[0]?.trim() === '---') {
      const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
      if (close !== -1) start = close + 1
    }

    for (let index = start; index < lines.length; index += 1) {
      const match = /^#\s+(.+?)\s*$/.exec(lines[index])
      if (match) {
        const title = match[1].trim()
        if (title !== '') return title
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Find the memory-project folder whose `_index.md` matches a session cwd.
 *
 * The memory project stores each real project's knowledge under
 * `projects/<folder>/_index.md` (official "one project, many folders" layout).
 * A session's cwd is the strongest signal for *which* real project is being
 * worked on, and the folder name is what connects them — not the disk
 * location, since the memory project lives elsewhere.
 *
 * Matching walks the cwd's ancestor chain (deepest first) and checks each
 * level's basename against `projects/` for an `_index.md`:
 *
 *   - exact name first, then `-` ↔ `_` folded — real repos use both spellings;
 *   - the walk stops at the memory root when the cwd is inside it, and at the
 *     drive root otherwise, so it never climbs past a meaningful boundary;
 *   - the returned folder name is the *on-disk* name (real casing), so the
 *     file path printed in the brief never disagrees with the folder on disk.
 *
 * Pure function: takes the cwd and the memory root (from `bm project list`),
 * touches only the filesystem for existence checks, and never runs the CLI.
 *
 * @param {string} cwd - the session's working directory.
 * @param {string} memoryRoot - the memory project's root (raw; expanded here).
 * @param {object} [options] - test seams.
 * @param {object} [options.fs] - filesystem module (defaults to `node:fs`).
 * @returns {{ base: string, filePath: string, title: string | null } | null}
 *   the matched folder, the relative `_index.md` path, and its `# heading` if
 *   readable — or `null` when nothing matches.
 */
export function findProjectEntry(cwd, memoryRoot, options = {}) {
  const fs = options.fs ?? realFs
  const root = expandPath(memoryRoot)
  if (!root) return null
  const child = expandPath(cwd)
  if (!child || child === root) return null

  // The upward walk must stop at a meaningful boundary. When the cwd is inside
  // the memory project (`D:/project-memory/notes`), climbing past the root
  // would start matching sibling projects by drive-relative names; when the
  // cwd is outside it (`D:/dangan2` — the common case), the drive root is the
  // only sensible ceiling. `isUnder` is exported so tests can assert both.
  const stopAt = isUnder(child, root) ? root : driveRoot(child)

  // Ancestors, deepest first; never climb past the stop point.
  const levels = []
  for (let current = child; ; ) {
    levels.push(current)
    if (current === stopAt) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const level of levels) {
    const base = basename(level)
    if (!isSafeBase(base)) continue

    // Exact first, then folded. Both are existence-checked so a folder whose
    // on-disk name has different casing still matches (Windows fs), and the
    // returned `base` is the on-disk spelling, not the cwd's.
    const exact = hasIndex(root, base, fs)
    if (exact) return { base: exact, filePath: `projects/${exact}/_index.md`, title: readTitle(join(root, 'projects', exact, '_index.md'), fs) }

    const folded = foldName(base)
    if (folded !== base && isSafeBase(folded)) {
      const diskName = hasIndex(root, folded, fs)
      if (diskName) return { base: diskName, filePath: `projects/${diskName}/_index.md`, title: readTitle(join(root, 'projects', diskName, '_index.md'), fs) }
    }
  }

  return null
}

/**
 * The drive root of a path (`C:\`, `/`), used as the walk ceiling when the
 * cwd sits outside the memory project.
 *
 * @param {string} path - an expanded absolute path.
 * @returns {string} the drive root.
 */
function driveRoot(path) {
  const parsed = resolve(path)
  const sep = parsed.includes('\\') ? '\\' : '/'
  const idx = parsed.indexOf(sep)
  return idx === -1 ? parsed : parsed.slice(0, idx + 1)
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
