// dsh-sillytavern client half.
//
// Two surfaces share the Host API at /st-api:
//  1. a Settings page with the three libraries (character cards, world info,
//     presets) — import, inspect, edit and preview;
//  2. a composer control that binds the character, lorebooks and preset to the
//     conversation being viewed.
window.__ModuleLoader__.load({
  id: 'dsh-sillytavern',
  factory(require) {
    // A client module that throws while initialising fails the entire web boot
    // ("web boot: 1 entry did not activate"), so the factory cannot be allowed
    // to propagate: a broken panel must cost the panel, not the application.
    try {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dsh-sillytavern'
    const API = '/st-api'

    // ---- dictionaries -----------------------------------------------------

    const en = {
      title: 'SillyTavern',
      characters: 'Characters',
      worlds: 'World Info',
      presets: 'Presets',
      importFile: 'Import file',
      empty: 'Nothing here yet. Import a SillyTavern file to begin.',
      delete: 'Delete',
      exportPng: 'Export PNG',
      exportJson: 'Export JSON',
      setDefault: 'Use by default',
      defaultBadge: 'Default',
      greetings: 'Greetings',
      creator: 'Creator',
      tags: 'Tags',
      entries: 'Entries',
      newEntry: 'New entry',
      scanTest: 'Test activation',
      scanHint: 'Type a message that should trigger entries…',
      scanRun: 'Run',
      activated: 'Activated',
      promptOrder: 'Prompt order',
      preview: 'Preview prompt',
      previewHint: 'Composed system prompt',
      none: 'None',
      bindCharacter: 'Character',
      bindWorlds: 'World Info',
      bindPreset: 'Preset',
      save: 'Save',
      cancel: 'Cancel',
      apply: 'Apply',
      keywords: 'Keywords',
      content: 'Content',
      entryComment: 'Comment',
      errors: 'Something went wrong',
      current: 'This conversation',
      unbind: 'Unbind',
      editEntry: 'Edit entry',
      saving: 'Saving…',
      deleted: 'Deleted',
      imported: 'Imported',
      scanResult: 'Scan result',
      persona: '<user>',
      personaName: 'Name',
      personaDescription: 'Description',
      addPersona: 'New persona',
      useInSession: 'Use in this chat',
      saved: 'Saved',
      bound: 'Bound to this chat',
      openPanel: 'Library',
      close: 'Close',
    }

    const zh = {
      title: 'SillyTavern',
      characters: '角色卡',
      worlds: '世界书',
      presets: '对话预设',
      importFile: '导入文件',
      empty: '这里还没有内容。先导入一个 SillyTavern 文件。',
      delete: '删除',
      exportPng: '导出 PNG',
      exportJson: '导出 JSON',
      setDefault: '设为默认',
      defaultBadge: '默认',
      greetings: '问候语',
      creator: '作者',
      tags: '标签',
      entries: '条目',
      newEntry: '新建条目',
      scanTest: '测试激活',
      scanHint: '输入一句应该触发条目的话…',
      scanRun: '测试',
      activated: '已激活',
      promptOrder: '提示词顺序',
      preview: '预览提示词',
      previewHint: '合成后的系统提示词',
      none: '无',
      bindCharacter: '角色',
      bindWorlds: '世界书',
      bindPreset: '预设',
      save: '保存',
      cancel: '取消',
      apply: '应用',
      keywords: '关键词',
      content: '内容',
      entryComment: '备注',
      errors: '出错了',
      current: '当前会话',
      unbind: '解除绑定',
      editEntry: '编辑条目',
      saving: '保存中…',
      deleted: '已删除',
      imported: '已导入',
      scanResult: '激活结果',
      persona: '<user>',
      personaName: '名称',
      personaDescription: '设定描述',
      addPersona: '新建 <user> 设定',
      useInSession: '用于当前会话',
      saved: '已保存',
      bound: '已绑定到当前会话',
      openPanel: '面板',
      close: '关闭',
    }

    // ---- API --------------------------------------------------------------

    function base64ToText(base64) {
      const binary = atob(base64)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }

    async function api(path, init) {
      const response = await fetch(API + path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-st-api': '1',
          ...(init && init.headers ? init.headers : {}),
        },
      })
      const text = await response.text()
      const body = text ? JSON.parse(text) : {}
      if (!response.ok) throw new Error(body.error || response.statusText)
      return body
    }

    function useLoad(loader, deps) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const reload = useCallback(() => {
        let live = true
        setState((current) => ({ ...current, loading: true }))
        loader()
          .then((data) => live && setState({ loading: false, data, error: null }))
          .catch((error) => live && setState({ loading: false, data: null, error }))
        return () => {
          live = false
        }
      }, deps)
      useEffect(reload, [reload])
      return [state, reload]
    }

    // ---- shared bits ------------------------------------------------------

    const styles = {
      page: { padding: '20px 24px', color: 'var(--dsw-alias-label-primary)', overflowY: 'auto', height: '100%' },
      tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: '16px' },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        background: 'none',
        padding: '8px 12px',
        cursor: 'pointer',
        fontSize: '13px',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        borderBottom: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
        marginBottom: '-1px',
      }),
      columns: { display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: '16px', alignItems: 'start' },
      list: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
        maxHeight: '520px',
        overflowY: 'auto',
      },
      row: (active) => ({
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        padding: '8px 10px',
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      }),
      panel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '16px',
        minHeight: '200px',
      },
      button: (primary) => ({
        appearance: 'none',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '6px 10px',
        borderRadius: '6px',
        border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
      }),
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', whiteSpace: 'pre-wrap' },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      pre: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '12px',
        lineHeight: 1.5,
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        padding: '10px',
        maxHeight: '320px',
        overflowY: 'auto',
      },
      toolbar: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' },
    }

    function Avatar({ id, name, size = 32 }) {
      const [failed, setFailed] = useState(false)
      if (!id || failed) {
        return h('div', {
          style: {
            width: size, height: size, borderRadius: '6px', flex: '0 0 auto',
            background: 'var(--dsw-alias-bg-layer-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: size * 0.45, color: 'var(--dsw-alias-label-secondary)',
          },
        }, (name || '?').slice(0, 1).toUpperCase())
      }
      return h('img', {
        src: `${API}/characters/${id}/avatar`,
        alt: name,
        onError: () => setFailed(true),
        style: { width: size, height: size, borderRadius: '6px', objectFit: 'cover', flex: '0 0 auto' },
      })
    }

    function ImportButton({ accept, onFile, t }) {
      const ref = useRef(null)
      return h(React.Fragment, null,
        h('button', { style: styles.button(true), onClick: () => ref.current && ref.current.click() }, t('importFile')),
        h('input', {
          ref,
          type: 'file',
          accept,
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0]
            event.target.value = ''
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => onFile(file, String(reader.result || ''))
            reader.readAsDataURL(file)
          },
        }),
      )
    }

    // ---- characters -------------------------------------------------------

    function CharactersTab({ t, sessionId }) {
      const [list, reloadList] = useLoad(() => api('/characters').then((body) => body.characters), [])
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [note, setNote] = useState(null)
      const [defaults, setDefaults] = useState({})

      useEffect(() => {
        api('/state').then((body) => setDefaults(body.defaults || {})).catch(() => {})
      }, [])

      useEffect(() => {
        if (!selected) return setDetail(null)
        let live = true
        api(`/characters/${selected}`).then((body) => live && setDetail(body.character)).catch(() => {})
        return () => { live = false }
      }, [selected])

      const doImport = async (file, dataUrl) => {
        try {
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          await api('/characters/import', { method: 'POST', body: JSON.stringify({ filename: file.name, base64 }) })
          setNote(t('imported'))
          reloadList()
        } catch (error) {
          setNote(error.message)
        }
      }

      const setDefault = async () => {
        await api('/defaults', { method: 'POST', body: JSON.stringify({ characterId: selected }) })
        setDefaults((current) => ({ ...current, characterId: selected }))
      }

      const useHere = async () => {
        await bindSession(sessionId, { characterId: selected })
        setNote(t('bound'))
      }

      const remove = async () => {
        await api(`/characters/${selected}`, { method: 'DELETE' })
        setSelected(null)
        setNote(t('deleted'))
        reloadList()
      }

      const download = (format) => {
        const link = document.createElement('a')
        link.href = `${API}/characters/${selected}/export?format=${format}`
        link.download = ''
        link.click()
      }

      return h('div', null,
        h('div', { style: styles.toolbar },
          h(ImportButton, { accept: '.png,.json,.charx', onFile: doImport, t }),
          note ? h('span', { style: styles.muted }, note) : null,
        ),
        h('div', { style: styles.columns },
          h('div', { style: styles.list },
            list.error ? h('div', { style: { padding: 12 } }, h('div', { style: styles.error }, list.error.message)) : null,
            !list.loading && list.data && list.data.length === 0
              ? h('div', { style: { padding: 12, ...styles.muted } }, t('empty'))
              : null,
            (list.data || []).map((item) => h('div', {
              key: item.id,
              style: styles.row(selected === item.id),
              onClick: () => setSelected(item.id),
            },
            h(Avatar, { id: item.id, name: item.name, size: 34 }),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
              h('div', { style: { ...styles.muted, fontSize: '11px' } },
                [item.creator, defaults.characterId === item.id ? t('defaultBadge') : null].filter(Boolean).join(' · ') || '—'),
            )),
          )),
          h('div', { style: styles.panel },
            !selected ? h('div', { style: styles.muted }, t('empty')) : null,
            selected && detail ? h('div', null,
              h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start' } },
                h(Avatar, { id: detail.id, name: detail.name, size: 72 }),
                h('div', { style: { minWidth: 0, flex: 1 } },
                  h('div', { style: { fontSize: '17px', fontWeight: 600 } }, detail.name),
                  h('div', { style: { ...styles.muted, marginTop: 2 } },
                    [detail.creator, detail.characterVersion && `v${detail.characterVersion}`, detail.spec]
                      .filter(Boolean).join(' · ')),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                    (detail.tags || []).map((tag) => h('span', { key: tag, style: styles.badge }, tag))),
                ),
              ),
              h('div', { style: { display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap' } },
                sessionId ? h('button', { style: styles.button(true), onClick: useHere }, t('useInSession')) : null,
                h('button', { style: styles.button(false), onClick: setDefault }, t('setDefault')),
                h('button', { style: styles.button(false), onClick: () => download('png') }, t('exportPng')),
                h('button', { style: styles.button(false), onClick: () => download('json') }, t('exportJson')),
                h('button', { style: { ...styles.button(false), color: 'var(--dsw-alias-state-error-primary)' }, onClick: remove }, t('delete')),
              ),
              h('div', { style: styles.muted }, t('content')),
              h('div', { style: styles.pre }, detail.description || '—'),
              detail.firstMes ? h('div', null,
                h('div', { style: { ...styles.muted, marginTop: 12 } }, t('greetings')),
                h('div', { style: styles.pre }, [detail.firstMes, ...(detail.alternateGreetings || [])].join('\n\n———\n\n')),
              ) : null,
            ) : null,
          ),
        ),
      )
    }

    // ---- world info -------------------------------------------------------

    const EMPTY_ENTRY = { key: [], content: '', comment: '', constant: false, order: 100, position: 0, depth: 4, selective: true, selectiveLogic: 0 }

    function WorldsTab({ t, sessionId }) {
      const [list, reloadList] = useLoad(() => api('/worlds').then((body) => body.worlds), [])
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [scanText, setScanText] = useState('')
      const [scan, setScan] = useState(null)
      const [editing, setEditing] = useState(null)
      const [note, setNote] = useState(null)
      const [defaults, setDefaults] = useState({})

      useEffect(() => {
        api('/state').then((body) => setDefaults(body.defaults || {})).catch(() => {})
      }, [])

      const loadDetail = useCallback(() => {
        if (!selected) return setDetail(null)
        api(`/worlds/${selected}`).then((body) => setDetail(body.world)).catch(() => {})
      }, [selected])
      useEffect(loadDetail, [loadDetail])

      const doImport = async (file, dataUrl) => {
        try {
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          const json = base64ToText(base64)
          await api('/worlds/import', { method: 'POST', body: JSON.stringify({ name: file.name.replace(/\.json$/i, ''), json }) })
          setNote(t('imported'))
          reloadList()
        } catch (error) {
          setNote(error.message)
        }
      }

      const runScan = async () => {
        try {
          setScan(await api(`/worlds/${selected}/scan`, { method: 'POST', body: JSON.stringify({ text: scanText }) }))
        } catch (error) {
          setNote(error.message)
        }
      }

      const saveEntry = async (uid, patch) => {
        try {
          const world = await api(`/worlds/${selected}/entries/${uid}`, { method: 'PUT', body: JSON.stringify(patch) })
          setDetail(world.world)
          setEditing(null)
          reloadList()
        } catch (error) {
          setNote(error.message)
        }
      }

      const removeEntry = async (uid) => {
        const world = await api(`/worlds/${selected}/entries/${uid}`, { method: 'DELETE' })
        setDetail(world.world)
        reloadList()
      }

      const entries = detail ? Object.entries(detail.entries || {}) : []

      return h('div', null,
        h('div', { style: styles.toolbar },
          h(ImportButton, { accept: '.json', onFile: doImport, t }),
          note ? h('span', { style: styles.muted }, note) : null,
        ),
        h('div', { style: styles.columns },
          h('div', { style: styles.list },
            !list.loading && list.data && list.data.length === 0
              ? h('div', { style: { padding: 12, ...styles.muted } }, t('empty')) : null,
            (list.data || []).map((item) => h('div', {
              key: item.id,
              style: styles.row(selected === item.id),
              onClick: () => { setSelected(item.id); setScan(null) },
            },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: '13px' } }, item.name),
              h('div', { style: { ...styles.muted, fontSize: '11px' } },
                [`${item.entries} ${t('entries')}`, defaults.worldbookIds && defaults.worldbookIds.includes(item.id) ? t('defaultBadge') : null]
                  .filter(Boolean).join(' · ')),
            )),
          )),
          h('div', { style: styles.panel },
            !selected ? h('div', { style: styles.muted }, t('empty')) : null,
            selected ? h('div', null,
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                h('div', { style: { fontSize: '15px', fontWeight: 600 } }, detail ? detail.name : ''),
                h('div', { style: { display: 'flex', gap: 6 } },
                  sessionId ? h('button', {
                    style: styles.button(true),
                    onClick: async () => {
                      const binding = await api(`/sessions/${sessionId}/binding`)
                      const next = [...new Set([...(binding.worldbookIds || []), selected])]
                      await bindSession(sessionId, { worldbookIds: next })
                      setNote(t('bound'))
                    },
                  }, t('useInSession')) : null,
                  h('button', {
                    style: styles.button(false),
                    onClick: async () => {
                      const current = defaults.worldbookIds || []
                      const next = current.includes(selected) ? current : [...current, selected]
                      await api('/defaults', { method: 'POST', body: JSON.stringify({ worldbookIds: next }) })
                      setDefaults((state) => ({ ...state, worldbookIds: next }))
                    },
                  }, t('setDefault')),
                ),
              ),
              h('div', { style: { ...styles.toolbar, marginTop: 12 } },
                h('input', {
                  style: { ...styles.input, flex: 1, minWidth: 160 },
                  placeholder: t('scanHint'),
                  value: scanText,
                  onChange: (event) => setScanText(event.target.value),
                }),
                h('button', { style: styles.button(false), onClick: runScan }, t('scanRun')),
                h('button', { style: styles.button(false), onClick: () => setEditing({ uid: '', ...EMPTY_ENTRY }) }, t('newEntry')),
              ),
              scan ? h('div', { style: { marginBottom: 12 } },
                h('div', { style: styles.muted }, `${t('activated')}: ${scan.activated.length} · ${t('scanResult')}`),
                h('div', { style: styles.pre },
                  [...scan.activated.map((entry) => entry.comment || `#${entry.uid}`)].join('\n') || t('none')),
              ) : null,
              h('div', { style: styles.muted, marginBottom: 6 }, `${t('entries')}: ${entries.length}`),
              entries.map(([uid, entry]) => h('div', {
                key: uid,
                style: {
                  borderTop: '1px solid var(--dsw-alias-border-l1)',
                  padding: '8px 0',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                },
              },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '12px', fontWeight: 600 } }, entry.comment || `#${uid}`),
                h('div', { style: { ...styles.muted, fontSize: '11px' } },
                  `[${(entry.key || []).join(', ')}]${entry.constant ? ' · constant' : ''} · order ${entry.order ?? 100}`),
                h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: 2, maxHeight: 34, overflow: 'hidden' } },
                  String(entry.content || '').slice(0, 160)),
              ),
              h('button', { style: styles.button(false), onClick: () => setEditing({ uid, ...entry }) }, t('editEntry')),
              h('button', {
                style: { ...styles.button(false), color: 'var(--dsw-alias-state-error-primary)' },
                onClick: () => removeEntry(uid),
              }, t('delete'))),
              ),
              editing ? h(EntryEditor, { t, entry: editing, onCancel: () => setEditing(null), onSave: saveEntry }) : null,
            ) : null,
          ),
        ),
      )
    }

    function EntryEditor({ t, entry, onCancel, onSave }) {
      const [form, setForm] = useState({
        comment: entry.comment || '',
        key: (entry.key || []).join(', '),
        content: entry.content || '',
        constant: Boolean(entry.constant),
        order: Number(entry.order ?? 100),
        position: Number(entry.position ?? 0),
        depth: Number(entry.depth ?? 4),
        probability: Number(entry.probability ?? 100),
        sticky: entry.sticky ?? 0,
        cooldown: entry.cooldown ?? 0,
        selective: entry.selective !== false,
        selectiveLogic: Number(entry.selectiveLogic ?? 0),
        scanDepth: entry.scanDepth ?? '',
        caseSensitive: entry.caseSensitive ?? '',
        matchWholeWords: entry.matchWholeWords ?? '',
      })
      const field = (label, node) => h('label', { style: { display: 'block', marginBottom: 8 } },
        h('div', { style: { ...styles.muted, marginBottom: 3 } }, label), node)

      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
        },
        onClick: onCancel,
      },
      h('div', {
        style: {
          width: 'min(560px, 92vw)', maxHeight: '86vh', overflowY: 'auto',
          background: 'var(--dsw-alias-bg-overlay)', borderRadius: 10, padding: 18,
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 12 } }, t('editEntry')),
      field(t('entryComment'), h('input', {
        style: styles.input, value: form.comment,
        onChange: (event) => setForm({ ...form, comment: event.target.value }),
      })),
      field(t('keywords'), h('input', {
        style: styles.input, value: form.key, placeholder: 'dragon, /dr[a-z]+gon/i',
        onChange: (event) => setForm({ ...form, key: event.target.value }),
      })),
      field(t('content'), h('textarea', {
        style: { ...styles.input, minHeight: 120, resize: 'vertical' }, value: form.content,
        onChange: (event) => setForm({ ...form, content: event.target.value }),
      })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
        field('order', h('input', { type: 'number', style: styles.input, value: form.order, onChange: (event) => setForm({ ...form, order: Number(event.target.value) }) })),
        field('position', h('input', { type: 'number', style: styles.input, value: form.position, onChange: (event) => setForm({ ...form, position: Number(event.target.value) }) })),
        field('depth', h('input', { type: 'number', style: styles.input, value: form.depth, onChange: (event) => setForm({ ...form, depth: Number(event.target.value) }) })),
        field('probability', h('input', { type: 'number', style: styles.input, value: form.probability, onChange: (event) => setForm({ ...form, probability: Number(event.target.value) }) })),
        field('sticky', h('input', { type: 'number', style: styles.input, value: form.sticky, onChange: (event) => setForm({ ...form, sticky: Number(event.target.value) }) })),
        field('cooldown', h('input', { type: 'number', style: styles.input, value: form.cooldown, onChange: (event) => setForm({ ...form, cooldown: Number(event.target.value) }) })),
      ),
      h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 } },
        h('input', { type: 'checkbox', checked: form.constant, onChange: (event) => setForm({ ...form, constant: event.target.checked }) }),
        h('span', { style: { fontSize: 12 } }, 'constant (always active)')),
      h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        h('button', { style: styles.button(false), onClick: onCancel }, t('cancel')),
        h('button', {
          style: styles.button(true),
          onClick: () => onSave(entry.uid, {
            comment: form.comment,
            key: form.key.split(',').map((item) => item.trim()).filter(Boolean),
            content: form.content,
            constant: form.constant,
            order: form.order,
            position: form.position,
            depth: form.depth,
            probability: form.probability,
            sticky: form.sticky,
            cooldown: form.cooldown,
            selective: form.selective,
            selectiveLogic: form.selectiveLogic,
          }),
        }, t('save')),
      )))
    }

    // ---- presets ----------------------------------------------------------

    function PresetsTab({ t, sessionId }) {
      const [list, reloadList] = useLoad(() => api('/presets').then((body) => body.presets), [])
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [preview, setPreview] = useState(null)
      const [note, setNote] = useState(null)
      const [defaults, setDefaults] = useState({})

      useEffect(() => {
        api('/state').then((body) => setDefaults(body.defaults || {})).catch(() => {})
      }, [])

      useEffect(() => {
        if (!selected) return setDetail(null)
        api(`/presets/${selected}`).then((body) => setDetail(body.preset)).catch(() => {})
      }, [selected])

      const doImport = async (file, dataUrl) => {
        try {
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          const json = base64ToText(base64)
          await api('/presets/import', { method: 'POST', body: JSON.stringify({ name: file.name.replace(/\.json$/i, ''), json }) })
          setNote(t('imported'))
          reloadList()
        } catch (error) {
          setNote(error.message)
        }
      }

      const runPreview = async () => {
        try {
          setPreview(await api('/preview', { method: 'POST', body: JSON.stringify({ presetId: selected }) }))
        } catch (error) {
          setNote(error.message)
        }
      }

      const order = detail ? (detail.promptOrder || []) : []
      const prompts = detail ? (detail.prompts || []) : []
      const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]))

      return h('div', null,
        h('div', { style: styles.toolbar },
          h(ImportButton, { accept: '.json', onFile: doImport, t }),
          note ? h('span', { style: styles.muted }, note) : null,
        ),
        h('div', { style: styles.columns },
          h('div', { style: styles.list },
            !list.loading && list.data && list.data.length === 0
              ? h('div', { style: { padding: 12, ...styles.muted } }, t('empty')) : null,
            (list.data || []).map((item) => h('div', {
              key: item.id,
              style: styles.row(selected === item.id),
              onClick: () => { setSelected(item.id); setPreview(null) },
            },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: '13px' } }, item.name),
              h('div', { style: { ...styles.muted, fontSize: '11px' } },
                [String(item.prompts), defaults.presetId === item.id ? t('defaultBadge') : null].filter(Boolean).join(' · ')),
            )),
          )),
          h('div', { style: styles.panel },
            !selected ? h('div', { style: styles.muted }, t('empty')) : null,
            selected ? h('div', null,
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', { style: { fontSize: 15, fontWeight: 600 } }, detail ? detail.name : ''),
                h('div', { style: { display: 'flex', gap: 6 } },
                  sessionId ? h('button', {
                    style: styles.button(true),
                    onClick: async () => {
                      await bindSession(sessionId, { presetId: selected })
                      setNote(t('bound'))
                    },
                  }, t('useInSession')) : null,
                  h('button', {
                    style: styles.button(false),
                    onClick: async () => {
                      await api('/defaults', { method: 'POST', body: JSON.stringify({ presetId: selected }) })
                      setDefaults((state) => ({ ...state, presetId: selected }))
                    },
                  }, t('setDefault')),
                  h('button', { style: styles.button(false), onClick: runPreview }, t('preview')),
                ),
              ),
              detail ? h('div', { style: { ...styles.muted, marginTop: 4 } },
                `temperature ${detail.temperature} · top_p ${detail.topP} · max_tokens ${detail.maxTokens ?? '—'}`) : null,
              h('div', { style: { ...styles.muted, margin: '14px 0 6px' } }, t('promptOrder')),
              order.map((entry, index) => {
                const prompt = byId.get(entry.identifier)
                return h('div', {
                  key: entry.identifier + index,
                  style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderTop: index ? '1px solid var(--dsw-alias-border-l1)' : 'none' },
                },
                h('input', {
                  type: 'checkbox',
                  checked: entry.enabled !== false,
                  onChange: async (event) => {
                    const nextOrder = order.map((item) => item.identifier === entry.identifier ? { ...item, enabled: event.target.checked } : item)
                    const updated = await api(`/presets/${selected}`, { method: 'GET' })
                    const preset = updated.preset
                    const saved = await api('/presets/import', {
                      method: 'POST',
                      body: JSON.stringify({ name: preset.name, data: { ...preset, prompt_order: [{ character_id: 100001, order: nextOrder }] } }),
                    })
                    setDetail(saved.preset)
                  },
                }),
                h('div', { style: { flex: 1, fontSize: 12 } }, prompt && prompt.name ? prompt.name : entry.identifier),
                h('span', { style: { ...styles.muted, fontSize: 11 } }, prompt && prompt.marker ? 'marker' : (prompt && prompt.role) || ''),
                )
              }),
              preview ? h('div', { style: { marginTop: 16 } },
                h('div', { style: styles.muted }, t('previewHint')),
                h('div', { style: styles.pre }, preview.system || '—'),
              ) : null,
            ) : null,
          ),
        ),
      )
    }

    // ---- the library panel, opened from the conversation -------------------

    async function bindSession(sessionId, patch) {
      return api(`/sessions/${sessionId}/binding`, { method: 'POST', body: JSON.stringify(patch) })
    }

    const panel = { open: false, tab: 'characters', sessionId: null, listeners: new Set() }
    function updatePanel(patch) {
      Object.assign(panel, patch)
      for (const listener of panel.listeners) listener()
    }
    function usePanel() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        panel.listeners.add(listener)
        return () => panel.listeners.delete(listener)
      }, [])
      return panel
    }

    // ---- personas (<user>) -------------------------------------------------

    function PersonasTab({ t, sessionId }) {
      const [list, reloadList] = useLoad(() => api('/personas').then((body) => body.personas), [])
      const [selected, setSelected] = useState(null)
      const [form, setForm] = useState({ name: '', description: '' })
      const [note, setNote] = useState(null)
      const [bound, setBound] = useState(null)

      useEffect(() => {
        if (!sessionId) return
        let live = true
        api(`/sessions/${sessionId}/binding`)
          .then((binding) => live && setBound(binding.personaId ?? null))
          .catch(() => {})
        return () => { live = false }
      }, [sessionId])

      useEffect(() => {
        if (!selected) return setForm({ name: '', description: '' })
        let live = true
        api(`/personas/${selected}`)
          .then((body) => live && setForm({ name: body.persona.name ?? '', description: body.persona.description ?? '' }))
          .catch(() => {})
        return () => { live = false }
      }, [selected])

      const save = async () => {
        try {
          const body = await api('/personas', {
            method: 'POST',
            body: JSON.stringify({ id: selected || undefined, name: form.name, description: form.description }),
          })
          setSelected(body.persona.id)
          setNote(t('saved'))
          reloadList()
        } catch (error) {
          setNote(error.message)
        }
      }

      const remove = async () => {
        if (!selected) return
        await api(`/personas/${selected}`, { method: 'DELETE' })
        setSelected(null)
        setNote(t('deleted'))
        reloadList()
      }

      const use = async () => {
        await bindSession(sessionId, { personaId: selected })
        setBound(selected)
        setNote(t('bound'))
      }

      const unuse = async () => {
        await bindSession(sessionId, { personaId: null })
        setBound(null)
      }

      return h('div', { style: styles.columns },
        h('div', { style: styles.list },
          h('div', {
            style: { ...styles.row(false), borderBottom: '1px solid var(--dsw-alias-border-l1)' },
            onClick: () => setSelected(null),
          }, h('span', { style: { fontSize: 12 } }, t('addPersona'))),
          !list.loading && list.data && list.data.length === 0
            ? h('div', { style: { padding: 12, ...styles.muted } }, t('empty')) : null,
          (list.data || []).map((item) => h('div', {
            key: item.id,
            style: styles.row(selected === item.id),
            onClick: () => setSelected(item.id),
          }, h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 13 } }, item.name),
            h('div', { style: { ...styles.muted, fontSize: 11 } }, bound === item.id ? t('defaultBadge') : '')))),
        ),
        h('div', { style: styles.panel },
          note ? h('div', { style: { ...styles.muted, marginBottom: 8 } }, note) : null,
          h('label', { style: { display: 'block', marginBottom: 10 } },
            h('div', { style: { ...styles.muted, marginBottom: 3 } }, t('personaName')),
            h('input', {
              style: styles.input,
              value: form.name,
              placeholder: 'User',
              onChange: (event) => setForm({ ...form, name: event.target.value }),
            })),
          h('label', { style: { display: 'block', marginBottom: 12 } },
            h('div', { style: { ...styles.muted, marginBottom: 3 } }, t('personaDescription')),
            h('textarea', {
              style: { ...styles.input, minHeight: 140, resize: 'vertical' },
              value: form.description,
              onChange: (event) => setForm({ ...form, description: event.target.value }),
            })),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { style: styles.button(true), onClick: save }, t('save')),
            sessionId ? h('button', { style: styles.button(false), onClick: use }, t('useInSession')) : null,
            sessionId && bound ? h('button', { style: styles.button(false), onClick: unuse }, t('unbind')) : null,
            selected ? h('button', {
              style: { ...styles.button(false), color: 'var(--dsw-alias-state-error-primary)' },
              onClick: remove,
            }, t('delete')) : null,
          ),
        ),
      )
    }

    // ---- conversation dock: one row, no trip to Settings -------------------

    function ChatDock(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [state, setState] = useState(null)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const [binding, characters, worlds, presets, personas] = await Promise.all([
            api(`/sessions/${sessionId}/binding`),
            api('/characters'),
            api('/worlds'),
            api('/presets'),
            api('/personas'),
          ])
          setState({
            binding,
            characters: characters.characters,
            worlds: worlds.worlds,
            presets: presets.presets,
            personas: personas.personas,
          })
        } catch {
          setState(null)
        }
      }, [sessionId])

      useEffect(() => { load() }, [load])
      useEffect(() => {
        panel.listeners.add(load)
        return () => panel.listeners.delete(load)
      }, [load])

      const binding = state ? state.binding : null
      const nameOf = (items, id) => (items.find((item) => item.id === id) || {}).name
      const chip = (tab, label, value) => h('button', {
        key: tab,
        title: t(tab),
        style: {
          display: 'flex', alignItems: 'center', gap: 4, maxWidth: 200,
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999,
          background: 'transparent', padding: '3px 9px', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)', fontSize: 11,
        },
        onClick: () => updatePanel({ open: true, tab, sessionId }),
      },
      h('span', { style: { opacity: 0.75 } }, label),
      h('span', {
        style: { color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, value))

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', flexWrap: 'wrap' },
      },
      chip('characters', t('characters'), binding && binding.characterId ? nameOf(state.characters, binding.characterId) || '…' : t('none')),
      chip('worlds', t('worlds'), binding && binding.worldbookIds && binding.worldbookIds.length
        ? `${binding.worldbookIds.length} ${t('entries')}` : t('none')),
      chip('presets', t('presets'), binding && binding.presetId ? nameOf(state.presets, binding.presetId) || '…' : t('none')),
      chip('personas', t('persona'), binding && binding.personaId ? nameOf(state.personas, binding.personaId) || '…' : 'User'),
      h('button', {
        style: { ...styles.button(false), fontSize: 11, padding: '3px 9px', borderRadius: 999 },
        onClick: () => updatePanel({ open: true, tab: 'characters', sessionId }),
      }, t('openPanel')))
    }

    // ---- the panel itself --------------------------------------------------

    function LibraryPanel(props) {
      const t = props.t
      const state = usePanel()
      if (!state.open) return null
      const tabs = ['characters', 'worlds', 'presets', 'personas']
      const content = {
        characters: CharactersTab,
        worlds: WorldsTab,
        presets: PresetsTab,
        personas: PersonasTab,
      }[state.tab]

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          // The overlay layer is click-through by default; the panel opts in.
          pointerEvents: 'auto',
        },
        onClick: () => updatePanel({ open: false }),
      },
      h('div', {
        style: {
          width: 'min(1100px, 94vw)', height: 'min(780px, 90vh)',
          background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        },
        onClick: (event) => event.stopPropagation(),
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('title')),
      h('button', { style: styles.button(false), onClick: () => updatePanel({ open: false }) }, t('close'))),
      h('div', { style: { ...styles.tabs, padding: '0 16px', marginBottom: 0 } },
        tabs.map((key) => h('button', {
          key,
          style: styles.tab(state.tab === key),
          onClick: () => updatePanel({ tab: key }),
        }, t(key)))),
      h('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
        content ? h(content, { t, sessionId: state.sessionId }) : null),
      ))
    }

    // ---- settings page ----------------------------------------------------

    function SettingsPage(props) {
      const t = props.t
      const [tab, setTab] = useState('characters')
      return h('div', { style: styles.page },
        h('div', { style: { fontSize: 18, fontWeight: 600, marginBottom: 14 } }, t('title')),
        h('div', { style: styles.tabs },
          ['characters', 'worlds', 'presets', 'personas'].map((key) => h('button', {
            key,
            style: styles.tab(tab === key),
            onClick: () => setTab(key),
          }, t(key))),
        ),
        tab === 'characters' ? h(CharactersTab, { t }) : null,
        tab === 'worlds' ? h(WorldsTab, { t }) : null,
        tab === 'presets' ? h(PresetsTab, { t }) : null,
        tab === 'personas' ? h(PersonasTab, { t }) : null,
      )
    }

    let this_t = (key) => key

    // ---- composer binding control -----------------------------------------

    function BindingControl(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [open, setOpen] = useState(false)
      const [state, setState] = useState({ binding: null, characters: [], worlds: [], presets: [] })
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const [binding, characters, worlds, presets] = await Promise.all([
            api(`/sessions/${sessionId}/binding`),
            api('/characters'),
            api('/worlds'),
            api('/presets'),
          ])
          setState({
            binding,
            characters: characters.characters,
            worlds: worlds.worlds,
            presets: presets.presets,
          })
        } catch (caught) {
          setError(caught.message)
        }
      }, [sessionId])

      useEffect(() => { load() }, [load])

      const apply = async (patch) => {
        try {
          const body = await api(`/sessions/${sessionId}/binding`, { method: 'POST', body: JSON.stringify(patch) })
          setState((current) => ({ ...current, binding: body.binding }))
          setOpen(false)
        } catch (caught) {
          setError(caught.message)
        }
      }

      const current = state.binding
      const name = current && current.characterId
        ? (state.characters.find((item) => item.id === current.characterId) || {}).name || '…'
        : t('bindCharacter')

      const item = (label, active, onClick) => h('button', {
        key: label,
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
          background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          border: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
        },
        onClick,
      }, label)

      return h('div', { style: { position: 'relative' } },
        h('button', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, maxWidth: 180,
            border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
            borderRadius: 6, padding: '4px 8px', cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
          },
          onClick: () => setOpen(!open),
          title: t('bindCharacter'),
        },
        current && current.characterId ? h(Avatar, { id: current.characterId, name, size: 18 }) : null,
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name)),
        open ? h('div', {
          style: {
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 40,
            minWidth: 220, maxHeight: 320, overflowY: 'auto',
            background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,.28)',
          },
        },
        error ? h('div', { style: { ...styles.error, padding: 6 } }, error) : null,
        h('div', { style: { ...styles.muted, padding: '4px 10px' } }, t('bindCharacter')),
        item(t('none'), !current || !current.characterId, () => apply({ characterId: null })),
        state.characters.map((character) => item(
          character.name,
          current && current.characterId === character.id,
          () => apply({ characterId: character.id }),
        )),
        h('div', { style: { ...styles.muted, padding: '8px 10px 4px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, t('bindPreset')),
        state.presets.map((preset) => item(
          preset.name,
          current && current.presetId === preset.id,
          () => apply({ presetId: preset.id }),
        )),
        ) : null,
      )
    }

    // ---- apply ------------------------------------------------------------

    // One client entry that throws fails the entire web boot ("web boot: 1
    // entry did not activate"), so every optional registration is guarded: a
    // missing locale or a slot that is not declared yet must degrade to "no
    // panel", never to "the app does not start".
    function apply(ctx) {
      let t = (key) => key
      try {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-sillytavern: dictionaries')
      } catch (error) {
        console.error('[dsh-sillytavern] locale registration failed', error)
      }
      try {
        if (typeof ctx.locale?.bind === 'function') t = ctx.locale.bind(NS)
      } catch (error) {
        console.error('[dsh-sillytavern] locale binding failed', error)
      }

      const register = (slot, options, component) => {
        try {
          ctx.slots.inject(slot, () => ctx.slots.register(options, component))
        } catch (error) {
          console.error(`[dsh-sillytavern] cannot register ${slot}`, error)
        }
      }

      register('settings.section', {
        name: 'settings.section',
        id: 'sillytavern',
        order: 45,
        label: () => t('title'),
        locale: NS,
        inject: () => ({ t }),
      }, SettingsPage)

      // The conversation dock replaces the trip to Settings: one chip per
      // system plus the button that opens the full library panel.
      register('conversation.input.dock', {
        name: 'conversation.input.dock',
        id: 'st-library-dock',
        order: 30,
      }, (props) => h(ChatDock, { ...props, t }))

      // The panel is frame-wide so it is not clipped by the composer.
      register('shell.overlay', {
        name: 'shell.overlay',
        id: 'st-library-panel',
        order: 40,
        label: () => t('title'),
      }, () => h(LibraryPanel, { t }))

      register('conversation.input.left', {
        name: 'conversation.input.left',
        id: 'st-binding',
        order: 40,
      }, (props) => h(BindingControl, { ...props, t }))
    }

    // Test hook, not part of the plugin surface: the offline render test reads
    // the components from the exported function.
    apply.__components = {
      SettingsPage,
      CharactersTab,
      WorldsTab,
      PresetsTab,
      PersonasTab,
      ChatDock,
      LibraryPanel,
      BindingControl,
    }
    apply.__panel = panel

      return { inject: ['slots'], apply }
    } catch (error) {
      console.error('[dsh-sillytavern] client module failed to initialise', error)
      return { inject: ['slots'], apply() {} }
    }
  },
})
