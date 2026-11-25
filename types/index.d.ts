export type NoteItem = { text: string; done: boolean }
// at: when it was pinned; updated: when it last changed (absent until the first change).
// kind 'answer': the reply to the person's own message, pinned so it can be read later; question is what they asked.
export type Note = { id: string; title: string; body: string; items: NoteItem[]; by: 'agent' | 'you'; at: number; updated?: number; kind?: 'answer'; question?: string; asked?: string[]; provisional?: string[] }

declare module 'claude-code' {
  interface PluginState {
    'pin-note': { notes: Note[]; nextId: number; pinAnswers: boolean; expanded: boolean; cursor: string | null }
  }
}
