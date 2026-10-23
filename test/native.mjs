/**
 * Offline test for the native dsh-bm-hooks plugin.
 *
 * Loads the real `lib/index.js`, stubs the only peer module it imports
 * (`@deepseek-ai/schemastery`), and drives the plugin through a fake Cordis
 * context that records listener registrations and raises events the way the
 * harness does.
 *
 *   node test/native.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Anchor every path to this file, not to the caller's working directory: the
// suite must behave the same under `node test/native.mjs`, `npm test`, and CI.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginPath = join(packageRoot, 'lib', 'index.js')
const source = readFileSync(pluginPath, 'utf8')

// --- stub the one bare import ---------------------------------------------
const stubDir = mkdtempSync(join(tmpdir(), 'dsh-bm-hooks-stub-'))

// A minimal schemastery stand-in. Each `z.<type>()` returns a descriptor whose
// `.default(v)` records the default and returns itself, and whose `.volatile()`
// marks the field as a live reference. `parse` mirrors the real behavior: a
// volatile field resolves to an object with `.get()`, a plain field to its raw
// value — the exact distinction the plugin must honor.
writeFileSync(
  join(stubDir, 'schemastery.mjs'),
  `const field = () => {
     const descriptor = {
       value: undefined,
       isVolatile: false,
       default(v) {
         descriptor.value = v
         return descriptor
       },
       volatile() {
         descriptor.isVolatile = true
         return descriptor
       },
     }
     return descriptor
   }
   /** A resolved volatile reference, like cosmokit's createVolatile result. */
   const ref = (initial) => {
     let current = initial
     return {
       get: () => current,
       set: (next) => { current = next },
     }
   }
   const z = {
     boolean: field,
     string: field,
     number: field,
     array: field,
     object: (shape) => ({
       shape,
       parse(input = {}) {
         const out = {}
         for (const [key, descriptor] of Object.entries(shape)) {
           const hasDefault = descriptor && 'value' in descriptor && descriptor.value !== undefined
           const raw = key in input ? input[key] : hasDefault ? descriptor.value : undefined
           out[key] = descriptor?.isVolatile ? ref(raw) : raw
         }
         return out
       },
     }),
   }
   export default z
  `,
  'utf8',
)

// The plugin's own relative modules are copied beside the rewritten entry so
// `./projects.js` resolves in the sandbox exactly as it does in the package.
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
for (const file of readdirSync(join(packageRoot, 'lib'))) {
  if (file === 'index.js' || !file.endsWith('.js')) continue
  copyFileSync(join(packageRoot, 'lib', file), join(stubDir, file))
}

const patched = source
  .replace(/from '@deepseek-ai\/schemastery'/, `from '${pathToFileURL(join(stubDir, 'schemastery.mjs')).href}'`)

// Redirect writes into a sandbox: nothing in the plugin should touch the real
// user profile, but a stray homedir() call must not reach it either.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-bm-hooks-home-'))
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome

// A lifecycle hook is a command boundary: the plugin must reach Basic Memory by
// spawning `bm`, never by calling an MCP tool. Guard both the tool-call API and
// any MCP tool name, so a future edit cannot quietly reintroduce the coupling.
assert.ok(!/\.tool\.call\s*\(/.test(source), 'plugin must not call $.tool.call')
assert.ok(!/mcp__/.test(source), 'plugin must not reference an MCP tool name')
assert.ok(!/tool:\s*['"]mcp/.test(source), 'plugin must not route through MCP tools')

// The plugin must not import any harness-internal package: a profile plugin
// resolves its peers from the profile's own node_modules, and packages like
// `@deepseek-ai/dsh-llm` live in the app archive instead, so importing one
// makes the plugin fail to load. Guard against that regression here.
const internal = [...source.matchAll(/from '(@deepseek-ai\/[^']+)'/g)].map((m) => m[1])
const allowed = new Set(['@deepseek-ai/schemastery'])
for (const spec of internal) {
  assert.ok(allowed.has(spec), `unexpected harness-internal import: ${spec}`)
}

const patchedPath = join(stubDir, 'under-test.mjs')
writeFileSync(patchedPath, patched, 'utf8')
const plugin = await import(pathToFileURL(patchedPath).href)
// The pure helpers are imported from the package itself: they have no harness
// dependency, so there is nothing to stub.
const { expandPath, matchProject, resolveProject } = await import(
  pathToFileURL(join(packageRoot, 'lib', 'projects.js')).href
)

// --- a fake harness -------------------------------------------------------
/**
 * Default CLI answer: `search-notes --json` returns one row per section, so the
 * brief builder has real data to render. Any other subcommand gets empty output.
 */
const defaultRun = (argv) => {
  if (argv.includes('search-notes')) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        results: [{ title: 'Refactor auth', permalink: 'notes/refactor-auth', file_path: 'notes/refactor-auth.md' }],
      }),
      stderr: '',
    }
  }
  return { exitCode: 0, stdout: '', stderr: '' }
}

function makeHarness({ config = {}, bm = {}, services = {}, webServer = false, tools: toolsEnabled = true } = {}) {
  const listeners = new Map()
  const commands = []
  const tools = []
  const routes = []
  const spawns = []
  const logs = []

  const resolve = bm.resolve ?? (() => 'C:/fake/bm.exe')
  const run = bm.run ?? defaultRun

  // The tool registry is optional in a composition, and its absence must not
  // break anything else the plugin registers.
  const toolsService = toolsEnabled
    ? {
        register: (definition) => {
          tools.push(definition)
          return () => {}
        },
      }
    : undefined

  // Only present when a case asks for it, mirroring a composition without the
  // Web carrier: the plugin must still load and work there.
  const webServerService = webServer
    ? {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      }
    : undefined

  const ctx = {
    logger: {
      info: (line) => logs.push({ level: 'info', line }),
      warn: (line) => logs.push({ level: 'warn', line }),
      error: (line) => logs.push({ level: 'error', line }),
    },
    subprocess: {
      resolveExecutable: async (command) => resolve(command),
      spawn: (spec) => {
        spawns.push(spec)
        const outcome = run(spec.argv)
        const reader = (text) => ({
          readFrom: (from) => ({
            text: String(text).slice(from),
            nextOffset: String(text).length,
            lossy: false,
          }),
        })
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          control: undefined,
          collected: {
            stdout: reader(outcome.stdout ?? ''),
            stderr: reader(outcome.stderr ?? ''),
          },
          done: Promise.resolve({ exitCode: outcome.exitCode ?? 0, signal: null }),
          terminate: () => {},
          waitForExit: async () => true,
        }
      },
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => {}
      },
    },
    // The model-facing `bm_set_project` tool. Cordis' real registry validates
    // the definition; here we only record it so a case can execute it.
    tools: toolsService
      ? {
          register: (definition) => {
            tools.push(definition)
            return () => {}
          },
        }
      : undefined,
    on: (event, handler, options) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ handler, options })
      return () => {}
    },
    effect: (factory) => {
      factory()
      return () => {}
    },
    // Optional-service injection, matching Cordis' `ctx.inject([...], cb)`:
    // the callback runs with a child context that carries the service. Each
    // optional service the plugin asks for gets its own child, because a real
    // Cordis child context carries exactly the services named in the call.
    inject: (services, callback) => {
      const child = {
        effect: (factory) => {
          factory()
          return () => {}
        },
      }
      if (services.includes('settings')) {
        callback({ ...child, settings: { configure: () => () => {} } })
      }
      if (services.includes('tools') && toolsService) {
        callback({ ...child, tools: toolsService })
      }
      if (services.includes('webServer') && webServerService) {
        callback({ ...child, webServer: webServerService })
      }
      return () => {}
    },
    // Service lookup used by `/bm-project` to reach the config editor. Cordis'
    // `ctx.get(name)` returns undefined for an uncomposed service, so mirror that.
    get: (name) => (name in services ? services[name] : undefined),
    fiber: { entry: { id: 'bm-hooks', name: 'dsh-bm-hooks' } },
  }

  plugin.apply(ctx, plugin.Config.parse(config))

  /**
   * Raise one event the way Cordis does: registered handlers run in order, and
   * a waterfall handler receives `(payload, next)` while an observer receives
   * `(payload)` only. `terminal` supplies the engine behaviour at the bottom.
   */
  const raise = async (event, payload, terminal = () => ({ kind: 'enter', messages: [] })) => {
    const entries = listeners.get(event) ?? []
    assert.ok(entries.length > 0, `no listener registered for ${event}`)
    let index = 0
    const next = async () => {
      const entry = entries[index++]
      if (!entry) return terminal(payload)
      return entry.handler(payload, next)
    }
    return next()
  }

  /** Raise an observer-only event (no `next` argument). */
  const emit = (event, ...args) => {
    const entries = listeners.get(event) ?? []
    assert.ok(entries.length > 0, `no listener registered for ${event}`)
    for (const entry of entries) entry.handler(...args)
  }

  return { ctx, listeners, commands, tools, routes, spawns, logs, raise, emit }
}

/** One fake Session with a header and a derived history. */
function makeSession({ id = 'sess-1', cwd = 'C:/workspace', origin, messages = [] } = {}) {
  return {
    id,
    header: { id, cwd, ...(origin ? { origin } : {}) },
    deriveMessages: () => messages,
  }
}

/**
 * One derived *human* turn: `user` role with `source.kind === 'user'`.
 *
 * `buildCheckpoint` distinguishes human turns from injected context by the
 * source kind — `agent-loop` writes every `agent/pre-step` injection as a
 * `user`-role message too, so role alone would count this plugin's own brief
 * as the user's words. Fixtures must therefore carry the source explicitly,
 * or they would silently stop exercising the checkpoint at all.
 */
const humanTurn = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** One derived *injected context* message: `user` role, plugin source. */
const injectedTurn = (text, kind = 'bm-hooks') => ({
  role: 'user',
  source: { kind, form: 'snapshot', sections: [{ name: kind, text }] },
  content: [{ type: 'text', text }],
})

const makeAgent = (session) => ({ id: session.id, session })
const settle = () => new Promise((resolve) => setImmediate(resolve))

// --- 1. plugin shape ------------------------------------------------------
assert.equal(plugin.name, 'bm-hooks', 'plugin name')
assert.deepEqual(plugin.inject, ['commands', 'subprocess'], 'declares its service dependencies')
assert.equal(typeof plugin.apply, 'function', 'exports apply')
assert.equal(typeof plugin.Config.parse, 'function', 'exports Config')
console.log('ok  shape: name / inject / apply / Config')

// --- 2. config defaults ---------------------------------------------------
// The defaults must not encode any machine: no absolute path, no pinned
// version, no project name, no capture folder.
const defaults = plugin.Config.parse({})
/** Read a config field whether it is volatile (a ref) or plain. */
const read = (cfg, key) => (cfg[key] && typeof cfg[key].get === 'function' ? cfg[key].get() : cfg[key])

assert.equal(defaults.enabled, true)
assert.deepEqual(defaults.bmArgv, ['bm'], 'bare name, resolved through PATH')
assert.equal(defaults.harness, 'codex')
assert.equal(read(defaults, 'project'), '', 'no project name hardcoded')
assert.equal(defaults.captureFolder, 'sessions', "bm Claude profile's default_capture_folder")
assert.equal(defaults.projectDir, '', 'no project dir hardcoded')
// The full Claude-profile five-piece: adopting bm's profile means the type,
// title prefix, tags and session-id key all match `Harness.claude` exactly, so
// bm's own `hook session-start` sees these checkpoints as first-class.
assert.equal(defaults.noteType, 'session', "bm Claude profile's session_note_type")
assert.equal(defaults.titlePrefix, 'Session', "bm Claude profile's checkpoint_title_prefix")
assert.equal(defaults.sessionIdKey, 'claude_session_id', "bm Claude profile's session_id_key")
assert.equal(defaults.injectBrief, true)
assert.equal(defaults.checkpointOnCompact, true)
assert.equal(defaults.flushIntervalHours, 24)
assert.equal(defaults.flushRetentionDays, 30)
// No default value may look like a filesystem path or a version pin.
for (const [key, raw] of Object.entries(defaults)) {
  const current = read(defaults, key)
  if (typeof current === 'string') {
    assert.ok(!/[A-Za-z]:[\\/]/.test(current), `no drive-letter path in defaults: ${key}=${current}`)
    assert.ok(!/@\d/.test(current), `no pinned version in defaults: ${key}=${current}`)
  }
}
// The user-facing preferences must be volatile so the Settings form shows them.
assert.equal(typeof defaults.project.get, 'function', 'project is a live reference (volatile)')
assert.equal(typeof defaults.recallTimeframe.get, 'function', 'recallTimeframe is volatile')
assert.equal(typeof defaults.briefLimit.get, 'function', 'briefLimit is volatile')
// `briefNote` is a user preference like the rest, so it is volatile and empty by
// default: an empty note must leave the brief exactly as it was before the field
// existed.
assert.equal(typeof defaults.briefNote.get, 'function', 'briefNote is volatile')
assert.equal(read(defaults, 'briefNote'), '', 'briefNote is empty by default')
console.log('ok  config: defaults carry no path, version, or project; preferences are volatile')

// --- 3. disabled plugin registers nothing --------------------------------
{
  const h = makeHarness({ config: { enabled: false } })
  assert.equal(h.listeners.size, 0, 'no listeners when disabled')
  assert.equal(h.commands.length, 0, 'no commands when disabled')
  console.log('ok  enabled=false: no registration')
}

// --- 4. agent/created queries the graph for the brief -------------------
// The brief is built from `bm tool search-notes --project ...`, not from
// `bm hook session-start`, because the hook verb reads its recall target only
// from a harness settings file this plugin does not use. `projectKnowledge` is
// off here so this case keeps asserting exactly the three recall queries; the
// extra project-list query the knowledge section adds is covered separately.
{
  const session = makeSession()
  const h = makeHarness({ config: { project: 'project-memory', projectKnowledge: false } })
  h.emit('agent/created', { agent: makeAgent(session), source: 'startup' })
  await settle()
  await settle()
  assert.equal(h.spawns.length, 3, 'one query per brief section')
  for (const spawn of h.spawns) {
    assert.ok(spawn.argv.includes('tool'), 'runs a bm tool subcommand')
    assert.ok(spawn.argv.includes('search-notes'), 'search-notes')
    assert.ok(spawn.argv.includes('--project'), 'passes --project explicitly')
    assert.equal(spawn.argv[spawn.argv.indexOf('--project') + 1], 'project-memory', 'project value')
    assert.ok(spawn.argv.includes('--json'), 'asks for JSON')
    assert.equal(spawn.cwd, 'C:/workspace', 'cwd from the session header')
    assert.equal(spawn.stdio.stdin, 'ignore', 'explicit stdin disposition')
    assert.ok(spawn.graceMs > 0, 'explicit grace')
  }
  const filters = h.spawns.map((s) => s.argv.join(' '))
  assert.ok(filters.some((f) => f.includes('task') && f.includes('active')), 'queries active tasks')
  assert.ok(filters.some((f) => f.includes('decision') && f.includes('open')), 'queries open decisions')
  // Two spellings must be recalled. `session` is what this plugin writes and
  // what bm's Claude profile recalls, so these checkpoints stay visible to bm's
  // own `hook session-start`. `codex_session` keeps a co-installed bm Codex
  // profile visible. `--type` is repeatable and ORs, so both cost one query.
  const sessionQuery = h.spawns.find((s) => s.argv.includes('session'))
  assert.ok(sessionQuery, 'queries recent sessions')
  const types = sessionQuery.argv.filter((a, i) => i > 0 && sessionQuery.argv[i - 1] === '--type')
  assert.deepEqual(types, ['session', 'codex_session'], 'recalls both profile spellings')
  assert.ok(sessionQuery.argv.includes('7d'), 'uses the configured recall window')
  console.log('ok  agent/created: queries the graph for the brief')
}

// --- 4b. no project means no brief queries -----------------------------
{
  const session = makeSession()
  const h = makeHarness({ config: { project: '' } })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  await settle()
  assert.equal(h.spawns.length, 0, 'no queries without a project')
  console.log('ok  agent/created: no project, no brief')
}

// --- 4c. project knowledge adds one list query and a knowledge section ---
// The knowledge section matches the session cwd against a memory-project
// folder. It costs exactly one extra `bm project list --json` (the resolver
// cache is cold because autoDetectProject is off), then pure filesystem work.
{
  const memRoot = mkdtempSync(join(tmpdir(), 'bm-native-mem-'))
  mkdirSync(join(memRoot, 'projects', 'dangan2'), { recursive: true })
  writeFileSync(join(memRoot, 'projects', 'dangan2', '_index.md'), '# dangan2 — 项目索引\n', 'utf8')

  const run = (argv) => {
    if (argv.includes('project') && argv.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          projects: [
            { name: 'project-memory', local_path: memRoot, is_default: true },
            { name: 'main', local_path: join(tmpdir(), 'bm-native-main'), is_default: false },
          ],
        }),
        stderr: '',
      }
    }
    if (argv.includes('search-notes')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          results: [{ title: 'Refactor auth', permalink: 'notes/refactor-auth', file_path: 'notes/refactor-auth.md' }],
        }),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  // The session cwd is the repo itself; the memory root is elsewhere. The
  // knowledge section must match `dangan2` via the ancestor walk and surface
  // the entry note before the three recall sections.
  const session = makeSession({ cwd: 'C:/repos/dangan2' })
  const h = makeHarness({ config: { project: 'project-memory' }, bm: { run } })
  h.emit('agent/created', { agent: makeAgent(session), source: 'startup' })
  await settle()
  await settle()

  const listSpawns = h.spawns.filter((s) => s.argv.includes('list'))
  assert.equal(listSpawns.length, 1, 'one project-list query for the knowledge section')
  const searchSpawns = h.spawns.filter((s) => s.argv.includes('search-notes'))
  assert.equal(searchSpawns.length, 3, 'the three recall queries still run')
  assert.equal(h.spawns.length, 4, 'list + three recall queries')

  // Deliver the brief and assert the knowledge section is present and first.
  const signal = new AbortController().signal
  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const text = decision.messages[0]?.content?.[0]?.text ?? ''
  assert.match(text, /Project knowledge \(dangan2\)/, 'knowledge section present')
  assert.match(text, /dangan2 — 项目索引/, 'entry title surfaced')
  assert.match(text, /Read this entry note/, 'explicit read instruction')
  assert.ok(text.indexOf('Project knowledge') < text.indexOf('Active tasks'), 'knowledge section precedes recall')
  // Regression: the knowledge lines were pushed as a nested array, so the
  // section's own lines got joined with commas and printed on one line:
  //   `## Project knowledge (dangan2),- title — path,  Read this …`
  // Each line must stand alone.
  assert.ok(
    !/## Project knowledge \([^)]*\),/.test(text),
    'the knowledge heading is not comma-joined to the next line',
  )
  assert.match(
    text,
    /## Project knowledge \(dangan2\)\n- dangan2 — 项目索引 — projects\/dangan2\/_index\.md\n {2}Read this entry note/,
    'the three knowledge lines are separate, newline-terminated lines',
  )
  console.log('ok  project knowledge: one list query + entry section first')

  rmSync(memRoot, { recursive: true, force: true })
}

