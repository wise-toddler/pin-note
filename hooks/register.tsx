import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

type Engine = EngineInterface

import type { Note } from '../types'

// What the band shows, kept per session (it survives a plugin reload).
const notesAtom = atom({ plugin: 'pin-note', key: 'notes' } as const, [])
const nextIdAtom = atom({ plugin: 'pin-note', key: 'nextId' } as const, 1)
// Pinning every answer is off by default (24 Nov: he prefers the agent to choose); /pin-answers on brings it back.
const pinAnswersAtom = atom({ plugin: 'pin-note', key: 'pinAnswers' } as const, false)
// The band is a carousel (one note, whole) by default; /notes switches to the list of every note's first lines.
const expandedAtom = atom({ plugin: 'pin-note', key: 'expanded' } as const, false) // true = list view
// The note the carousel shows; when it is gone, the one in its place (or the last).
const cursorAtom = atom({ plugin: 'pin-note', key: 'cursor' } as const, null)

// Only turns the person started (typed at the prompt or sent from the phone) pin their answer;
// peers, background tasks, crons and other plugins never replace it.
const PERSON = new Set(['composer', 'bridge'])
// The person's recent messages, and the turns they started. A message is paired with the turn whose
// starting text it is: one typed while a turn runs is handed to that turn but often starts its own after.
const turns = { asked: [] as string[], person: new Map<string, string[]>(), mid: new Map<string, string[]>(), noted: false }

// Everything is a typed command or a chord bound to one in keybindings.json (ctrl+alt+k/j/x, clear of Rectangle's
// ctrl+alt shortcuts): band keys need ctrl+x tab, which doesn't reach Claude in Orca.
const MAX_NOTES = 16 // the agent's own notes; answers have no limit
const BODY_LINES = 6 // a note's body in the band; the rest opens in the pane
const ANSWER_LINES = 4 // an answer's first lines in the band; o opens it whole

const GUIDE = `Pinned notes (pin-note): the person sees a band of notes above their input that stays visible while peer messages and background tasks scroll the chat. You decide what goes there; nothing is pinned for you. Pin what the person must not miss or will want to come back to:
- An answer worth returning to (results, findings, a decision they must make, steps they must take, or anything they asked while you were busy with something else): pin a short summary with mcp__pin-note__note_add, titled with their question in a few words, the body only the key points (at most about 8 lines; links and small tables are fine). The full answer stays in the chat.
- When you ask the person several questions, or list points they need to reply to, pin one note with one item per point. When they answer some, tick those with note_update (done: [item numbers]) and leave the rest; a note whose items are all done disappears by itself.
- Keep notes current: edit a note when its points change, and dismiss it (note_dismiss) once it no longer applies. Call note_list to see the notes and their ids.
- When the person's message holds a note id in brackets, like [n3], they are replying about that note: read it with note_list.
- Don't pin routine replies, acknowledgements or progress updates.`

const TOOLS = [
  {
    name: 'note_add',
    description: 'Pin a note above the person\'s input: a title, an optional body, and optional items (questions or points they should reply to, one per item). Returns the note id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, under 60 characters.' },
        body: { type: 'string', description: 'Optional markdown under the title: links, tables, code blocks and long text are fine.' },
        items: { type: 'array', items: { type: 'string' }, description: 'Optional numbered points, one per item (markdown links allowed).' },
      },
      required: ['title'],
    },
    isDeferred: false,
  },
  {
    name: 'note_update',
    description: 'Change a pinned note: tick items the person answered (done, 1-based numbers), untick them, add or remove items, or edit the title or body. A note whose items are all done is removed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        done: { type: 'array', items: { type: 'integer' } },
        undone: { type: 'array', items: { type: 'integer' } },
        add_items: { type: 'array', items: { type: 'string' } },
        remove_items: { type: 'array', items: { type: 'integer' } },
      },
      required: ['id'],
    },
    isDeferred: false,
  },
  {
    name: 'note_dismiss',
    description: 'Remove a pinned note that no longer applies.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    isDeferred: false,
  },
  {
    name: 'note_list',
    description: 'List the pinned notes with their ids and numbered items (✓ = done).',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
] as const

type Args = Record<string, unknown>

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
}

