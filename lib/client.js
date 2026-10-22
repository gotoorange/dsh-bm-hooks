/**
 * dsh-bm-hooks — browser half.
 *
 * Adds a **Basic Memory** page to Settings with the three preferences a user
 * actually changes: the project, the recall window, and how many entries the
 * brief shows. Everything else stays in `cordis.patch.yml`, where it belongs.
 *
 * Two rules shape this file:
 *
 *  - It is a *built artifact*, not ordinary ESM. `dsh-client-modules` serves
 *    this exact file and the page registers it as a lazy factory, so the module
 *    body is wrapped in the loader's `window.__ModuleLoader__.load({...})` form
 *    and React arrives through `require('react')` from the platform module
 *    table. There is no build step and no bundled React.
 *
 *  - Writes go through `ctx.configForms`, the Host settings transport. The page
 *    never edits `cordis.patch.yml` itself: that would bypass Loader validation
 *    and the revision check that keeps two editors from clobbering each other.
 *
 * The project *list* is a different matter: it lives in Basic Memory, not in
 * the settings document, so the Host half exposes it on `/bm-hooks/api`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bm-hooks',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.bmHooks'
    /** Host route the project list is read from. */
    const API = '/bm-hooks/api/projects'
    /** The profile entry id, which is also the settings namespace. */
    const ENTRY_ID = 'bm-hooks'

    /** English copy. */
    const en = {
      nav: 'Basic Memory',
      title: 'Basic Memory',
      intro:
        'Lifecycle hooks for the Basic Memory knowledge graph. These preferences apply to every session in this profile.',
      project: 'Project',
      projectHint:
        'The knowledge graph this profile reads and writes. Sessions can override it for their own lifetime, and a working directory inside a project root wins when auto-detection is on.',
      projectPlaceholder: 'Select a project…',
      projectUnset: 'Use Basic Memory default',
      projectResolved: 'This session resolves to',
      recall: 'Recall window',
      recallHint: 'How far back the session brief looks for recent session notes.',
      recall1d: 'Last 24 hours',
      recall7d: 'Last 7 days',
      recall30d: 'Last 30 days',
      briefLimit: 'Entries per section',
      briefLimitHint: 'How many notes the brief lists under each heading (1–20).',
      autoDetect: 'Match the project to the working directory',
      autoDetectHint:
        'When on, a session started inside a project root uses that project instead of the one selected above.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'The Host did not accept these values; they were left for you to correct.',
      reset: 'Reset to default',
      loading: 'Loading…',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'Basic Memory is not loaded in this profile, so it cannot be configured right now.',
      projectsFailed: 'Could not read the Basic Memory project list. The values above still apply.',
      invalidNumber: 'Enter a whole number from 1 to 20.',
      refresh: 'Refresh project list',
    }

    /** Simplified Chinese copy. */
    const zh = {
      nav: 'Basic Memory',
      title: 'Basic Memory',
      intro: 'Basic Memory 知识图谱的生命周期钩子。这些偏好对该配置下的所有会话生效。',
      project: '项目',
      projectHint:
        '该配置读写的知识图谱。会话可以临时覆盖它；开启自动识别时，位于项目根目录内的工作目录优先。',
      projectPlaceholder: '选择项目…',
      projectUnset: '使用 Basic Memory 默认项目',
      projectResolved: '当前会话解析为',
      recall: '召回窗口',
      recallHint: '会话简报向前查找最近会话笔记的时间范围。',
      recall1d: '最近 24 小时',
      recall7d: '最近 7 天',
      recall30d: '最近 30 天',
      briefLimit: '每节条数',
      briefLimitHint: '简报在每个标题下列出多少条笔记（1–20）。',
      autoDetect: '按工作目录匹配项目',
      autoDetectHint: '开启后，在某个项目根目录内启动的会话会使用该项目，而不是上面选中的项目。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      reset: '恢复默认',
      loading: '加载中…',
      readOnly: '本部署的设置为只读。',
      unavailable: '该配置未加载 Basic Memory，暂时无法配置。',
      projectsFailed: '无法读取 Basic Memory 项目列表；上面的值仍然有效。',
      invalidNumber: '请填写 1 到 20 的整数。',
      refresh: '刷新项目列表',
    }

    /** Recall presets offered in the dropdown. */
    const RECALL_PRESETS = ['1d', '7d', '30d']

    /**
     * One tiny observable store.
     *
     * The slot runtime turns every `hooks` entry into a `use<Name>` selector
     * hook bound with `useSyncExternalStore`, so the only contract here is
     * `subscribe(listener)` returning an unsubscribe and `getSnapshot()`
     * returning a stable reference until the value actually changes.
     *
     * @param {object} initial - the first snapshot.
     * @returns {object} the store, with `update` and `getSnapshot`/`subscribe`.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update(patch) {
          const next = { ...snapshot, ...patch }
          let changed = false
          for (const key of Object.keys(next)) {
            if (next[key] !== snapshot[key]) {
              changed = true
              break
            }
          }
          if (!changed) return
          snapshot = next
          for (const listener of listeners) listener()
        },
      }
    }

    /** Read the Host project catalogue. */
    async function fetchProjects(refresh) {
      const url = refresh ? `${API}?refresh=1` : API
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** Inject this page's stylesheet once per document. */
    function installStyles() {
      const tagId = 'dsh-bm-hooks/settings.css'
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}

      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-bm-hooks'
      tag.dataset.pluginCss = tagId
      tag.textContent = `
.bmh-section{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary)}
.bmh-heading{margin:0;font-size:18px;font-weight:600}
.bmh-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.bmh-field{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.bmh-field:last-of-type{border-bottom:0}
.bmh-label{font-size:14px;line-height:20px;font-weight:500}
.bmh-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bmh-control{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
.bmh-select,.bmh-number{font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-l2,transparent);border:.5px solid var(--dsw-alias-border-l2);
  border-radius:8px;padding:6px 10px;min-width:0}
.bmh-select{min-width:240px;max-width:100%}
.bmh-number{width:88px}
.bmh-select:focus-visible,.bmh-number:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.bmh-check{display:flex;gap:8px;align-items:flex-start}
.bmh-check input{margin-top:3px}
.bmh-actions{display:flex;gap:10px;align-items:center;padding-top:4px}
.bmh-button{font:inherit;font-size:13px;line-height:20px;cursor:pointer;border-radius:8px;padding:6px 14px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2,transparent);
  color:var(--dsw-alias-label-primary)}
.bmh-button[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.bmh-button:disabled{opacity:.5;cursor:default}
.bmh-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bmh-status[data-tone=error]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.bmh-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
`
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /** One labelled control block. */
    function Field(props) {
      return h(
        'div',
        { className: 'bmh-field' },
        h('label', { className: 'bmh-label', htmlFor: props.htmlFor }, props.label),
        props.hint ? h('p', { className: 'bmh-hint' }, props.hint) : null,
        h('div', { className: 'bmh-control' }, props.children),
      )
    }

    /**
     * The Basic Memory settings page.
     *
     * `useConfig` is the Host settings form for this entry (values, writability,
     * revision) and `useCatalog` is the project list fetched from the Host.
     *
     * @param {object} props - slot props: the bound hooks and the locale reader.
     * @returns {object} the page element.
     */
    function BasicMemorySettings(props) {
      const { t, useConfig, useCatalog } = props
      const config = useConfig((snapshot) => snapshot)
      const catalog = useCatalog((snapshot) => snapshot)

      const [draft, setDraft] = React.useState(undefined)
      const [status, setStatus] = React.useState('idle')
      const [error, setError] = React.useState('')

      const value = config?.value ?? {}
      // The draft is a local copy so typing does not write to the Host on every
      // keystroke; it resets whenever the accepted values change underneath it.
      const revisionKey = `${config?.revision ?? ''}`
      React.useEffect(() => {
        setDraft(undefined)
        setStatus('idle')
        setError('')
      }, [revisionKey])

      const current = draft ?? {
        project: typeof value.project === 'string' ? value.project : '',
        recallTimeframe: typeof value.recallTimeframe === 'string' ? value.recallTimeframe : '7d',
        briefLimit: typeof value.briefLimit === 'number' ? value.briefLimit : 5,
        autoDetectProject: value.autoDetectProject === true,
      }

      const writable = config?.writable === true
      const ready = config?.status === 'ready'
      const dirty =
        current.project !== (value.project ?? '') ||
        current.recallTimeframe !== (value.recallTimeframe ?? '7d') ||
        current.briefLimit !== (value.briefLimit ?? 5) ||
        current.autoDetectProject !== (value.autoDetectProject === true)

      const edit = (patch) => {
        setDraft({ ...current, ...patch })
        setStatus('idle')
        setError('')
      }

      const save = async () => {
        const limit = Number(current.briefLimit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
          setStatus('error')
          setError(t('invalidNumber'))
          return
        }
        setStatus('saving')
        setError('')
        try {
          // One atomic mutation: a half-applied triple would leave the brief
          // reading a project the recall window was not meant for.
          const ok = await props.mutate([
            { op: 'set', path: ['project'], value: current.project },
            { op: 'set', path: ['recallTimeframe'], value: current.recallTimeframe },
            { op: 'set', path: ['briefLimit'], value: limit },
            { op: 'set', path: ['autoDetectProject'], value: current.autoDetectProject },
          ])
          if (!ok) {
            setStatus('error')
            setError(t('saveFailed'))
            return
          }
          setDraft(undefined)
          setStatus('saved')
        } catch (cause) {
          setStatus('error')
          setError(String(cause?.message ?? cause))
        }
      }

      const projects = Array.isArray(catalog?.projects) ? catalog.projects : []
      // A configured project that the CLI no longer lists must stay selectable,
      // or the page would silently rewrite the user's choice on first save.
      const options = [...projects]
      if (current.project && !options.some((row) => row.name === current.project)) {
        options.unshift({ name: current.project, localPath: '', isDefault: false })
      }

      const heading = h('h2', { className: 'bmh-heading' }, t('title'))
      const intro = h('p', { className: 'bmh-intro' }, t('intro'))

      if (!ready && config?.status === 'unavailable') {
        return h('section', { className: 'bmh-section' }, heading, h('p', { className: 'bmh-intro' }, t('unavailable')))
      }

      return h(
        'section',
        { className: 'bmh-section' },
        heading,
        intro,

        h(
          Field,
          { label: t('project'), hint: t('projectHint'), htmlFor: 'bmh-project' },
          h(
            'select',
            {
              id: 'bmh-project',
              className: 'bmh-select',
              disabled: !writable,
              value: current.project,
              onChange: (event) => edit({ project: event.target.value }),
            },
            h('option', { value: '' }, t('projectUnset')),
            ...options.map((row) =>
              h(
                'option',
                { key: row.name, value: row.name },
                row.isDefault ? `${row.name} (default)` : row.name,
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bmh-button',
              disabled: catalog?.status === 'loading',
              onClick: () => props.refreshProjects(),
            },
            t('refresh'),
          ),
          catalog?.resolved
            ? h('p', { className: 'bmh-meta' }, `${t('projectResolved')}: ${catalog.resolved}`)
            : null,
          catalog?.status === 'error' ? h('p', { className: 'bmh-meta' }, t('projectsFailed')) : null,
        ),

        h(
          Field,
          { label: t('recall'), hint: t('recallHint'), htmlFor: 'bmh-recall' },
          h(
            'select',
            {
              id: 'bmh-recall',
              className: 'bmh-select',
              disabled: !writable,
              value: current.recallTimeframe,
              onChange: (event) => edit({ recallTimeframe: event.target.value }),
            },
            ...RECALL_PRESETS.map((preset) =>
              h('option', { key: preset, value: preset }, `${t(`recall${preset}`)} (${preset})`),
            ),
            RECALL_PRESETS.includes(current.recallTimeframe)
              ? null
              : h(
                  'option',
                  { key: current.recallTimeframe, value: current.recallTimeframe },
                  current.recallTimeframe,
                ),
          ),
        ),

        h(
          Field,
          { label: t('briefLimit'), hint: t('briefLimitHint'), htmlFor: 'bmh-limit' },
          h('input', {
            id: 'bmh-limit',
            className: 'bmh-number',
            type: 'number',
            min: 1,
            max: 20,
            step: 1,
            disabled: !writable,
            value: String(current.briefLimit),
            onChange: (event) => edit({ briefLimit: Number(event.target.value) }),
          }),
        ),

        h(
          'div',
          { className: 'bmh-field' },
          h(
            'label',
            { className: 'bmh-check', htmlFor: 'bmh-auto' },
            h('input', {
              id: 'bmh-auto',
              type: 'checkbox',
              disabled: !writable,
              checked: current.autoDetectProject === true,
              onChange: (event) => edit({ autoDetectProject: event.target.checked }),
            }),
            h(
              'span',
              null,
              h('span', { className: 'bmh-label' }, t('autoDetect')),
              h('p', { className: 'bmh-hint' }, t('autoDetectHint')),
            ),
          ),
        ),

        h(
          'div',
          { className: 'bmh-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'bmh-button',
              'data-primary': 'true',
              disabled: !writable || !dirty || status === 'saving',
              onClick: save,
            },
            status === 'saving' ? t('saving') : t('save'),
          ),
          status === 'saved' ? h('span', { className: 'bmh-status' }, t('saved')) : null,
          status === 'error' ? h('span', { className: 'bmh-status', 'data-tone': 'error' }, error) : null,
          !writable && ready ? h('span', { className: 'bmh-status' }, t('readOnly')) : null,
        ),
      )
    }

    /** Required client services. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the page.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'bm-hooks: dictionaries',
      )

      ctx.effect(() => installStyles(), 'bm-hooks: styles')

      // The Host settings form for this entry: values, revision, writability,
      // and the write queue. Shared with any other editor of the same entry.
      const form = ctx.configForms.get(ENTRY_ID)

      // The project catalogue is not part of the settings document, so it is
      // fetched from the Host route and cached here.
      const catalog = createStore({
        status: 'loading',
        projects: [],
        resolved: '',
        current: '',
      })

      let disposed = false
      const loadCatalog = async (refresh) => {
        catalog.update({ status: 'loading' })
        try {
          const body = await fetchProjects(refresh)
          if (disposed) return
          catalog.update({
            status: 'ready',
            projects: Array.isArray(body?.projects) ? body.projects : [],
            resolved: typeof body?.resolved === 'string' ? body.resolved : '',
            current: typeof body?.current === 'string' ? body.current : '',
          })
        } catch {
          if (disposed) return
          catalog.update({ status: 'error' })
        }
      }
      void loadCatalog(false)

      ctx.effect(
        () => () => {
          disposed = true
          void form.dispose()
        },
        'bm-hooks: form subscription',
      )

      // `settings.section` is declared at runtime by the Settings shell
      // (ui-settings-general's `sidebar.settings` entry), not by this package.
      // `whileServed` is what the shipped pages use for exactly this case: it
      // registers once the Host serves the namespace and withdraws the page
      // when it stops. Registering unconditionally means the slot may not exist
      // yet, and the page silently never appears.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: ENTRY_ID,
                  order: 60,
                  label: () => t('nav'),
                  locale: NS,
                  inject: () => ({
                    t,
                    hooks: { config: form, catalog },
                    mutate: (ops) => form.mutate(ops),
                    refreshProjects: () => loadCatalog(true),
                  }),
                },
                BasicMemorySettings,
              ),
            ),
          ),
        'bm-hooks: settings page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    return module.exports
  },
})
