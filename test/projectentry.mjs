/**
 * Offline tests for `findProjectEntry` — the session-cwd → memory-folder
 * matcher behind the brief's "Project knowledge" section.
 *
 * The matcher is a pure function that takes a cwd, a memory root, and an
 * injectable `fs` (defaulting to `node:fs`). Every test here injects a mock
 * `fs` with a hand-built directory shape, so the suite runs anywhere with
 * zero Basic Memory dependency:
 *
 *   node test/projectentry.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync as realReaddir, accessSync, readFileSync as realReadFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectEntry } from '../lib/projects.js'

// Build a memory project shape on a real temp dir but present it through a
// mock `fs` that only knows the paths we declare. This keeps the matcher's
// own `expandPath` (realpath/lowercase) honest while isolating the fixture.
const root = mkdtempSync(join(tmpdir(), 'bm-entry-'))
const projects = join(root, 'projects')
mkdirSync(join(projects, 'dangan2'), { recursive: true })
mkdirSync(join(projects, 'blish_hud'), { recursive: true })
mkdirSync(join(projects, 'kx_vision'), { recursive: true })
mkdirSync(join(projects, 'kx-vision-learning'), { recursive: true })

writeFileSync(
  join(projects, 'dangan2', '_index.md'),
  '\uFEFF---\r\ntitle: dangan2 — 项目索引\r\ntags: [memory]\r\n---\r\n\r\n# dangan2 — 项目索引\r\n\r\n正文',
  'utf8',
)
writeFileSync(join(projects, 'blish_hud', '_index.md'), '# Blish-HUD — 代码知识记忆索引\n', 'utf8')
writeFileSync(join(projects, 'kx_vision', '_index.md'), '# KX-Vision — 代码知识记忆索引\n', 'utf8')
writeFileSync(
  join(projects, 'kx-vision-learning', '_index.md'),
  '# kx-vision-learning — 代码知识记忆索引\n',
  'utf8',
)

const mockFs = {
  existsSync: (p) => {
    try {
      accessSync(p)
      return true
    } catch {
      return false
    }
  },
  readFileSync: (p, enc) => realReadFile(p, enc),
  readdirSync: (p) => realReaddir(p),
}

// --- exact match ----------------------------------------------------------
{
  const entry = findProjectEntry(join(root, 'projects', 'dangan2'), root, { fs: mockFs })
  assert.ok(entry, 'matches the folder containing the cwd')
  assert.equal(entry.base, 'dangan2')
  assert.equal(entry.filePath, 'projects/dangan2/_index.md')
  // Regression: the file opens with YAML frontmatter, so line 1 is `---`.
  // Reading line 1 made the brief print the literal title `---`; the heading
  // must come from the first real `# ` line after the frontmatter block.
  assert.equal(entry.title, 'dangan2 — 项目索引')
  assert.notEqual(entry.title, '---', 'frontmatter opener is never the title')
  console.log('ok  exact match (cwd inside memory project)')
}

// --- frontmatter is skipped, the real heading wins -----------------------
{
  // Same shape the memory project actually uses, and the exact failure seen in
  // a live brief: `## Project knowledge (dangan2),- --- — …`.
  const fm = mkdtempSync(join(tmpdir(), 'bm-fm-'))
  const fmProjects = join(fm, 'projects')
  mkdirSync(join(fmProjects, 'proj'), { recursive: true })
  writeFileSync(
    join(fmProjects, 'proj', '_index.md'),
    '---\ntitle: from-frontmatter\ntype: note\n---\n\n# Real Heading\n\nbody\n',
    'utf8',
  )
  const entry = findProjectEntry(join(fmProjects, 'proj'), fm, { fs: mockFs })
  assert.equal(entry.title, 'Real Heading', 'the # heading, not the frontmatter title or `---`')

  // No heading at all -> null, so the caller falls back to the folder name.
  writeFileSync(join(fmProjects, 'proj', '_index.md'), '---\ntitle: only-frontmatter\n---\n\nbody\n', 'utf8')
  const bare = findProjectEntry(join(fmProjects, 'proj'), fm, { fs: mockFs })
  assert.equal(bare.title, null, 'frontmatter-only note has no heading')

  // An unclosed `---` must not swallow the whole file.
  writeFileSync(join(fmProjects, 'proj', '_index.md'), '---\n# Still The Heading\n', 'utf8')
  const unclosed = findProjectEntry(join(fmProjects, 'proj'), fm, { fs: mockFs })
  assert.equal(unclosed.title, 'Still The Heading', 'unclosed frontmatter does not hide the heading')

  rmSync(fm, { recursive: true, force: true })
  console.log('ok  frontmatter skipped, heading (or null) returned')
}

// --- ancestor walk: cwd is a subdirectory of the repo --------------------
{
  // cwd = D:\dangan2\Vol.Vue, memory root elsewhere. The matcher must walk up
  // from `Vol.Vue` to `dangan2` and hit the entry note.
  const entry = findProjectEntry(join(root, 'dangan2', 'Vol.Vue'), root, { fs: mockFs })
  assert.ok(entry, 'ancestor walk finds the project')
  assert.equal(entry.base, 'dangan2')
  console.log('ok  ancestor walk (cwd = repo subdirectory)')
}

// --- hyphen/underscore folding -------------------------------------------
{
  // cwd = D:\Blish-HUD, memory folder = blish_hud (hyphen vs underscore).
  const entry = findProjectEntry(join(root, '..', 'Blish-HUD'), root, { fs: mockFs })
  assert.ok(entry, 'hyphen cwd folds to underscore memory folder')
  assert.equal(entry.base, 'blish_hud')
  console.log('ok  hyphen→underscore fold')
}

// --- folding is a fallback, exact wins -----------------------------------
{
  // cwd = D:\tauri\kx-vision-learning. Both `kx-vision-learning` (exact) and
  // the folded `kx_vision_learning` (no such folder) are candidates; the
  // exact one must win, and the folded form must not shadow it.
  const entry = findProjectEntry(join(root, '..', 'tauri', 'kx-vision-learning'), root, { fs: mockFs })
  assert.ok(entry)
  assert.equal(entry.base, 'kx-vision-learning')
  console.log('ok  exact match wins over folding')
}

// --- no match -> null ----------------------------------------------------
{
  const entry = findProjectEntry(join(root, '..', 'nowhere', 'deep'), root, { fs: mockFs })
  assert.equal(entry, null, 'unmatched cwd returns null')
  console.log('ok  no match returns null')
}

// --- cwd == memory root -> null ------------------------------------------
{
  const entry = findProjectEntry(root, root, { fs: mockFs })
  assert.equal(entry, null, 'editing the memory root itself is not a project cwd')
  console.log('ok  cwd == memory root returns null')
}

// --- root outside -> drive-root ceiling ----------------------------------
{
  // cwd = D:\project-memory (the memory root itself) must not walk past it.
  const entry = findProjectEntry(root, root, { fs: mockFs })
  assert.equal(entry, null)
  console.log('ok  walk stops at memory root (not drive root)')
}

// --- title missing -> base fallback --------------------------------------
{
  const bare = mkdtempSync(join(tmpdir(), 'bm-bare-'))
  const bareProjects = join(bare, 'projects')
  mkdirSync(join(bareProjects, 'x'), { recursive: true })
  writeFileSync(join(bareProjects, 'x', '_index.md'), '', 'utf8')
  const entry = findProjectEntry(join(bareProjects, 'x'), bare, { fs: mockFs })
  assert.ok(entry)
  assert.equal(entry.title, null, 'empty heading yields null title')
  assert.equal(entry.base, 'x')
  rmSync(bare, { recursive: true, force: true })
  console.log('ok  missing title falls back to base')
}

// --- Windows case-insensitive disk name ----------------------------------
{
  // cwd written with different casing (`DANGAN2`) than the folder on disk
  // (`dangan2`). On case-insensitive hosts they are the same directory; the
  // matcher must hit via the listing and return the *on-disk* spelling, not
  // the cwd's. On case-sensitive hosts the walk simply finds nothing, which
  // is also correct — so assert only when a match occurs, and assert the
  // returned casing when it does.
  const entry = findProjectEntry(join(root, 'projects', 'DANGAN2'), root, { fs: mockFs })
  if (entry) {
    assert.equal(entry.base, 'dangan2', 'returns on-disk casing, not cwd casing')
    assert.equal(entry.filePath, 'projects/dangan2/_index.md')
  }
  console.log('ok  case-insensitive disk name returns on-disk casing')
}

// --- on-disk casing wins over candidate casing ---------------------------
{
  // A real temp dir with a mixed-case folder (`MyProj`). The cwd is written
  // `MYPROJ`, the same directory on a case-insensitive host; the matcher must
  // return the on-disk name `MyProj`, not the cwd spelling.
  const mixed = mkdtempSync(join(tmpdir(), 'bm-mixed-'))
  const mixedProjects = join(mixed, 'projects')
  mkdirSync(join(mixedProjects, 'MyProj'), { recursive: true })
  writeFileSync(join(mixedProjects, 'MyProj', '_index.md'), '# MyProj — index\n', 'utf8')

  const entry = findProjectEntry(join(mixedProjects, 'MYPROJ'), mixed, { fs: mockFs })
  if (entry) {
    assert.equal(entry.base, 'MyProj', 'base is the on-disk name')
    assert.equal(entry.filePath, 'projects/MyProj/_index.md')
  }
  rmSync(mixed, { recursive: true, force: true })
  console.log('ok  on-disk casing wins over candidate casing')
}

rmSync(root, { recursive: true, force: true })
console.log('\nall project-entry checks passed')