function describe(n: Note): string {
  const items = n.items.map((it, i) => `  ${i + 1}. ${it.done ? '✓' : '☐'} ${it.text}`).join('\n')
  return `${n.id}: ${n.title}${n.body ? `\n  ${n.body}` : ''}${items ? `\n${items}` : ''}`
}

// Notes outlive a restart or reboot: each chat's notes are kept in the plugin store under its session id
// (the same id a resume comes back with); stores left untouched for 14 days are cleared at start.
type Saved = { notes: Note[]; nextId: number; cursor: string | null; at: number }
const saved = { key: '' }
const KEEP_MS = 14 * 24 * 60 * 60_000

async function save($: Engine) {
  if (!saved.key) return
  const data: Saved = { notes: await read($, notesAtom), nextId: await read($, nextIdAtom), cursor: await read($, cursorAtom), at: await $.clock.now() }
  await $.store.set(saved.key, data).catch(() => undefined)
}

async function restore($: Engine) {
  saved.key = `notes:${await $.session.id()}`
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('notes:') || key === saved.key) continue
    const old = (await $.store.get(key)) as Saved | undefined
    if (!old || now - old.at > KEEP_MS) await $.store.delete(key)
  }
  const mine = (await $.store.get(saved.key)) as Saved | undefined
  if (!mine || (await read($, notesAtom)).length > 0) return
  await update($, notesAtom, () => mine.notes)
  await update($, nextIdAtom, () => mine.nextId)
  await update($, cursorAtom, () => mine.cursor)
}

async function addNote($: Engine, title: string, body: string, items: string[], by: Note['by']): Promise<Note | string> {
  const notes = await read($, notesAtom)
  if (notes.filter(n => n.kind !== 'answer').length >= MAX_NOTES) return `There are already ${MAX_NOTES} notes; dismiss one first.`
  const id = `n${await read($, nextIdAtom)}`
  await update($, nextIdAtom, n => n + 1)
  const note: Note = { id, title: title.slice(0, 80), body, items: items.map(text => ({ text, done: false })), by, at: await $.clock.now() }
  await update($, notesAtom, ns => [...ns, note])
  await save($)
  return note
}

function questionOf(asked: string[]): string {
  const short = (q: string) => {
    const line = (q.split('\n').find(l => l.trim()) ?? q).trim()
    return asked.length > 1 && line.length > 50 ? `${line.slice(0, 48)}…` : line
  }
  return asked.map(short).join(' · ')
}

// A message first counted with a running turn later started its own: take it back from the older note,
// and drop that note when nothing the person asked is left in it.
async function reclaim($: Engine, started: string[]) {
  await update($, notesAtom, ns =>
    ns.flatMap(n => {
      if (!n.provisional?.some(q => started.includes(q))) return [n]
      const asked = (n.asked ?? []).filter(q => !started.includes(q))
      if (asked.length === 0) return []
      const question = questionOf(asked)
      return [{ ...n, asked, provisional: n.provisional.filter(q => !started.includes(q)), question, title: question.slice(0, 90) }]
    }),
  )
  await save($)
}

async function addAnswer($: Engine, asked: string[], answer: string, provisional: string[] = []) {
  const question = questionOf(asked)
  const id = `n${await read($, nextIdAtom)}`
  await update($, nextIdAtom, n => n + 1)
  const note: Note = { id, title: question.slice(0, 90), body: answer, items: [], by: 'agent', at: await $.clock.now(), kind: 'answer', question, asked, provisional }
  // Answers are never dropped by themselves: one goes only when the person dismisses it (the band scrolls when many pile up).
  await update($, notesAtom, ns => [...ns, note])
  await save($)
}

