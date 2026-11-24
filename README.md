# pin-note

A Claude Code plugin that pins notes in a band just above the input. They stay put while the chat scrolls, so an answer or a list of questions doesn't get buried under channel messages and background-task output.

## What it does

- **Agent-curated notes:** the agent pins a short summary when an answer is worth coming back to, and a numbered list when it asks you several things. Reply to a few points and it ticks them off; the note goes away when every point is done.
- **Quoting:** a note's id in your message (like `[n3]`) tells the agent which note you mean.
- **Carousel:** one note at a time in full, or `/notes` for a list of all of them.
- **Saved per chat:** notes come back after a restart or resume (kept 14 days).
- **Self-update:** once a chat is idle, it picks up a newer installed version by itself.

The agent gets tools to manage notes: `note_add`, `note_update`, `note_dismiss` and `note_list`.

## Keys

The band's buttons use the diff viewer's actions, so binding chords to those actions in `~/.claude/keybindings.json` makes them work from the prompt:

```json
{
  "bindings": [
    {
      "context": "Global",
      "bindings": {
        "ctrl+alt+j": "diff:nextFile",
        "ctrl+alt+k": "diff:previousFile",
        "ctrl+alt+q": "app:cycleDiffBase",
        "ctrl+alt+x": "diff:dismiss"
      }
    }
  ]
}
```

| Keys | What it does |
|---|---|
| ⌃⌥J / ⌃⌥K | next / previous note |
| ⌃⌥Q | put the note's id (`[n3]`) in the input |
| ⌃⌥X | dismiss the note on screen |

## Commands

| Command | What it does |
|---|---|
| `/notes` | switch between one note at a time and the list |
| `/unpin n3` | remove a note |
| `/notes-quote n3` | put a note's id in the input |
| `/pin-answers on` | also pin every answer automatically (off by default) |

## Install

```
/plugin marketplace add wise-toddler/shivansh-mods
/plugin install pin-note@shivansh-mods
```

## Test

```
claude plugin test .
```
