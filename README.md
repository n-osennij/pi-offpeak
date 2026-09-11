# pi-offpeak

Off-peak guard for [pi](https://pi.dev) agent. Blocks model requests outside your
allowed (cheap-rate) time windows, so an overnight agent run stops itself before
peak pricing kicks in instead of burning 2× tokens.

Built for DeepSeek's day/night rates (peak 01–04 & 06–10 UTC Mon–Fri, off-peak
everything else), but the schedule is fully configurable.

## How it blocks (4 layers)

1. **`input`** — new prompts during peak are swallowed: no LLM call happens at all.
2. **`turn_start`** — an autonomous multi-turn run crossing into peak is aborted
   at the next turn boundary.
3. **`tool_call`** — tool side-effects during peak are blocked with `terminate`.
4. **Watchdog (every 15 s)** — aborts a long in-flight run exactly when a peak
   window starts (your 04:00 deadline).

Status bar shows `🌙 off-peak ✓2h05m` / `⛔ peak ✓45m` with a live countdown to
the next transition (or `offpeak OFF` / `offpeak bypass (model)`).

## Install

```sh
pi install npm:pi-offpeak
```

What install does (and doesn't):

- Registers the package source in `~/.pi/agent/settings.json` (add `-l`
  for project-local `.pi/settings.json`). A local path is referenced,
  not copied.
- The extension (`./extensions/offpeak.ts` from the `pi` manifest) loads
  automatically from then on — including inside subagent child processes
  (that's why `pi install` is preferred over `-e`; see Subagents).
- It does **not** create any `pi-offpeak.json`. The manifest format has
  no config-deployment mechanism — and none is needed: with no config
  file the guard runs on built-in DeepSeek off-peak defaults and tells
  you so on startup
  (`pi-offpeak: no config file found — using built-in … defaults`).
  Create a config file only to *customize* (copy
  [`pi-offpeak.example.json`](./pi-offpeak.example.json) to
  `~/.pi/agent/pi-offpeak.json`).

## Config

Two JSON files, project overlays global, missing pieces fall back to built-in
DeepSeek off-peak defaults:

| Scope   | Path                              |
| ------- | --------------------------------- |
| Global  | `<agentDir>/pi-offpeak.json` (`~/.pi/agent/pi-offpeak.json`) |
| Project | `<project>/.pi/pi-offpeak.json` (wins on conflict, needs trust) |

```jsonc
{
  "timezone": "UTC",          // IANA zone, e.g. "Europe/Moscow". Invalid -> UTC + warning
  "enabled": true,            // master switch (also toggled by /offpeak on|off)
  "allow": [                  // ALLOWED windows; everything else is peak/blocked
    { "days": ["mon","tue","wed","thu","fri"], "from": "00:00", "to": "01:00" },
    { "days": ["mon","tue","wed","thu","fri"], "from": "04:00", "to": "06:00" },
    { "days": ["mon","tue","wed","thu","fri"], "from": "10:00", "to": "24:00" },
    { "days": ["sat","sun"], "from": "00:00", "to": "24:00" }
  ],
  "models": ["*"],            // which models to guard: "*", "deepseek/*", "provider/id", "bare-id"
  "blockMessage": "Off-peak guard: model requests are blocked now (peak rates). Resumes {until}.",
  "abortInFlight": true,      // abort a running agent when peak starts
  "resumeAfterPeak": false,   // true = auto-continue interrupted work when peak ends
  "resumeMessage": "Off-peak rates are back in effect. Continue the interrupted task where you left off.",
  "profiles": [              // per-model schedules (optional); first match wins
    {
      "name": "flash",     // shown in the status bar: `🌙 off-peak ✓2h [flash]`
      "models": ["*flash*"],
      "allow": [             // REPLACES the default windows for these models
        { "days": ["weekdays"], "from": "00:00", "to": "01:00" }
      ],
      "timezone": "UTC"    // omit = inherit top-level; any other key overridable too
    }
  ]
}
```

Rules:

- `days`: `mon..sun` (case-insensitive). Aliases: `daily`, `weekdays`,
  `weekend`. Omit or `[]` = every day.
- `from`/`to`: `HH:MM`, `to` exclusive, `24:00` allowed. `to <= from` means
  **overnight**, spilling into the next day (e.g. `22:00 → 02:00` on `fri`
  covers Sat 00:00–02:00).
- `{until}` in `blockMessage` is replaced with the resume time
  (`at 04:00 UTC, in 2h05m`).
- `models` supports `*`, `provider/*`, `provider/id`, bare `id`. Unknown current
  model + non-wildcard list = guarded (fail-closed); `[]`/`["*"]` = guard all.
  With `profiles`, each profile has its own `models` (same syntax).
- Broken rules are skipped with a startup warning; with zero valid rules
  everything is blocked while the guard is on (fail-closed).

## Per-model schedules (profiles)

One schedule rarely fits all models: DeepSeek bills peak 01–04 & 06–10 UTC,
but a free-tier model (or a different provider) may be fine 24/7. Give each
pricing its own schedule:

```jsonc
{
  "timezone": "UTC",
  "allow": [ /* …DeepSeek off-peak windows… */ ],
  "models": ["*"],
  "profiles": [
    {
      "name": "deepseek",
      "models": ["*deepseek*"],
      "allow": [ /* …DeepSeek off-peak windows… */ ],
      "resumeAfterPeak": true
    },
    {
      "name": "free-tier",
      "models": ["openrouter/*:free", "*mini*"],
      "allow": [{ "days": ["daily"], "from": "00:00", "to": "24:00" }]
    }
  ]
}
```

Rules:

- **First match wins** (config order). Models matching nothing fall back to
  the top-level **default** profile; a known model matching nothing at all
  is unguarded. Unknown model identity resolves to default (fail-closed).
- A profile **inherits** every field it omits (`timezone`, `blockMessage`,
  `abortInFlight`, `resumeAfterPeak`, `resumeMessage`,
  `models`) — except `allow`, which **replaces** the default windows.
- Project `profiles` replaces global `profiles` wholesale (same as `allow`).
- The status bar tags non-default profiles (`🌙 off-peak ✓2h [free-tier]`),
  and `/offpeak status` lists every profile with its current state and marks
  `[current model]`. `/offpeak check [time]` evaluates the current model.
- Switching models re-baselines the watchdog, so no phantom
  "window started" transition fires for the new profile.

A ready-made DeepSeek config is in [`pi-offpeak.example.json`](./pi-offpeak.example.json) —
copy it to `~/.pi/agent/pi-offpeak.json` to start.

## Stop vs pause (resume)

Default semantics are **stop-and-drop**:

- a prompt typed during peak is swallowed (no LLM call) and, by default,
  gone — the session then sits idle until you nudge it.
- an aborted run does not restart itself when peak ends.

The status bar countdown (`⛔ peak ✓45m`) is only a display: nothing is
deferred automatically.

Opt in to **pause-and-continue** with:

```jsonc
{
  "resumeAfterPeak": true,   // default false
  "resumeMessage": "Off-peak rates are back in effect. Continue the interrupted task where you left off."
}
```

Then:

- swallowed peak-time prompts are kept in a bounded queue (last 10) and
  replayed verbatim when peak ends, followed by `resumeMessage`;
- an aborted run is continued the same way (history is intact, the model
  picks up where the abort cut it);
- `/offpeak resume` does the same on demand, even with
  `resumeAfterPeak: false` (explicit intent beats the flag).

Rules: resume needs an idle session; your next off-peak message cancels
pending auto-resume (manual takeover wins); `/offpeak off` drops the queue.
`/offpeak status` shows `resume: auto/manual…` plus queued count.

Note: resume lives in long-running sessions (TUI). `-p` runs exit after
the blocked prompt; subagent children are short-lived the same way.

## Slash command

```
/offpeak            status: state, time, next transition, config sources
/offpeak on|off     enable / disable the guard (off = peak rates allowed, careful)
/offpeak toggle
/offpeak reload     re-read both config files without restarting
/offpeak resume     continue peak-interrupted work now (replays queued prompts)
/offpeak status
/offpeak check [time]   e.g. /offpeak check 2026-09-12T02:30:00Z — peak or off-peak?
```

## Subagents

 Native pi has no subagents, but extensions (like the official `subagent/`
 example) add them — and the guard covers them on three levels:

 1. **No new subagents in peak.** Dispatch goes through a tool call, and the
    guard blocks *every* tool during peak regardless of its name.
 2. **Running subagents die at the peak boundary.** The parent's watchdog
    calls `ctx.abort()`; the abort signal reaches the spawner tool's
    `execute()`, which kills the child `pi` process (that's what the
    official example does on abort).
 3. **Children guard themselves — if installed via `pi install`.** A child
    runs `pi --mode json -p --no-session` (no `-e` flags inherited), so it
    picks the extension up from settings discovery and swallows its own
    `Task:` prompt during peak. Verified end-to-end (settings-installed
    extension + global config, prompt swallowed, exit 0, no model call).
    Loaded via `-e` only, children do NOT inherit the guard — so prefer
    `pi install` over `-e` for real use.

 Known hole: processes detached from the tool call (`pi -p ... &`, `nohup`
 via `bash`) survive `abort()` — don't detach agents
 you want stopped.

 `acp_delegate` subagents (this harness) live *outside* the pi process and
 are managed by the host, not by this extension — it can't see or stop
 them. Handle the deadline at the host level (agree a stop time, don't
 dispatch past it, use `timeoutMinutes` as a duration cap).

 ## Notes & limitations

- System wall-clock is the source of truth; `timezone` only affects
  interpretation (DST handled by `Intl`). A wrong clock = wrong guard.
- `abort()` stops streaming between API chunks, it can't un-send a request
  already in flight — worst case is one partial peak call, not a whole night.
- Queued follow-up messages stay queued and blocked until off-peak (or
  `/offpeak off`).
- Non-interactive runs (`-p`, `--mode json`) get the block message on stderr.

## Develop

```sh
npm test   # 21 tests: schedule math (test/schedule.test.mjs) + event wiring with stubbed ctx (test/wiring.test.mjs)
```

No runtime dependencies. Tests resolve `@earendil-works/pi-coding-agent` via a
gitignored `node_modules/@earendil-works` symlink to your pi install (only
needed for the wiring test's import; the shipped package just needs pi itself).