// --- 5. subagent sessions are ignored ------------------------------------
{
  const session = makeSession({ id: 'child', origin: 'subagent' })
  const h = makeHarness()
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  assert.equal(h.spawns.length, 0, 'subagent sessions get no brief')
  console.log('ok  agent/created: subagent sessions skipped')
}

// --- 6. pre-step delivers the brief once, with a source label ------------
{
  const session = makeSession()
  const h = makeHarness({ config: { project: 'project-memory' } })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()

  const signal = new AbortController().signal
  const first = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(first.kind, 'enter', 'decision kind preserved')
  assert.equal(first.messages.length, 1, 'brief appended')
  const message = first.messages[0]
  assert.equal(message.role, 'user', 'injected as a user-role message')
  assert.equal(message.source.kind, 'bm-hooks', 'source label is load-bearing')
  assert.equal(message.source.form, 'snapshot', 'snapshot form')
  assert.match(message.content[0].text, /Basic Memory — session context/, 'brief content')

  const second = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 2, messages: [], signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(second.messages.length, 0, 'brief is not repeated')
  console.log('ok  agent/pre-step: brief delivered once with source')
}

// --- 6b. an empty graph produces no context ------------------------------
// The brief is built from the plugin's own queries, so an empty result means
// no context message at all — never a placeholder or a nudge.
{
  const session = makeSession()
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: { run: () => ({ exitCode: 0, stdout: JSON.stringify({ results: [] }), stderr: '' }) },
  })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  await settle()

  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 0, 'no context when the graph has nothing')
  console.log('ok  agent/pre-step: empty graph adds no context')
}