async function updateNote($: Engine, a: Args): Promise<string> {
  const notes = await read($, notesAtom)
  const note = notes.find(n => n.id === a.id)
  if (!note) return `No note ${String(a.id)}. Notes:\n${notes.map(describe).join('\n') || '(none)'}`
  let items = note.items.map(it => ({ ...it }))
  for (const [list, done] of [[numbers(a.done), true], [numbers(a.undone), false]] as const) {
    for (const i of list) {
      const item = items[i - 1]
      if (item) item.done = done
    }
  }
  const removed = new Set(numbers(a.remove_items))
  items = items.filter((_, i) => !removed.has(i + 1))
  items.push(...strings(a.add_items).map(text => ({ text, done: false })))
  const next: Note = {
    ...note,
    title: typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 80) : note.title,
    body: typeof a.body === 'string' ? a.body : note.body,
    items,
    updated: await $.clock.now(),
  }
  if (items.length > 0 && items.every(it => it.done)) {
    await update($, notesAtom, ns => ns.filter(n => n.id !== note.id))
    await save($)
    return `All points of ${note.id} are done, so the note was removed.`
  }
  await update($, notesAtom, ns => ns.map(n => (n.id === note.id ? next : n)))
  await save($)
  return describe(next)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A note's time for its header, in local time: "8:51 PM" today, "Nov 24, 8:51 PM" on another day.
