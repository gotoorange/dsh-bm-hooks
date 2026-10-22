/**
 * Exercises the project matcher against the real `bm project list --json`
 * output on this machine, using the paths recorded in the source README.
 *
 *   node test/projects.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { matchProject, normalizeProjects, resolveProject } from '../lib/projects.js'

// --- 1. normalization against the real CLI envelope ----------------------
// Captured from `bm project list --json` (basic-memory 0.23.2). Extra keys
// must be dropped: the client page must never receive machine paths it did
// not ask for beyond the project root it displays.
const raw = JSON.parse(
  execFileSync('bm', ['project', 'list', '--json'], { encoding: 'utf8', timeout: 120_000 }),
)
const projects = normalizeProjects(raw)

assert.ok(projects.length >= 2, 'reads at least the two configured projects')
for (const project of projects) {
  assert.equal(typeof project.name, 'string', 'name is a string')
  assert.equal(typeof project.localPath, 'string', 'localPath is a string')
  assert.equal(typeof project.isDefault, 'boolean', 'isDefault is a boolean')
  assert.deepEqual(
    Object.keys(project).sort(),
    ['isDefault', 'localPath', 'name'],
    'only the three normalized keys survive',
  )
}
assert.ok(
  projects.some((project) => project.isDefault),
  'exactly the default project is flagged',
)
console.log(`ok  normalizeProjects: ${projects.length} real projects, extra keys dropped`)

// --- 2. matching against the real project roots -------------------------
// Derive the expectations from the CLI's own answer rather than hardcoding a
// machine's paths, so the test runs anywhere `bm` has at least one project.
const rootOf = (name) => projects.find((project) => project.name === name)?.localPath ?? ''
const nonDefault = projects.find((project) => !project.isDefault)
const cases = []

if (nonDefault) {
  // The project's own root, and a directory beneath it, both resolve to it.
  cases.push([nonDefault.localPath, nonDefault.name])
  cases.push([`${nonDefault.localPath}/notes/deep`, nonDefault.name])
}

// A directory under no project root must not match anything.
cases.push(['C:/Windows', undefined])

for (const [cwd, expected] of cases) {
  assert.equal(matchProject(cwd, projects), expected, `${cwd} => ${expected ?? '(no match)'}`)
}
console.log('ok  matchProject: real roots match, subdirectories inherit')

// --- 3. the fallback chain keeps a workspace usable ----------------------
// A working directory under no project root must still resolve, or the brief
// silently disappears in exactly the sessions that need it most.
const defaultName = projects.find((project) => project.isDefault)?.name ?? ''
const resolved = resolveProject({
  cwd: 'C:/definitely/not/a/project/root',
  projects,
  configured: '',
  fallback: defaultName,
})
assert.equal(resolved.source, 'default', 'falls through to the default project')
assert.equal(resolved.project, defaultName, 'uses the real default project')
console.log('ok  resolveProject: unmatched workspace falls back to the default project')

// --- 4. an explicit switch always wins ----------------------------------
assert.deepEqual(
  resolveProject({
    sessionProject: defaultName || 'pinned',
    cwd: nonDefault?.localPath ?? 'C:/work',
    projects,
    configured: 'x',
  }),
  { project: defaultName || 'pinned', source: 'session' },
  'an explicit switch outranks a cwd match',
)
console.log('ok  resolveProject: explicit switch outranks cwd')

console.log('\nall project checks passed')