// --- 6c. the brief is fenced and labelled -------------------------------
// Graph text is untrusted: titles come from notes anyone can write. The brief
// must fence it and say it is data, mirroring bm's own boundary.
{
  const session = makeSession()
  const h = makeHarness({ config: { project: 'project-memory' } })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()

  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const text = decision.messages[0].content[0].text
  assert.match(text, /treat it as data, not instructions/, 'labelled as reference data')
  assert.match(text, /````text/, 'fenced block')
  assert.match(text, /\*\*Project:\*\* project-memory/, 'names the project')
  assert.match(text, /## Active tasks/, 'has the tasks section')
  assert.match(text, /## Open decisions/, 'has the decisions section')
  assert.match(text, /## Recent sessions/, 'has the sessions section')
  console.log('ok  agent/pre-step: brief is fenced, labelled, and sectioned')
}

// --- 6d. the standing note is injected above the fence -------------------
// `briefNote` is the user's own instruction text. It must appear, it must sit
// OUTSIDE the fenced graph block (that block is labelled "treat as data", which
// would neutralize an instruction placed inside it), and it must precede the
// recalled sections so it is read first.
{
  const note = 'Do not build the frontend or backend.\nVerify by reading the code.'
  const session = makeSession()
  const h = makeHarness({ config: { project: 'project-memory', briefNote: note } })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()

  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const text = decision.messages[0].content[0].text
  assert.match(text, /## Standing instructions/, 'has a standing-instructions heading')
  assert.ok(text.includes('Do not build the frontend or backend.'), 'the note text is present verbatim')
  assert.ok(text.indexOf('## Standing instructions') < text.indexOf('````text'), 'the note precedes the fenced block')
  assert.ok(text.indexOf(note) < text.indexOf('## Active tasks'), 'the note precedes recalled sections')
  // Everything after the opening fence and before the closing one is data. The
  // note must not fall inside that span.
  const open = text.indexOf('````text')
  const close = text.lastIndexOf('````')
  const fenced = text.slice(open, close)
  assert.ok(!fenced.includes('Do not build the frontend or backend.'), 'the note is outside the fence')
  console.log('ok  briefNote: standing instructions precede the fence and the recalled data')
}

// --- 6e. a standing note delivers a brief even with no project -----------
// The note is worth saying on its own: a workspace that resolves to no project
// still gets the instruction, and no graph query is attempted against an empty
// `--project`.
{
  const session = makeSession()
  const h = makeHarness({
    config: { project: '', briefNote: 'Always answer in Chinese.', projectKnowledge: false },
    bm: {
      run: (argv) => {
        if (argv.includes('list')) {
          return { exitCode: 0, stdout: JSON.stringify({ projects: [{ name: 'main', local_path: 'C:/m', is_default: false }] }), stderr: '' }
        }
        return { exitCode: 0, stdout: JSON.stringify({ results: [] }), stderr: '' }
      },
    },
  })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  await settle()

  assert.equal(h.spawns.filter((s) => s.argv.includes('search-notes')).length, 0, 'no query without a project')

  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const text = decision.messages[0]?.content?.[0]?.text ?? ''
  assert.match(text, /Always answer in Chinese\./, 'the note still delivers')
  assert.ok(!text.includes('````text'), 'no empty fenced block is emitted')
  assert.ok(!text.includes('**Project:**'), 'no project line without a graph block')
  console.log('ok  briefNote: delivers alone when no project resolves')
}

// --- 6f. an empty standing note changes nothing --------------------------
// Regression guard: with `briefNote` empty the brief must be byte-identical to
// the pre-existing shape — no heading, no stray blank line, still one fence.
{
  const session = makeSession()
  const h = makeHarness({ config: { project: 'project-memory', briefNote: '' } })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()

  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const text = decision.messages[0].content[0].text
  assert.ok(!text.includes('## Standing instructions'), 'no heading for an empty note')
  assert.equal(text.match(/````text/g).length, 1, 'exactly one fenced block')
  assert.ok(text.startsWith('# Basic Memory — session context\n'), 'unchanged opening')
  console.log('ok  briefNote: empty note leaves the brief untouched')
}

// --- 7. pre-step never overrides a rejection -----------------------------
{
  const session = makeSession()
  const h = makeHarness()
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  const rejected = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'reject' }),
  )
  assert.equal(rejected.kind, 'reject', 'a rejection is never turned into a message list')
  console.log('ok  agent/pre-step: rejection respected')
}

// --- 8. compaction/start writes a checkpoint (the real PreCompact) -------
{
  const messages = [
    humanTurn('Refactor the auth module to use JWT'),
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Reading files' }] },
    humanTurn('Keep the refresh token flow'),
  ]
  const session = makeSession({ messages })
  // Explicit config: this case asserts the fully-configured argv shape. The
  // zero-config shape is case 8b.
  const h = makeHarness({ config: { project: 'project-memory', captureFolder: 'sessions' } })
  h.emit('session/event', session, { type: 'compaction/start', seq: 10, data: { compactionId: 'c1', turn: 1 } })
  await settle()
  await settle()

  assert.equal(h.spawns.length, 1, 'one write')
  const argv = h.spawns[0].argv
  assert.ok(argv.includes('tool'), 'runs bm tool write-note')
  assert.ok(argv.includes('write-note'), 'write-note subcommand')
  assert.ok(argv.includes('--title'), 'passes a title')
  const title = argv[argv.indexOf('--title') + 1]
  assert.match(title, /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — Refactor the auth/, "bm Claude profile's title format")
  const content = argv[argv.indexOf('--content') + 1]
  assert.match(content, /^---\n/, 'frontmatter rides the content')
  assert.match(content, /trigger: "compaction"/, 'frontmatter trigger')
  assert.match(content, /capture: "extractive"/, 'frontmatter capture')
  assert.match(content, /## Summary/, 'body summary')
  assert.match(content, /## Recent thread/, 'body recent thread')
  assert.match(content, /Keep the refresh token flow/, 'captures the latest user turn')
  assert.equal(argv[argv.indexOf('--folder') + 1], 'sessions', "bm Claude profile's capture folder")
  assert.equal(argv[argv.indexOf('--project') + 1], 'project-memory', 'project')
  assert.equal(argv[argv.indexOf('--type') + 1], 'session', "bm Claude profile's note type")
  assert.match(content, /type: session\n/, 'frontmatter type (bare value, as emitted)')
  assert.match(content, /claude_session_id: "sess-1"/, "bm Claude profile's session-id key")
  // Tags ride argv, not frontmatter; bm's Claude profile uses exactly these.
  assert.equal(argv[argv.indexOf('--tags') + 1], 'session,auto-capture', "bm Claude profile's checkpoint_tags")
  console.log('ok  compaction/start: real PreCompact checkpoint, correct shape')
}

// --- 8c. the note type is the one bm's own lifecycle tooling recalls -------
// Verified against bm 0.23.2 by writing one note of each spelling and running
// `bm hook session-start` for both harness profiles:
//
//   type            recalled by --harness claude   recalled by --harness codex
//   session         YES                            no
//   codex_session   no                             YES
//   dsh_session     no                             no
//
// So the plugin adopts bm's Claude profile wholesale — type, title prefix, tags,
// session-id key and capture folder — which makes its checkpoints first-class
// output of bm's own tooling. This assertion is the guard against inventing a
// type no bm profile can read.
assert.equal(
  plugin.Config.parse({}).noteType,
  'session',
  "note type must stay bm Claude profile's session_note_type",
)

// The brief must recall both profile spellings, so a co-installed bm Codex
// profile keeps working.
{
  const h = makeHarness({ config: { project: 'project-memory' } })
  h.emit('agent/created', { agent: makeAgent(makeSession()) })
  await settle()
  await settle()
  const sessionQuery = h.spawns.find((s) => s.argv.includes('session'))
  const types = sessionQuery.argv.filter((a, i) => i > 0 && sessionQuery.argv[i - 1] === '--type')
  assert.deepEqual(types, ['session', 'codex_session'], 'recalls both profile spellings')
  console.log('ok  brief recall: both bm profile spellings')
}

// --- 8b. an unconfigured plugin omits --project but keeps --folder ------
// `--project` is optional (bm falls back to its own default_project), so the
// zero-config path must not invent one. `--folder` is required by bm, so it is
// always emitted.
{
  const messages = [humanTurn('Do the thing')]
  const session = makeSession({ messages })
  const h = makeHarness({ config: { project: '' } })
  h.emit('session/event', session, { type: 'compaction/start', seq: 1, data: { compactionId: 'c', turn: 1 } })
  await settle()
  await settle()

  assert.equal(h.spawns.length, 1, 'one write')
  const argv = h.spawns[0].argv
  assert.ok(!argv.includes('--project'), 'no --project when unconfigured')
  assert.equal(argv[argv.indexOf('--folder') + 1], 'sessions', 'folder still passed (bm requires it)')
  assert.ok(argv.includes('--title'), 'still writes a titled note')
  assert.ok(argv.includes('--content'), 'still writes content')
  const content = argv[argv.indexOf('--content') + 1]
  assert.ok(!/^project: /m.test(content), 'no empty project in frontmatter')
  console.log('ok  zero config: --project omitted, --folder kept')
}

// --- 9. non-compaction events are ignored --------------------------------
{
  const session = makeSession({ messages: [humanTurn('hi')] })
  const h = makeHarness()
  h.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await settle()
  assert.equal(h.spawns.length, 0, 'turn/start triggers nothing')
  console.log('ok  session/event: non-compaction events ignored')
}

// --- 10. checkpointOnCompact=false disables it ---------------------------
{
  const session = makeSession({ messages: [humanTurn('hi')] })
  const h = makeHarness({ config: { checkpointOnCompact: false } })
  h.emit('session/event', session, { type: 'compaction/start', seq: 1, data: { compactionId: 'c', turn: 1 } })
  await settle()
  assert.equal(h.spawns.length, 0, 'disabled checkpoint writes nothing')
  console.log('ok  checkpointOnCompact=false: no write')
}

// --- 11. agent/disposed sweeps the inbox, throttled ----------------------
{
  const session = makeSession()
  const h = makeHarness({ bm: { run: () => ({ exitCode: 0, stdout: 'swept 3 envelope(s): 2 archived', stderr: '' }) } })
  h.emit('agent/disposed', { agent: makeAgent(session) })
  await settle()
  assert.equal(h.spawns.length, 1, 'one flush')
  assert.ok(h.spawns[0].argv.includes('flush'), 'runs bm hook flush')
  assert.ok(h.spawns[0].argv.includes('--older-than-days'), 'passes retention')
  assert.equal(h.spawns[0].argv[h.spawns[0].argv.indexOf('--older-than-days') + 1], '30', 'default retention')

  // A second disposal inside the interval must not flush again.
  h.emit('agent/disposed', { agent: makeAgent(makeSession({ id: 'sess-2' })) })
  await settle()
  assert.equal(h.spawns.length, 1, 'flush is throttled')
  console.log('ok  agent/disposed: WAL swept once per interval')
}

// --- 12. flushIntervalHours=0 disables the sweep -------------------------
{
  const h = makeHarness({ config: { flushIntervalHours: 0 } })
  h.emit('agent/disposed', { agent: makeAgent(makeSession()) })
  await settle()
  assert.equal(h.spawns.length, 0, 'disabled sweep makes no call')
  console.log('ok  flushIntervalHours=0: no sweep')
}

// --- 13. commands are registered -----------------------------------------
{
  const h = makeHarness()
  const names = h.commands.map((command) => command.name).sort()
  assert.deepEqual(names, ['bm-checkpoint', 'bm-flush', 'bm-project', 'bm-status'], 'four commands')
  for (const command of h.commands) {
    assert.equal(typeof command.handler, 'function', `${command.name} has a handler`)
    assert.ok(command.description.length > 0, `${command.name} has a description`)
  }
  console.log('ok  commands: bm-status / bm-checkpoint / bm-flush / bm-project')
}

// --- 14. /bm-status runs bm hook status ----------------------------------
{
  const h = makeHarness({
    bm: { run: () => ({ exitCode: 0, stdout: 'inbox: /home/.basic-memory/inbox\npending envelopes: 3', stderr: '' }) },
  })
  const command = h.commands.find((c) => c.name === 'bm-status')
  const result = await command.handler({
    agent: makeAgent(makeSession()),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', 'success result')
  assert.match(result.text, /pending envelopes: 3/, 'status text')
  assert.match(result.text, /^```/, 'fenced')
  assert.ok(h.spawns[0].argv.includes('status'), 'runs bm hook status')
  console.log('ok  /bm-status')
}

// --- 15. /bm-checkpoint writes now --------------------------------------
{
  const session = makeSession({
    messages: [humanTurn('Write the checkpoint test')],
  })
  const h = makeHarness()
  const command = h.commands.find((c) => c.name === 'bm-checkpoint')
  const result = await command.handler({
    agent: makeAgent(session),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', 'success result')
  assert.match(result.text, /Checkpoint written: Session/, 'reports the title')
  const argv = h.spawns[0].argv
  assert.match(argv[argv.indexOf('--content') + 1], /trigger: "manual"/, 'manual trigger')
  console.log('ok  /bm-checkpoint')
}

// --- 16. /bm-checkpoint with no user turn reports honestly --------------
{
  const session = makeSession({ messages: [{ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'hello' }] }] })
  const h = makeHarness()
  const command = h.commands.find((c) => c.name === 'bm-checkpoint')
  const result = await command.handler({
    agent: makeAgent(session),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error', 'reports an error, does not write')
  assert.match(result.text, /Nothing to checkpoint/, 'honest message')
  assert.equal(h.spawns.length, 0, 'no write attempted')
  console.log('ok  /bm-checkpoint: no user turn')
}

// --- 16b. a transcript holding only injected context is not a user turn ---
// The regression this guards: `agent-loop` appends every `agent/pre-step`
// injection as a `user`-role message, so a role-only filter treated this
// plugin's own brief and the harness runtime context as the user's words.
// Before the fix, the three most recent turns of a briefed session were
// almost always injected context, so the checkpoint captured noise — and the
// next brief then recalled that noise as if it were the thread.
{
  const session = makeSession({
    messages: [
      injectedTurn('# Basic Memory — session context\n\n**Project:** project-memory\n## Active tasks (5)'),
      injectedTurn('runtime context blob from the harness', 'runtime-context'),
      injectedTurn('tool registry notice', 'tool-registry'),
    ],
  })
  const h = makeHarness()
  const command = h.commands.find((c) => c.name === 'bm-checkpoint')
  const result = await command.handler({
    agent: makeAgent(session),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error', 'reports an error, does not write')
  assert.match(result.text, /Nothing to checkpoint/, 'honest message')
  assert.equal(h.spawns.length, 0, 'no write attempted')
  console.log('ok  /bm-checkpoint: injected context is not a user turn')
}

// --- 16c. human turns survive alongside injected context ----------------
{
  const session = makeSession({
    messages: [
      humanTurn('real opening request'),
      injectedTurn('# Basic Memory — session context\n\n**Project:** project-memory'),
      humanTurn('second real turn'),
    ],
  })
  const h = makeHarness()
  const command = h.commands.find((c) => c.name === 'bm-checkpoint')
  const result = await command.handler({
    agent: makeAgent(session),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', 'a real turn still checkpoints')
  const content = h.spawns[0].argv[h.spawns[0].argv.indexOf('--content') + 1]
  assert.match(content, /Opening request: real opening request/, 'opening is the human turn')
  assert.match(content, /- second real turn/, 'recent thread keeps the human turn')
  assert.ok(!/Basic Memory — session context/.test(content), 'the injected brief is excluded')
  assert.ok(!/runtime context blob/.test(content), 'the runtime context is excluded')
  console.log('ok  /bm-checkpoint: human turns kept, injected context dropped')
}

// --- 17. a missing bm executable fails open ------------------------------
{
  const session = makeSession()
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: {
      resolve: () => {
        throw new Error('ENOENT: bm not found')
      },
    },
  })
  h.emit('agent/created', { agent: makeAgent(session) })
  await settle()
  await settle()
  assert.equal(h.spawns.length, 0, 'no spawn attempted')
  assert.ok(
    h.logs.some((entry) => entry.level === 'warn' && /cannot resolve/.test(entry.line)),
    'warns instead of throwing',
  )

  // The brief path still degrades to "no context" rather than breaking the step.
  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter', 'the step still enters')
  assert.equal(decision.messages.length, 0, 'no context added when bm is missing')
  console.log('ok  missing bm: fails open, step still enters')
}

// --- 18. a failing CLI is logged, not thrown ----------------------------
{
  const session = makeSession({ messages: [humanTurn('hi')] })
  const h = makeHarness({
    bm: { run: () => ({ exitCode: 2, stdout: '', stderr: 'project not found' }) },
  })
  h.emit('session/event', session, { type: 'compaction/start', seq: 1, data: { compactionId: 'c', turn: 1 } })
  await settle()
  await settle()
  assert.ok(
    h.logs.some((entry) => entry.level === 'warn' && /exit 2|exited 2/.test(entry.line)),
    'logs the failure',
  )
  console.log('ok  failing CLI: logged, not thrown')
}

// --- 18b. a rejected handle.done is reported, never thrown ----------------
// The subprocess contract allows `done` to REJECT for spawn/provider failures,
// not only resolve with a non-zero exit. An earlier revision awaited it inside
// a bare try/finally, so the rejection escaped every caller: `/bm-status`,
// `/bm-flush` and `/bm-project` threw into the command dispatcher and the
// plugin logged nothing at all, contradicting its own documented fail-open
// behavior. Command handlers carry no try/catch of their own for this, so the
// containment has to live in runBm.
{
  const rejecting = () => ({
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.reject(new Error('spawn EPERM')),
    terminate: () => {},
    waitForExit: async () => true,
  })
  const session = makeSession({ messages: [humanTurn('hi')] })
  const h = makeHarness()
  h.ctx.subprocess.spawn = (spec) => {
    h.spawns.push(spec)
    return rejecting()
  }

  for (const name of ['bm-status', 'bm-flush', 'bm-project', 'bm-checkpoint']) {
    const command = h.commands.find((c) => c.name === name)
    const result = await command.handler({
      agent: makeAgent(session),
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    })
    assert.equal(result.kind, 'error', `${name} reports a failure instead of throwing`)
    assert.match(result.text, /EPERM/, `${name} surfaces the reason`)
  }
  assert.ok(
    h.logs.some((entry) => entry.level === 'warn' && /spawn failed/.test(entry.line)),
    'the rejection is logged, not swallowed silently',
  )
  console.log('ok  rejected handle.done: every command fails open, nothing throws')
}

// --- 19. a slow brief does not stall the step ----------------------------
{
  const session = makeSession()
  // A CLI that resolves only after the wait budget: the plugin must not wait
  // for it beyond `briefWaitMs`, and must not keep the process alive either.
  const h = makeHarness({ config: { briefWaitMs: 50 } })
  h.ctx.subprocess.spawn = (spec) => {
    h.spawns.push(spec)
    const reader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: reader(), stderr: reader() },
      // Settles well after the 50 ms brief budget, but eventually — so the
      // test's own await chain is not left dangling.
      done: new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, signal: null }), 400)),
      terminate: () => {},
      waitForExit: async () => true,
    }
  }

  const started = Date.now()
  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  const elapsed = Date.now() - started
  assert.equal(decision.kind, 'enter', 'the step still enters')
  assert.equal(decision.messages.length, 0, 'no context when the brief is not ready')
  assert.ok(elapsed < 300, `the step did not stall (waited ${elapsed}ms)`)
  // Let the background brief settle before the next case.
  await new Promise((resolve) => setTimeout(resolve, 450))
  console.log('ok  briefWaitMs: a slow brief does not stall the step')
}

// --- 20. briefWaitMs=0 never waits ---------------------------------------
{
  const session = makeSession()
  const h = makeHarness({ config: { briefWaitMs: 0 } })
  h.ctx.subprocess.spawn = (spec) => {
    h.spawns.push(spec)
    const reader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: reader(), stderr: reader() },
      done: new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, signal: null }), 300)),
      terminate: () => {},
      waitForExit: async () => true,
    }
  }
  const started = Date.now()
  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(session), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.ok(Date.now() - started < 250, 'briefWaitMs=0 returns immediately')
  assert.equal(decision.messages.length, 0, 'no context')
  await new Promise((resolve) => setTimeout(resolve, 350))
  console.log('ok  briefWaitMs=0: never waits')
}

// --- 21. a hung CLI is aborted at timeoutMs ------------------------------
// Uses a short ceiling so the test does not wait a real two minutes.
{
  const session = makeSession()
  const h = makeHarness({ config: { timeoutMs: 1000 } })
  let aborted = false
  h.ctx.subprocess.spawn = (spec) => {
    h.spawns.push(spec)
    spec.signal?.addEventListener('abort', () => {
      aborted = true
    })
    const reader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) })
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: reader(), stderr: reader() },
      // A hung process: `done` never resolves until the abort fires.
      done: new Promise((_, reject) => {
        spec.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      terminate: () => {},
      waitForExit: async () => true,
    }
  }

  h.emit('agent/disposed', { agent: makeAgent(session) })
  await new Promise((resolve) => setTimeout(resolve, 1600))
  assert.ok(aborted, 'the timeout aborted the managed range')
  console.log('ok  timeoutMs: a hung CLI is aborted')
}

// --- 23. the plugin writes no settings file ----------------------------
// Configuration lives in DSH alone. bm's harness settings file is never
// created, read, or modified by this plugin — the brief is built from explicit
// `--project` queries instead, which is why no settings file is needed.
{
  const { existsSync, readdirSync } = await import('node:fs')
  const codexDir = join(sandboxHome, '.codex')
  const claudeDir = join(sandboxHome, '.claude')

  const h = makeHarness({ config: { project: 'project-memory' } })
  h.emit('agent/created', { agent: makeAgent(makeSession()) })
  await settle()
  await settle()

  assert.ok(!existsSync(join(codexDir, 'basic-memory.json')), 'no codex settings file written')
  assert.ok(!existsSync(join(claudeDir, 'settings.json')), 'no claude settings file written')
  // The sandbox home must be untouched entirely.
  const touched = [codexDir, claudeDir].filter((dir) => existsSync(dir) && readdirSync(dir).length > 0)
  assert.deepEqual(touched, [], 'sandbox home untouched')
  console.log('ok  writes no settings file anywhere')
}

// --- 24. /bm-project lists the projects ---------------------------------
// `project` is a user preference, so the command must show the current value
// and the available ones before anything is changed.
{
  const listOutput = JSON.stringify([
    { name: 'project-memory', path: 'D:/project-memory' },
    { name: 'main', path: 'C:/Users/x/basic-memory' },
  ])
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: { run: (argv) => ({ exitCode: 0, stdout: argv.includes('--json') ? listOutput : 'project-memory\nmain', stderr: '' }) },
  })
  const command = h.commands.find((c) => c.name === 'bm-project')
  const result = await command.handler({
    agent: makeAgent(makeSession()),
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', 'listing succeeds')
  assert.match(result.text, /Current project: \*\*project-memory\*\*/, 'shows the current project')
  assert.match(result.text, /project-memory/, 'lists available projects')
  console.log('ok  /bm-project: lists projects and the current one')
}

// --- 25. /bm-project switches through the config editor ----------------
// The write must go through `configEditor.edit` — the same path a Settings form
// takes — so the change persists to the profile patch and the Loader reconciles
// it live, with no restart and no file of our own.
{
  const listOutput = JSON.stringify([{ name: 'project-memory' }, { name: 'main' }])
  const edits = []
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: { run: () => ({ exitCode: 0, stdout: listOutput, stderr: '' }) },
    services: {
      configEditor: {
        edit: async (entry, change) => {
          edits.push({ entry, next: change({ project: 'project-memory', harness: 'codex' }) })
        },
      },
    },
  })
  const command = h.commands.find((c) => c.name === 'bm-project')
  const result = await command.handler({
    agent: makeAgent(makeSession()),
    rawInput: 'main',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', 'switch succeeds')
  assert.match(result.text, /switched to \*\*main\*\*/, 'reports the new project')
  assert.equal(edits.length, 1, 'one configEditor write')
  assert.equal(edits[0].next.project, 'main', 'writes the new project')
  assert.equal(edits[0].next.harness, 'codex', 'preserves the other fields')
  console.log('ok  /bm-project: switches via configEditor.edit')
}

// --- 26. /bm-project rejects an unknown name ---------------------------
// A typo must not silently point the brief and checkpoints at a missing project.
{
  const listOutput = JSON.stringify([{ name: 'project-memory' }])
  let edited = false
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: { run: () => ({ exitCode: 0, stdout: listOutput, stderr: '' }) },
    services: {
      configEditor: {
        edit: async () => {
          edited = true
        },
      },
    },
  })
  const command = h.commands.find((c) => c.name === 'bm-project')
  const result = await command.handler({
    agent: makeAgent(makeSession()),
    rawInput: 'typo-name',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error', 'rejects an unknown project')
  assert.match(result.text, /No project named/, 'explains the rejection')
  assert.match(result.text, /project-memory/, 'lists what is available')
  assert.equal(edited, false, 'nothing was written')
  console.log('ok  /bm-project: rejects an unknown project')
}

// --- 27. /bm-project without a config editor reports honestly ---------
{
  const listOutput = JSON.stringify([{ name: 'project-memory' }, { name: 'main' }])
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: { run: () => ({ exitCode: 0, stdout: listOutput, stderr: '' }) },
    // No configEditor service composed.
  })
  const command = h.commands.find((c) => c.name === 'bm-project')
  const result = await command.handler({
    agent: makeAgent(makeSession()),
    rawInput: 'main',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error', 'cannot switch without an editor')
  assert.match(result.text, /cordis\.patch\.yml/, 'points at the file to edit instead')
  console.log('ok  /bm-project: no config editor, honest guidance')
}

// --- 28. bm_set_project is a model-facing tool, not chat parsing ---------
// The plugin must never read the conversation to guess a project; it publishes a
// deterministic switch primitive and lets the model decide when to call it.
{
  const listOutput = JSON.stringify({
    projects: [
      { name: 'project-memory', local_path: 'D:/project-memory', is_default: false },
      { name: 'main', local_path: 'C:/Users/x/basic-memory', is_default: true },
    ],
  })
  const h = makeHarness({
    config: { project: 'project-memory' },
    bm: {
      run: (argv) =>
        argv.includes('project')
          ? { exitCode: 0, stdout: listOutput, stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ results: [] }), stderr: '' },
    },
  })

  const tool = h.tools.find((t) => t.name === 'bm_set_project')
  assert.ok(tool, 'registers the bm_set_project tool')
  assert.match(tool.description, /user names a project/, 'description tells the model when to call it')
  assert.equal(tool.parameters.type, 'object', 'object-rooted parameters')

  // List mode: no argument reports the available projects and the resolved one.
  const listed = await tool.execute({}, { agent: makeAgent(makeSession({ cwd: 'C:/workspace' })) })
  assert.equal(listed.ok, true, 'listing succeeds')
  assert.deepEqual(listed.available, ['project-memory', 'main'], 'lists the projects')
  assert.equal(listed.project, 'project-memory', 'reports the resolved project')

  // Switch mode binds this session without writing configuration.
  const session = makeSession({ cwd: 'C:/workspace' })
  const switched = await tool.execute({ project: 'main' }, { agent: makeAgent(session) })
  assert.equal(switched.ok, true, 'switch succeeds')
  assert.equal(switched.project, 'main', 'reports the new project')
  assert.equal(switched.previous, '', 'reports the previous binding')

  // The binding is per session: a different session keeps its own choice.
  const other = await tool.execute({}, { agent: makeAgent(makeSession({ id: 'sess-2', cwd: 'C:/workspace' })) })
  assert.equal(other.project, 'project-memory', 'the binding does not leak across sessions')

  // An unknown name is refused and lists what exists.
  const refused = await tool.execute({ project: 'typo' }, { agent: makeAgent(session) })
  assert.equal(refused.ok, false, 'rejects an unknown project')
  assert.match(refused.message, /No project named/, 'explains the rejection')
  assert.deepEqual(refused.available, ['project-memory', 'main'], 'lists the real names')
  console.log('ok  bm_set_project: per-session switch, no chat parsing')
}

// --- 29. cwd auto-detection matches by longest prefix --------------------
// One profile spans several repositories: a session inside a project's root
// must brief that project's graph, and a nested root must win over its parent.
{
  const projects = [
    { name: 'work', localPath: 'D:/work', isDefault: false },
    { name: 'deep', localPath: 'D:/work/deep', isDefault: false },
  ]
  assert.equal(matchProject('D:/work/deep/notes', projects), 'deep', 'longest prefix wins')
  assert.equal(matchProject('D:/work/other', projects), 'work', 'a sibling subdirectory uses its own root')
  assert.equal(matchProject('D:/workish', projects), undefined, 'a shared prefix is not a match')
  assert.equal(matchProject('C:/Windows', projects), undefined, 'an unrelated directory matches nothing')

  // `~` expands, and the result is stable across calls, so two spellings of the
  // same path compare equal.
  assert.equal(expandPath('D:/work'), expandPath('D:/work'), 'expansion is stable')
  assert.ok(expandPath('~/x').includes('x'), '~ expands')

  // A backslash is only a separator on Windows. On POSIX it is an ordinary
  // filename character, so asserting equivalence there would encode a Windows
  // assumption into a portable test — and it would fail on Linux CI.
  if (process.platform === 'win32') {
    assert.equal(expandPath('D:/work'), expandPath('D:\\work'), 'both separators normalize')
  } else {
    assert.notEqual(expandPath('D:/work'), expandPath('D:\\work'), 'POSIX keeps backslash literal')
  }

  // Resolution priority: explicit switch > cwd > configured > bm default.
  assert.deepEqual(
    resolveProject({ sessionProject: 'pinned', cwd: 'D:/work/deep', projects, configured: 'cfg', fallback: 'dflt' }),
    { project: 'pinned', source: 'session' },
    'an explicit switch wins',
  )
  assert.deepEqual(
    resolveProject({ cwd: 'D:/work/deep', projects, configured: 'cfg', fallback: 'dflt' }),
    { project: 'deep', source: 'cwd' },
    'a cwd match beats the configured value',
  )
  assert.deepEqual(
    resolveProject({ cwd: 'C:/Windows', projects, configured: 'cfg', fallback: 'dflt' }),
    { project: 'cfg', source: 'config' },
    'no match falls back to the configured project',
  )
  assert.deepEqual(
    resolveProject({ cwd: 'C:/Windows', projects, configured: '', fallback: 'dflt' }),
    { project: 'dflt', source: 'default' },
    'no config falls back to bm default_project',
  )
  assert.deepEqual(
    resolveProject({ cwd: 'C:/Windows', projects, configured: '', fallback: '' }),
    { project: '', source: 'none' },
    'nothing configured resolves to no project',
  )
  console.log('ok  projects: longest-prefix cwd match and resolution priority')
}

// --- 30. auto-detection is opt-in and never adds a CLI call when off -----
// Defaults matter: an unconfigured plugin must behave exactly as before, so a
// session must not pay for `bm project list` for *resolution* unless
// auto-detection is enabled. The project-knowledge section is a separate
// feature with its own config, so it is disabled here to isolate this
// contract (its list call is covered in 4c).
{
  const defaults = plugin.Config.parse({})
  assert.equal(read(defaults, 'autoDetectProject'), false, 'auto-detection is off by default')

  const h = makeHarness({ config: { project: 'project-memory', projectKnowledge: false } })
  h.emit('agent/created', { agent: makeAgent(makeSession({ cwd: 'D:/work' })) })
  await settle()
  await settle()
  assert.equal(h.spawns.length, 3, 'three brief queries and no project list call')
  assert.ok(
    h.spawns.every((s) => s.argv.includes('search-notes')),
    'every call is a brief query',
  )
  console.log('ok  autoDetectProject: off by default, no extra CLI call')
}

// --- 31. enabling auto-detection resolves the project from cwd ----------
{
  const listOutput = JSON.stringify({
    projects: [
      { name: 'work', local_path: 'D:/work', is_default: false },
      { name: 'other', local_path: 'D:/other', is_default: true },
    ],
  })
  const h = makeHarness({
    config: { project: 'configured', autoDetectProject: true },
    bm: {
      run: (argv) => {
        if (argv.includes('project')) return { exitCode: 0, stdout: listOutput, stderr: '' }
        return { exitCode: 0, stdout: JSON.stringify({ results: [{ title: 'T', permalink: 'p' }] }), stderr: '' }
      },
    },
  })
  h.emit('agent/created', { agent: makeAgent(makeSession({ cwd: 'D:/work/sub' })) })
  await settle()
  await settle()

  const listCalls = h.spawns.filter((s) => s.argv.includes('project'))
  assert.equal(listCalls.length, 1, 'one cached project-list call')
  const queries = h.spawns.filter((s) => s.argv.includes('search-notes'))
  assert.equal(queries.length, 3, 'still three brief sections')
  for (const query of queries) {
    assert.equal(query.argv[query.argv.indexOf('--project') + 1], 'work', 'brief reads the cwd project')
  }
  console.log('ok  autoDetectProject: cwd match drives the brief')
}

// --- 32. a workspace outside every project still gets a brief -----------
// The fallback chain must end at bm's default project, or a plain workspace
// directory would silently lose its session context.
//
// The envelope carries ONLY `projects` — verified against bm 0.23.2, which
// emits no `default_project` key (it lives in ~/.basic-memory/config.json).
// The default is the row flagged `is_default`, which is the same column
// `bm project list` renders as `[X]`. Asserting the real shape is the point:
// an earlier revision read a `default_project` key this CLI never sends, so
// the last fallback was unreachable and this case passed on a fiction.
{
  const listOutput = JSON.stringify({
    projects: [
      { name: 'work', local_path: 'D:/work', is_default: false },
      { name: 'main', local_path: 'C:/Users/x/basic-memory', is_default: true },
    ],
  })
  const h = makeHarness({
    config: { project: '', autoDetectProject: true },
    bm: {
      run: (argv) => {
        if (argv.includes('project')) return { exitCode: 0, stdout: listOutput, stderr: '' }
        return { exitCode: 0, stdout: JSON.stringify({ results: [{ title: 'T', permalink: 'p' }] }), stderr: '' }
      },
    },
  })
  h.emit('agent/created', { agent: makeAgent(makeSession({ cwd: 'C:/Users/x/default-workspace' })) })
  await settle()
  await settle()

  const queries = h.spawns.filter((s) => s.argv.includes('search-notes'))
  assert.equal(queries.length, 3, 'the fallback still produces a brief')
  for (const query of queries) {
    assert.equal(query.argv[query.argv.indexOf('--project') + 1], 'main', 'falls back to the is_default project')
  }
  console.log('ok  autoDetectProject: fallback reaches the default project')
}

// --- 32b. no default project means the brief honestly stays empty --------
// With no `is_default` row and no configured project there is nothing to read:
// the plugin must not invent one. (An earlier revision read a `default_project`
// key that never arrives, which made this case look like a working fallback.)
{
  const listOutput = JSON.stringify({
    projects: [{ name: 'work', local_path: 'D:/work', is_default: false }],
  })
  const h = makeHarness({
    config: { project: '', autoDetectProject: true },
    bm: {
      run: (argv) => {
        if (argv.includes('project')) return { exitCode: 0, stdout: listOutput, stderr: '' }
        return { exitCode: 0, stdout: JSON.stringify({ results: [{ title: 'T', permalink: 'p' }] }), stderr: '' }
      },
    },
  })
  h.emit('agent/created', { agent: makeAgent(makeSession({ cwd: 'C:/Users/x/default-workspace' })) })
  await settle()
  await settle()

  assert.equal(h.spawns.filter((s) => s.argv.includes('search-notes')).length, 0, 'no brief query with no project')
  const decision = await h.raise(
    'agent/pre-step',
    { agent: makeAgent(makeSession({ cwd: 'C:/Users/x/default-workspace' })), step: 1, turn: 1, messages: [], signal: new AbortController().signal },
    () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 0, 'no context invented')
  console.log('ok  autoDetectProject: no default project means no invented target')
}

// --- 33. the Settings bridge is registered only with a web server -------
// A headless composition has no `webServer`: the plugin must load and work
// there, and simply offer the page no data source.
{
  const without = makeHarness({ config: { project: 'project-memory' } })
  assert.equal(without.routes.length, 0, 'no route without a web server')
  assert.equal(without.commands.length, 4, 'commands still registered')

  const withServer = makeHarness({ config: { project: 'project-memory' }, webServer: true })
  assert.equal(withServer.routes.length, 1, 'one route with a web server')
  assert.equal(withServer.routes[0].path, '/bm-hooks/api', 'the settings bridge path')
  assert.equal(withServer.routes[0].kind, 'prefix', 'a prefix route')
  console.log('ok  web bridge: registered only when a web server exists')
}

// --- 34. a missing optional service must not abort the rest of apply ----
// `tools` is optional. Registering it directly on `ctx` throws when the
// registry is absent, and that throw skips every later registration — the web
// route included — so the Settings page silently loses its data source while
// commands keep working. Reach it through its own ctx.inject instead.
{
  const h = makeHarness({
    config: { project: 'project-memory' },
    webServer: true,
    tools: false,
    // No `tools` registry at all.
  })
  assert.equal(h.tools.length, 0, 'no tool registered without a registry')
  assert.equal(h.commands.length, 4, 'commands still registered')
  assert.equal(h.routes.length, 1, 'the web route still registers without tools')
  console.log('ok  optional tools: absence does not abort later registrations')
}

console.log('\nall checks passed')