function stamp(ms: number, now: number): string {
  const d = new Date(ms)
  const time = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  return d.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`
}

async function dismissNote($: Engine, id: string): Promise<string> {
  const notes = await read($, notesAtom)
  if (!notes.some(n => n.id === id)) return `No note ${id}.`
  await update($, notesAtom, ns => ns.filter(n => n.id !== id))
  await save($)
  return `Dismissed ${id}.`
}

// The first lines of a long text for the band, never cut inside a table or a code block
// (a half table draws as an empty grid): stop before the block, or take a short block whole.
const isRow = (l: string | undefined) => /^\s*\|/.test(l ?? '')
const isFence = (l: string | undefined) => /^\s*```/.test(l ?? '')

function head(text: string, lines: number): { text: string; more: number } {
  const all = text.trimEnd().split('\n')
  if (all.length <= lines) return { text: all.join('\n'), more: 0 }
  let cut = lines
  const fences = all.slice(0, cut).map((l, i) => (isFence(l) ? i : -1)).filter(i => i >= 0)
  if (fences.length % 2 === 1) {
    const start = fences[fences.length - 1] ?? 0
    const end = all.findIndex((l, i) => i > start && isFence(l))
    cut = start > 0 ? start : end >= 0 && end < lines + 12 ? end + 1 : cut
  } else if (isRow(all[cut - 1]) && isRow(all[cut])) {
    let start = cut - 1
    while (start > 0 && isRow(all[start - 1])) start--
    let end = cut
    while (end < all.length && isRow(all[end])) end++
    cut = start > 0 ? start : end <= lines + 12 ? end : cut
  }
  const shown = all.slice(0, Math.max(1, cut)).join('\n').trimEnd()
  return { text: shown, more: all.length - Math.max(1, cut) }
}


// The carousel's current index: the cursor's note, else the first.
function currentIndex(notes: Note[], cursor: string | null): number {
  const i = notes.findIndex(n => n.id === cursor)
  return i >= 0 ? i : 0
}

async function step($: Engine, by: number): Promise<string> {
  const notes = await read($, notesAtom)
  if (notes.length === 0) return 'No pinned notes.'
  const i = Math.min(notes.length - 1, Math.max(0, currentIndex(notes, await read($, cursorAtom)) + by))
  const id = notes[i]?.id ?? null
  await update($, cursorAtom, () => id)
  await save($)
  return `Showing ${id} (${i + 1} of ${notes.length}).`
}

async function dismissCurrent($: Engine): Promise<string> {
  const notes = await read($, notesAtom)
  if (notes.length === 0) return 'No pinned notes.'
  const i = currentIndex(notes, await read($, cursorAtom))
  const gone = notes[i]
  if (!gone) return 'No pinned notes.'
  const next = notes[i + 1] ?? notes[i - 1]
  await update($, cursorAtom, () => next?.id ?? null)
  return dismissNote($, gone.id)
}

// Quoting puts only the note's id in the person's input ([n3]); the guide tells the agent what it refers to.
async function quoteNote($: Engine, id?: string): Promise<string> {
  const notes = await read($, notesAtom)
  const n = id ? notes.find(x => x.id === id) : notes[currentIndex(notes, await read($, cursorAtom))]
  if (!n) return id ? `No note ${id}.` : 'No pinned notes.'
  await $.prompt.fill({ text: `[${n.id}] `, mode: 'insert' })
  return ''
}

async function clearAll($: Engine) {
  await update($, notesAtom, () => [])
  await save($)
}

// Self-update: when a newer pin-note is installed, run /reload-plugins once the chat is idle, so every open chat
// picks it up without anyone typing into its input box (the same as anti-hung).
const UPDATE_CHECK_MS = 5 * 60_000
const self = { loaded: '', asked: false, timer: undefined as Timer | undefined }

async function readJson($: Engine, path: string): Promise<{ version?: string; plugins?: Record<string, { version?: string }[]> } | undefined> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

// The newest version on disk: the registry's entry when running from the plugin cache, else the loaded folder's manifest.
async function installedVersion($: Engine): Promise<string | undefined> {
  const own = (await readJson($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version
  const registry = await readJson($, `${$.plugin.root}/../../../../installed_plugins.json`)
  const entry = Object.entries(registry?.plugins ?? {}).find(([key]) => key.startsWith(`${$.plugin.name}@`))?.[1]
  return entry?.map(e => e.version).find(v => v !== undefined && v !== own) ?? own
}

async function checkForUpdate($: Engine) {
  if (self.asked || !self.loaded) return
  const version = await installedVersion($)
  if (!version || version === self.loaded) return
  self.asked = true // once per loaded copy: the reload brings a fresh module
  await $.command.run({ command: 'reload-plugins' }).catch(() => {
    self.asked = false
  })
}

async function startUpdateChecks($: Engine) {
  self.loaded = (await readJson($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version ?? ''
  self.timer?.cancel()
  self.timer = $.clock.every(UPDATE_CHECK_MS, () => {
    void checkForUpdate($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await restore($).catch(() => undefined)
    await startUpdateChecks($).catch(() => undefined)
    for (const tool of TOOLS) await $.tool.register({ ...tool, inputSchema: { ...tool.inputSchema } })
    await $.command.register({ name: 'unpin', description: 'Clear pinned notes: /unpin n2 for one, /unpin for all', argumentHint: '[note id]', immediate: true })
    await $.command.register({ name: 'notes', description: 'Switch the pinned notes between one-at-a-time and the list of all', immediate: true })
    await $.command.register({ name: 'notes-next', description: 'Pinned notes: show the next one (ctrl+alt+k)', immediate: true })
    await $.command.register({ name: 'notes-prev', description: 'Pinned notes: show the previous one (ctrl+alt+j)', immediate: true })
    await $.command.register({ name: 'notes-dismiss', description: 'Pinned notes: dismiss the one shown (ctrl+alt+x)', immediate: true })
    await $.command.register({ name: 'notes-quote', description: 'Put the shown note\'s id ([n3]) into your input to reply about it (ctrl+alt+q)', argumentHint: '[note id]', immediate: true })
    await $.command.register({ name: 'pin-answers', description: 'Also pin every answer to your messages automatically (off by default): on or off', argumentHint: 'on|off', immediate: true })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin === undefined || PERSON.has(e.origin.kind)
    if (isPerson && !e.command && e.text.trim()) {
      turns.asked = [...turns.asked, e.text.trim()].slice(-20)
      // Handed to a running turn: it may be answered there, or start its own turn afterwards.
      if (e.turnId) turns.mid.set(e.turnId, [...(turns.mid.get(e.turnId) ?? []), e.text.trim()])
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (e.agentId === undefined) turns.noted = false
    if (e.agentId === undefined && text) {
      const started = turns.asked.filter(q => text.includes(q) || q.includes(text))
      if (started.length > 0) {
        turns.person.set(e.turnId, started)
        turns.asked = turns.asked.filter(q => !started.includes(q))
        await reclaim($, started)
      }
    }
    return next(e)
  })

  // Every answer to the person's own message becomes a note headed by their question, so they can ask
  // one thing after another and read the answers later; a note goes only when they dismiss it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const started = turns.person.get(e.turnId) ?? []
      const mid = (turns.mid.get(e.turnId) ?? []).filter(q => !started.includes(q))
      turns.person.delete(e.turnId)
      turns.mid.delete(e.turnId)
      // A turn where the agent pinned or edited a note already put what matters in the band: don't pin its answer too.
      if ((started.length || mid.length) && !turns.noted && e.reason === 'answer' && e.answer.trim() && (await read($, pinAnswersAtom))) {
        await addAnswer($, [...started, ...mid], e.answer.trim(), mid)
      }
    }
    return result
  })

  on('tool.run', { tool: 'mcp__pin-note__note_add' }, async ($, e) => {
    turns.noted = true
    const a = e as unknown as Args
    const made = await addNote($, String(a.title ?? 'Note'), typeof a.body === 'string' ? a.body : '', strings(a.items), 'agent')
    return { result: typeof made === 'string' ? made : `Pinned ${made.id}.\n${describe(made)}` }
  })
  on('tool.run', { tool: 'mcp__pin-note__note_update' }, async ($, e) => {
    turns.noted = true
    return { result: await updateNote($, e as unknown as Args) }
  })
  on('tool.run', { tool: 'mcp__pin-note__note_dismiss' }, async ($, e) => ({ result: await dismissNote($, String((e as unknown as Args).id)) }))
  on('tool.run', { tool: 'mcp__pin-note__note_list' }, async $ => {
    const notes = await read($, notesAtom)
    return { result: notes.map(describe).join('\n') || 'No pinned notes.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'pin-note', scope: 'session', text: GUIDE }] }
  })

  on('command.run', { command: 'unpin' }, async ($, e) => {
    const id = e.args.trim()
    if (id) return { text: await dismissNote($, id) }
    await clearAll($)
    return { text: 'Cleared every pinned note.' }
  })

  on('command.run', { command: 'pin-answers' }, async ($, e) => {
    const enabled = e.args.trim() !== 'off'
    await update($, pinAnswersAtom, () => enabled)
    return { text: enabled ? 'Answers to your messages will be pinned as notes.' : 'Answers will no longer be pinned.' }
  })

  // The keys' commands answer with nothing: the band already shows what changed, so the chat stays clean.
  on('command.run', { command: 'notes-next' }, async $ => {
    await step($, 1)
    return { text: '' }
  })
  on('command.run', { command: 'notes-prev' }, async $ => {
    await step($, -1)
    return { text: '' }
  })
  on('command.run', { command: 'notes-quote' }, async ($, e) => {
    const said = await quoteNote($, e.args.trim() || undefined)
    return { text: said }
  })
  on('command.run', { command: 'notes-dismiss' }, async $ => {
    await dismissCurrent($)
    return { text: '' }
  })

  // The key commands leave no rows in the chat: neither their output row nor the echo of the typed command.
  const QUIET = /^\/?notes-(next|prev|dismiss|quote)\s*$/
  for (const command of ['notes-next', 'notes-prev', 'notes-dismiss', 'notes-quote']) {
    on('ui.render', { component: 'CommandOutput', props: { command } }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const text = String((e.props as { text?: unknown }).text ?? '').trim()
    if (!QUIET.test(text) && !/<command-name>\/?notes-(next|prev|dismiss)<\/command-name>/.test(text)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('command.run', { command: 'notes' }, async $ => {
    const expanded = !(await read($, expandedAtom))
    await update($, expandedAtom, () => expanded)
    return { text: expanded ? 'List view: every note\'s first lines; /notes again for one note at a time.' : 'Carousel: one note at a time, in full (ctrl+alt+k next, ctrl+alt+j previous, ctrl+alt+x dismiss).' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A "Heads up" (or any survey) holds the band: step aside until it is answered.
    if (e.props.hasSurvey) return next(e)
    const notes = await read($, notesAtom)
    if (notes.length === 0) return next(e)
    const isList = await read($, expandedAtom)
    const at = currentIndex(notes, await read($, cursorAtom))
    const now = await $.clock.now()

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const answers = notes.filter(n => n.kind === 'answer').length
    const others = notes.length - answers
    // A ruled line on top so the band stands apart from the chat above it, and thin ones between notes.
    const width = Math.max(20, e.props.bodyColumns)
    const rule = (label: string) => `── ${label} ${'─'.repeat(Math.max(0, width - label.length - 4))}`
    const thin = '┄'.repeat(Math.min(width, 60))
    const count = [answers ? `${answers} answer${answers === 1 ? '' : 's'}` : '', others ? `${others} note${others === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')

    // One note: its header, its body (whole, or its first lines in the list) and its items.
    const drawNote = (n: Note, whole: boolean) => {
      const open = n.items.filter(it => !it.done).length
      const isAnswer = n.kind === 'answer'
      const body = whole ? { text: n.body, more: 0 } : head(n.body, isAnswer ? ANSWER_LINES : BODY_LINES)
      return (
        <Box key={n.id} flexDirection="column">
          <Box>
            <Text bold color={isAnswer ? 'cyan' : 'yellow'} wrap="truncate-end">
              {isAnswer ? '❓' : '📌'} {n.id} · {n.title}
              {n.items.length > 0 ? ` (${open} of ${n.items.length} open)` : ''}
            </Text>
            <Text dimColor> · {n.updated !== undefined ? `updated ${stamp(n.updated, now)}` : `added ${stamp(n.at, now)}`}</Text>
            {whole ? null : <Text dimColor> · /unpin {n.id}</Text>}
          </Box>
          {n.body ? <Markdown key={`body-${n.id}`} text={body.text + (body.more ? `\n\n*… ${body.more} more line${body.more === 1 ? '' : 's'} · /notes for one at a time, in full*` : '')} /> : null}
          {n.items.map((it, j) =>
            it.done ? (
              <Box key={`${n.id}-${j}`}>
                <Text dimColor strikethrough wrap="wrap">
                  {'  ✓ '}
                  {j + 1}. {it.text}
                </Text>
              </Box>
            ) : (
              <Markdown key={`${n.id}-${j}`} text={`  ☐ ${j + 1}. ${it.text}`} />
            ),
          )}
        </Box>
      )
    }

    if (isList) {
      return (
        <Box flexDirection="column">
          <Text color="yellow" dimColor>
            {rule(`📌 pinned · ${count} · list`)}
          </Text>
          {notes.map((n, i) => (
            <Box key={`row-${n.id}`} flexDirection="column">
              {i > 0 ? <Text dimColor>{thin}</Text> : null}
              {drawNote(n, false)}
            </Box>
          ))}
          <Text dimColor>/unpin n… dismisses one · /unpin clears all · /notes back to one at a time</Text>
        </Box>
      )
    }

    // The carousel: a plain rule (with a counter when there are several), an index line only when there is
    // more than one note, then the note whole, and a short key line.
    const current = notes[at] ?? notes[0]
    const many = notes.length > 1
    const after = notes.length - 1 - at
    const counter = many ? `${at > 0 ? '◀ ' : ''}${at + 1}/${notes.length}${after > 0 ? ` · ${after} more ▶` : ''}` : ''
    const strip = notes.map((n, i) => (i === at ? `[${n.id}]` : n.id)).join(' · ')
    return (
      <Box flexDirection="column">
        <Text color="yellow" dimColor>
          {counter ? rule(counter) : '─'.repeat(width)}
        </Text>
        {many ? (
          <Text dimColor wrap="truncate-end">
            {strip}
          </Text>
        ) : null}
        {current ? drawNote(current, true) : null}
        {/* Buttons tied to the diff viewer's actions: ctrl+alt+k/j/x are bound to them in keybindings.json, and with no
            diff open the band's button takes the chord, so a key press changes the band without a command row in the chat. */}
        <Box>
          {many ? <Button key="prev" label="⌃⌥J prev" plain action="diff:previousFile" onPress={() => step($, -1)} /> : null}
          {many ? <Text dimColor> · </Text> : null}
          {many ? <Button key="next" label="⌃⌥K next" plain action="diff:nextFile" onPress={() => step($, 1)} /> : null}
          {many ? <Text dimColor> · </Text> : null}
          <Button key="quote" label="⌃⌥Q quote" plain action="app:cycleDiffBase" onPress={() => quoteNote($)} />
          <Text dimColor> · </Text>
          <Button key="dismiss" label="⌃⌥X dismiss" plain action="diff:dismiss" onPress={() => dismissCurrent($)} />
          {/* ctrl+alt+h is bound to the engine's own abovePrompt:toggle, which hides the whole band and shows a line to bring it back. */}
          <Text dimColor> · ⌃⌥H hide · /notes list</Text>
        </Box>
      </Box>
    )
  })
}
