import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'pin-note',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

// The `on` a test body receives (test's second argument may also be its options object).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type On = Parameters<Extract<Parameters<typeof test>[1], (...args: any[]) => unknown>>[1]

function setup(on: On) {
  // Each hook here stands for the engine beneath the plugin.
  on('tool.register', (_, e) => ({ value: { tool: `mcp__pin-note__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('clock.now', () => ({ value: 0 }))
  // A plugin store that outlives the test's session, as $.store does a restart.
  const store = new Map<string, unknown>()
  on('session.id', () => ({ value: 'session-1' }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

const cmd = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

const turn = (turnId: string, answer: string) => ({ answer, durationMs: 5, isAborted: false, turnId, reason: 'answer' }) as const

test('the answer to his own message is pinned; a peer turn does not replace it', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  await $.prompt.submit({ text: 'what is left?', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'what is left?', turnId: 't1' })
  await $.turn.complete(turn('t1', 'Three things are left.'))

  await $.prompt.submit({ text: 'peer says hi', origin: { kind: 'peer' }, wait: false })
  await $.turn.start({ text: 'peer says hi', turnId: 't2' })
  await $.turn.complete(turn('t2', 'Replied to the peer.'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown', text: /Three things are left/ }))?.text).toContain('Three things are left.')
  expect(await ui.find({ type: 'Markdown', text: /Replied to the peer/ })).toBeUndefined()
  await ui.unmount()
})

test('the agent pins a 3-point note, ticks two, and it disappears when all are done', async ($, on) => {
  setup(on)
  const added = await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'SMA questions', items: ['ghost draft id?', 'making asset?', 'retries?'] })
  expect(String(added.result)).toContain('Pinned n1')

  const ticked = await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_update', id: 'n1', done: [1, 2] })
  expect(String(ticked.result)).toContain('☐ retries?')

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /SMA questions/ }))?.text).toContain('1 of 3 open')
  await ui.unmount()

  const done = await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_update', id: 'n1', done: [3] })
  expect(String(done.result)).toContain('removed')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SMA questions/ })).toBeUndefined()
  await ui.unmount()
})

test('several notes show together, and the band steps aside for a Heads up', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Deploy waits on you', body: 'Approve PR 102' })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Open questions', items: ['a', 'b'] })
  await $.command.run(cmd('notes', '')) // list view

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Deploy waits on you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Open questions/ })).toBeDefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Deploy waits on you/ })).toBeUndefined()
  await ui.unmount()
})

test('note_list names the notes and dismiss removes one', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'First' })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Second' })
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).toContain('n2: Second')
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_dismiss', id: 'n1' })
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).not.toContain('First')
})

test('a long body shows its first lines in the list, and whole in the carousel', async ($, on) => {
  setup(on)
  const long = ['| a | b |', '|---|---|', '| 1 | 2 |', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8 [docs](https://example.com)'].join('\n')
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Big', body: long })

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Markdown', text: /line 8/ }))?.text).toContain('https://example.com')
  await band.unmount()

  await $.command.run(cmd('notes', '')) // list view
  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = await band.find({ type: 'Markdown', text: /line 4/ })
  expect(shown?.text).toContain('more lines')
  expect(shown?.text).not.toContain('line 8')
  await band.unmount()
})

test('/unpin n1 dismisses one note and /unpin alone clears all', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'First' })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Second' })
  expect((await $.command.run(cmd('unpin', 'n1'))).text).toContain('Dismissed n1')
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).toContain('n2: Second')
  await $.command.run(cmd('unpin', ''))
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).toBe('No pinned notes.')
})

test('a ruled line tops the band so it stands apart from the chat', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'One' })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Two' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1\/2/ }))?.text).toMatch(/^── 1\/2 · 1 more ▶ ─+$/)
  await ui.unmount()
})

test('questions asked one after another each get their own answer note, kept until dismissed', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  const asked: [string, string, string][] = [['t1', 'first question?', 'Answer one.'], ['t2', 'second question?', 'Answer two.']]
  for (const [id, q, a] of asked) {
    await $.prompt.submit({ text: q, origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: q, turnId: id })
    await $.turn.complete(turn(id, a))
  }
  const list = String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)
  expect(list).toContain('n1: first question?')
  expect(list).toContain('n2: second question?')

  await $.command.run(cmd('notes', '')) // list view
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /pinned · 2 answers/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Markdown', text: /Answer two/ }))?.text).toContain('Answer two.')
  await ui.unmount()

  await $.command.run(cmd('unpin', 'n1'))
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).not.toContain('first question?')
})

test('answers are not pinned unless /pin-answers is on: the agent decides', async ($, on) => {
  setup(on)
  await $.prompt.submit({ text: 'q?', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'q?', turnId: 't1' })
  await $.turn.complete(turn('t1', 'a.'))
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).toBe('No pinned notes.')
})

test('twenty answers in a row are all kept: nothing is removed without a dismiss', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  for (let i = 1; i <= 20; i++) {
    await $.prompt.submit({ text: `question ${i}?`, origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: `question ${i}?`, turnId: `t${i}` })
    await $.turn.complete(turn(`t${i}`, `answer ${i}`))
  }
  const list = String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)
  expect(list).toContain('n1: question 1?')
  expect(list).toContain('n20: question 20?')
})

test('a message handed to a running turn is paired with the turn it actually starts', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  // A peer turn runs; his question arrives during it but only starts its own turn afterwards.
  await $.prompt.submit({ text: 'peer ping', origin: { kind: 'peer' }, wait: false })
  await $.turn.start({ text: 'peer ping', turnId: 't1' })
  await $.prompt.submit({ text: 'can notes run in parallel?', origin: { kind: 'composer' }, turnId: 't1', wait: false })
  await $.turn.complete(turn('t1', 'Answered the peer.'))
  await $.turn.start({ text: 'can notes run in parallel?', turnId: 't2' })
  await $.turn.complete(turn('t2', 'Yes, two ways.'))
  const list = String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)
  expect(list).toContain('can notes run in parallel?\n  Yes, two ways.')
  expect(list).not.toContain('Answered the peer')
})

test('a question handed to a running turn and answered there joins that note\'s title', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  await $.prompt.submit({ text: 'run the sleep', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'run the sleep', turnId: 't1' })
  await $.prompt.submit({ text: 'what is 3 times 3?', origin: { kind: 'composer' }, turnId: 't1', wait: false })
  await $.turn.complete(turn('t1', 'done-sleeping, and 9.'))
  const list = String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)
  expect(list).toContain('n1: run the sleep · what is 3 times 3?')
})

test('a turn that pinned a note does not also pin its answer', async ($, on) => {
  setup(on)
  await $.command.run(cmd('pin-answers', 'on'))
  await $.prompt.submit({ text: 'ask me 2 things', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'ask me 2 things', turnId: 't1' })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Two things', items: ['a?', 'b?'] })
  await $.turn.complete(turn('t1', 'Pinned two questions: a? b?'))
  const list = String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)
  expect(list).toContain('n1: Two things')
  expect(list).not.toContain('Pinned two questions')
})

test('each note header names its own /unpin id', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Plan' })
  await $.command.run(cmd('notes', '')) // the /unpin hint is in the list view
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /unpin n1/ }))?.text).toContain('/unpin n1')
  await ui.unmount()
})

test('a cut never lands inside a table: it stops before it, or takes a short table whole', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Mid', body: ['Results:', '', '| Test | Result |', '|---|---|', '| a | ok |', '| b | ok |', '| c | ok |', '| d | ok |', '| e | ok |', 'after', 'more', 'end'].join('\n') })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Top', body: ['| x | y |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |', '| 7 | 8 |', '| 9 | 0 |', 'tail'].join('\n') })
  await $.command.run(cmd('notes', '')) // list view
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const mid = await ui.find({ type: 'Markdown', text: /Results:/ })
  expect(mid?.text).not.toContain('| Test |')
  expect(mid?.text).toContain('more lines')
  const top = await ui.find({ type: 'Markdown', text: /\| x \| y \|/ })
  expect(top?.text).toContain('| 9 | 0 |')
  expect(top?.text).not.toContain('tail')
  await ui.unmount()
})

test('the carousel shows one note whole; next, previous and dismiss move through them', async ($, on) => {
  setup(on)
  for (const title of ['One', 'Two', 'Three']) await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title, body: `${title} body` })
  const shows = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const body = (await ui.find({ type: 'Markdown' }))?.text
    const head = (await ui.find({ type: 'Text', text: /\d\/\d/ }))?.text
    await ui.unmount()
    return { body, head }
  }
  expect((await shows()).body).toBe('One body')
  expect((await $.command.run(cmd('notes-next', ''))).text).toBe('')
  expect((await shows()).head).toContain('◀ 2/3 · 1 more ▶')
  await $.command.run(cmd('notes-next', ''))
  await $.command.run(cmd('notes-next', '')) // stays on the last
  expect((await shows()).body).toBe('Three body')
  await $.command.run(cmd('notes-prev', ''))
  expect((await shows()).body).toBe('Two body')
  expect((await $.command.run(cmd('notes-dismiss', ''))).text).toBe('')
  expect((await shows()).body).toBe('Three body') // the next one slides in
})

test('notes are saved under the session id and come back when the chat starts again', async ($, on) => {
  const store = setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Survives', body: 'kept' })
  const kept = store.get('notes:session-1') as { notes: { title: string }[] }
  expect(kept.notes.map(n => n.title)).toEqual(['Survives'])

  // A restart: the session's state is empty again, the store is not.
  await $.command.run(cmd('unpin', ''))
  store.set('notes:session-1', kept)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(String((await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_list' })).result)).toContain('Survives')
})

test('a single note shows without a counter or an index line', async ($, on) => {
  setup(on)
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Only one' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\[n1\]/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1\/1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /L next/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /notes list/ })).toBeDefined()
  await ui.unmount()
})

test('quote puts only the shown note\'s id into the input', async ($, on) => {
  setup(on)
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  await $.tool.run({ tool_use_id: 'tu', tool: 'mcp__pin-note__note_add', title: 'Plan', body: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'), items: ['ship it?'] })
  await $.command.run(cmd('notes-quote', ''))
  expect(filled[0]).toBe('[n1] ')
  expect((await $.command.run(cmd('notes-quote', 'n9'))).text).toBe('No note n9.')
})

test('a newer installed pin-note reloads the plugins once, through the command API', async ($, on) => {
  setup(on)
  const clock = { advance: async (_ms: number) => {} }
  void clock
  let installed = '1.0.0'
  const runs: string[] = []
  on('fs.read', (_, e) => {
    if (String(e.path).endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ version: installed }) }
    throw new Error('ENOENT')
  })
  on('command.run', (_, e) => {
    runs.push(e.command)
    return { text: '' }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  installed = '1.0.1'
  expect(runs).toEqual([])
})
