# Updates from your computer on the charm

The charm can show what your computer is doing as a second screen: text you push, Claude Code's
answer when it finishes, an orange face when it needs you, and the tool it is running while it
works. Updates go to an unlocked charm without starting a turn with the charm's own agent, and
nothing is spoken.

The charm keeps a text update on its report page: scroll it with a finger; a press or a tap brings
the face back. A face update (a notification or a tool line) stays until the next update or a press.

## Push text yourself

```bash
opencharm show "Built the firmware. Flashing next."
git log --oneline -5 | opencharm show --stdin
opencharm show --charm peter "Done for today."
```

- Without `--charm`, the newest unlocked charm is used.
- `--stdin` reads the text from a pipe, so any command's output can be shown.
- A report holds up to 12,000 UTF-8 bytes (the charm keeps up to 32 KB); the charm's own report
  page scrolls through it.
- `opencharm dev face peter working "Compiling"` and `opencharm dev say peter "..."` still exist for
  a face line and speech.

## Claude Code hooks

Claude Code can run a command at points in its turn. Add these to your **user** settings
(`~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows) and restart Claude
Code or open a new session, so the hooks are loaded:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "opencharm hook", "timeout": 10 }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "opencharm hook", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "opencharm hook", "timeout": 10 }
        ]
      }
    ]
  }
}
```

What each does:

| Event          | On the charm                                                                        |
| -------------- | ----------------------------------------------------------------------------------- |
| `Stop`         | Claude's last answer, from the session transcript, as one scrollable report         |
| `Notification` | The orange "it needs you" face and the notification's message (permission, waiting) |
| `PreToolUse`   | A working face and the tool with its file or command, e.g. `Bash · npm test`        |

If charmd runs with a config of its own (the desktop app starts one; `opencharm serve --config …`
does too), pass it to the hook: `opencharm hook --config <file>`. Pin a charm with
`opencharm hook --charm peter` if more than one is unlocked. A hook never fails Claude's turn: a
charm that is off, locked, busy or too old for reports is ignored.

The hook shows the transcript's last assistant text exactly as written (markdown included). It
doesn't summarise or call a model.
