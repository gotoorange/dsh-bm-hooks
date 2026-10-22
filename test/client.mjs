/**
 * Loads the built client bundle the way `dsh-client-modules` does: a
 * `window.__ModuleLoader__` facade records the factory, then materializes it
 * with a `require` table seeded from the platform modules.
 *
 * This is a structural test, not a render test: it proves the bundle parses,
 * registers under the right id, declares its services, and produces a plugin
 * whose `apply` registers one settings page against a fake slot service.
 *
 *   node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInNewContext } from 'node:vm'

const bundlePath = join(process.cwd(), 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

// --- a minimal loader facade ---------------------------------------------
const registered = new Map()
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registered.set(id, factory)
    },
  },
}

// --- a React stand-in -----------------------------------------------------
// Only the members this bundle touches: createElement, useState, useEffect,
// and useId. Rendering is never exercised here, so the hooks can be no-ops.
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
}

const requireTable = {
  react: React,
  'react/jsx-runtime': { jsx: React.createElement, jsxs: React.createElement },
}

runInNewContext(source, { window, console, fetch: () => Promise.reject(new Error('no network in test')) })

assert.ok(registered.has('dsh-bm-hooks'), 'registers under the package id')

const plugin = registered.get('dsh-bm-hooks')((id) => {
  if (!(id in requireTable)) throw new Error(`unexpected require: ${id}`)
  return requireTable[id]
})

assert.equal(typeof plugin.apply, 'function', 'exports apply')
// The bundle runs in its own VM realm, so its arrays carry that realm's
// prototype; compare by value rather than by identity.
assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['slots', 'locale', 'configForms']), 'declares its client services')

// --- a fake browser plugin context ---------------------------------------
const registrations = []
const localeDictionaries = []
const effects = []

const form = {
  getSnapshot: () => ({
    status: 'ready',
    value: { project: 'project-memory', recallTimeframe: '7d', briefLimit: 5, autoDetectProject: false },
    base: {},
    user: {},
    revision: 1,
    writable: true,
  }),
  subscribe: () => () => {},
  mutate: async (ops) => {
    form.mutations.push(ops)
    return true
  },
  mutations: [],
  dispose: async () => {},
}

const ctx = {
  effect: (factory, label) => {
    effects.push(label)
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register: (namespace, dictionaries) => {
      localeDictionaries.push({ namespace, dictionaries })
      return () => {}
    },
    bind: (namespace) => (key, params) => {
      const copy = localeDictionaries.find((entry) => entry.namespace === namespace)?.dictionaries.en ?? {}
      let text = copy[key] ?? key
      for (const [name, replacement] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(replacement))
      }
      return text
    },
  },
  configForms: {
    get: (entryId) => {
      ctx.configForms.requested = entryId
      return form
    },
    requested: '',
  },
  slots: {
    inject: (slot, register) => {
      ctx.slots.injected.push(slot)
      return register()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
    injected: [],
  },
}

plugin.apply(ctx)

assert.equal(ctx.configForms.requested, 'bm-hooks', 'reads the settings form for the bm-hooks entry')
assert.deepEqual(ctx.slots.injected, ['settings.section'], 'registers into the settings section slot')
assert.equal(registrations.length, 1, 'one page registration')

const [registration] = registrations
assert.equal(registration.options.name, 'settings.section', 'slot name')
assert.equal(registration.options.id, 'bm-hooks', 'section id matches the entry id')
assert.equal(typeof registration.options.label, 'function', 'label is a thunk so it follows the locale')
assert.equal(registration.options.label(), 'Basic Memory', 'English label')
assert.equal(typeof registration.component, 'function', 'renders a component')

// The inject face must expose the two observable sources as hooks and the two
// actions as plain props; the runtime turns `hooks` into `use<Name>`.
const face = registration.options.inject()
assert.ok(face.hooks.config, 'exposes the settings form as a hook source')
assert.ok(face.hooks.catalog, 'exposes the project catalogue as a hook source')
assert.equal(typeof face.mutate, 'function', 'exposes the write action')
assert.equal(typeof face.refreshProjects, 'function', 'exposes the refresh action')
assert.equal(typeof face.t, 'function', 'exposes the locale reader')

// The bundle must not import a harness client package: a client plugin may only
// use the platform module table, or it fails to materialize.
for (const spec of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
  assert.ok(
    ['react', 'react/jsx-runtime', 'react-dom'].includes(spec[1]),
    `unexpected client require: ${spec[1]}`,
  )
}

// Writing goes through the settings transport, never through a patch file.
// Match actual write paths rather than the filename: prose may name the file
// to explain why it is not touched.
assert.ok(!/writeFile|writeFileSync|\.patch\.yml['"]\s*\)/.test(source), 'the client never writes a patch file')
assert.ok(!/\.\.\/package\.json/.test(source), 'the client never edits the manifest')
assert.ok(/\.mutate\(/.test(source), 'writes go through the config form')

console.log('ok  client: registers one settings page with hook sources')
console.log('ok  client: requires only platform modules')
console.log('ok  client: writes through the settings transport')
console.log('\nall client checks passed')
