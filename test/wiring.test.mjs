import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initOffpeak, { __offpeakTick } from "../extensions/offpeak.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

const BLOCK_ALL = { timezone: "UTC", enabled: true, allow: [], models: ["*"] };
const ALLOW_ALL = {
  timezone: "UTC",
  enabled: true,
  allow: [{ days: ["daily"], from: "00:00", to: "24:00" }],
  models: ["*"],
};
const DEEPSEEK_ONLY = {
  timezone: "UTC",
  enabled: true,
  allow: [],
  models: ["deepseek/*"],
};

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), "offpeak-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "pi-offpeak.json"), JSON.stringify(config));
  return dir;
}

/** Minimal fake pi host + ctx. */
function makeHarness(model = { provider: "deepseek", id: "deepseek-chat" }) {
  const handlers = {};
  const commands = {};
  const notes = [];
  const statuses = {};
  const sent = []; // pi.sendUserMessage payloads (resume turns)
  const calls = { aborts: 0 };
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    sendUserMessage: (content) => {
      sent.push(String(content));
    },
  };
  const ctx = {
    cwd: "",
    model,
    hasUI: true,
    ui: {
      notify: (message, type) => notes.push({ message, type }),
      setStatus: (key, text) => {
        statuses[key] = text;
      },
    },
    isIdle: () => true,
    abort: () => {
      calls.aborts++;
    },
    shutdown: () => {},
  };
  initOffpeak(pi);
  return { pi, ctx, handlers, commands, notes, statuses, calls, sent };
}

function writeProjectConfig(dir, config) {
  writeFileSync(join(dir, ".pi", "pi-offpeak.json"), JSON.stringify(config));
}

describe("wiring: always-blocked project", () => {
  const { ctx, handlers, commands, notes, statuses, calls } = makeHarness();
  ctx.cwd = makeProject(BLOCK_ALL);

  it("session_start warns and sets peak status", async () => {
    await handlers.session_start({}, ctx);
    assert.ok(notes.some((n) => n.message.includes("no valid allow rules")));
    assert.ok(notes.some((n) => n.message.includes("Guard is ON")));
    assert.match(statuses.offpeak, /peak/);
    await handlers.session_shutdown({}, ctx);
  });

  it("input: normal text is swallowed, /offpeak passes through", async () => {
    await handlers.session_start({}, ctx);
    const r1 = await handlers.input({ text: "hello" }, ctx);
    assert.equal(r1.action, "handled");
    const r2 = await handlers.input({ text: "/offpeak status" }, ctx);
    assert.equal(r2.action, "continue");
    await handlers.session_shutdown({}, ctx);
  });

  it("tool_call is blocked with terminate", async () => {
    await handlers.session_start({}, ctx);
    const r = await handlers.tool_call({ name: "bash" }, ctx);
    assert.equal(r.block, true);
    assert.equal(r.terminate, true);
    assert.match(r.reason, /pi-offpeak/);
    await handlers.session_shutdown({}, ctx);
  });

  it("tool_call blocks subagent spawners too (any tool name)", async () => {
    await handlers.session_start({}, ctx);
    // Subagent extensions dispatch via tool calls (e.g. the official
    // subagent/ example spawns `pi --mode json -p` children). The guard
    // blocks by time, not by tool name, so no new subagents start in peak.
    for (const name of ["delegate_tasks", "task", "dispatch"]) {
      const r = await handlers.tool_call({ name }, ctx);
      assert.equal(r.block, true, name);
      assert.equal(r.terminate, true, name);
    }
    await handlers.session_shutdown({}, ctx);
  });

  it("turn_start aborts the run", async () => {
    await handlers.session_start({}, ctx);
    const before = calls.aborts;
    await handlers.turn_start({}, ctx);
    assert.equal(calls.aborts, before + 1);
    await handlers.session_shutdown({}, ctx);
  });

  it("/offpeak off disables, on re-enables", async () => {
    await handlers.session_start({}, ctx);
    await commands.offpeak.handler("off", ctx);
    assert.equal((await handlers.input({ text: "hello" }, ctx)).action, "continue");
    assert.equal(statuses.offpeak, "offpeak OFF");
    await commands.offpeak.handler("on", ctx);
    assert.equal((await handlers.input({ text: "hello" }, ctx)).action, "handled");
    await handlers.session_shutdown({}, ctx);
  });

  it("/offpeak status reports state", async () => {
    await handlers.session_start({}, ctx);
    notes.length = 0;
    await commands.offpeak.handler("", ctx);
    const text = notes.map((n) => n.message).join("\n");
    assert.match(text, /guard: ON/);
    assert.match(text, /PEAK/);
    await handlers.session_shutdown({}, ctx);
  });
});

describe("wiring: allow-all project", () => {
  const { ctx, handlers, commands, notes, statuses } = makeHarness();
  ctx.cwd = makeProject(ALLOW_ALL);

  it("input passes through, status shows off-peak", async () => {
    await handlers.session_start({}, ctx);
    assert.equal((await handlers.input({ text: "hello" }, ctx)).action, "continue");
    assert.equal((await handlers.tool_call({ name: "bash" }, ctx)), undefined);
    assert.match(statuses.offpeak, /off-peak/);
    notes.length = 0;
    await commands.offpeak.handler("check 2026-09-14T12:00:00Z", ctx);
    assert.match(notes.map((n) => n.message).join("\n"), /allowed/);
    await handlers.session_shutdown({}, ctx);
  });
});

describe("wiring: command completions match pi's contract", () => {
  const { commands } = makeHarness();

  it("every item carries a string value (pi calls value.startsWith)", () => {
    for (const prefix of ["", "r", "xyz"]) {
      for (const item of commands.offpeak.getArgumentCompletions(prefix)) {
        assert.equal(typeof item.value, "string");
      }
    }
  });
});

describe("wiring: fresh install with no config files", () => {
  // Hermetic only when the machine has no global pi-offpeak.json;
  // otherwise the global file legitimately takes part in the merge.
  const globalConfig = join(getAgentDir(), "pi-offpeak.json");
  const hasGlobal = existsSync(globalConfig);

  it("falls back to built-in defaults and says so", { skip: hasGlobal }, async () => {
    const { ctx, handlers, notes } = makeHarness();
    ctx.cwd = mkdtempSync(join(tmpdir(), "offpeak-nocfg-")); // no .pi dir at all
    await handlers.session_start({}, ctx);
    assert.ok(notes.some((n) => n.message.includes("built-in DeepSeek off-peak defaults")));
    await handlers.session_shutdown({}, ctx);
  });
});

describe("wiring: pause and resume", () => {
  const BLOCK_RESUME = { ...BLOCK_ALL, resumeAfterPeak: true, resumeMessage: "RESUME-MARKER" };
  const ALLOW_RESUME = { ...ALLOW_ALL, resumeAfterPeak: true, resumeMessage: "RESUME-MARKER" };
  const ALLOW_MANUAL = { ...ALLOW_ALL, resumeAfterPeak: false, resumeMessage: "RESUME-MARKER" };

  it("swallowed prompts queue up and show in status", async () => {
    const { ctx, handlers, commands, notes } = makeHarness();
    ctx.cwd = makeProject(BLOCK_RESUME);
    await handlers.session_start({}, ctx);
    assert.equal((await handlers.input({ text: "task A" }, ctx)).action, "handled");
    assert.equal((await handlers.input({ text: "task B" }, ctx)).action, "handled");
    notes.length = 0;
    await commands.offpeak.handler("status", ctx);
    assert.match(notes.map((n) => n.message).join("\n"), /2 queued/);
    await handlers.session_shutdown({}, ctx);
  });

  it("manual /offpeak resume replays the queue even when auto is off", async () => {
    const { ctx, handlers, commands, notes, sent } = makeHarness();
    const dir = makeProject(BLOCK_RESUME);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "task A" }, ctx);
    writeProjectConfig(dir, ALLOW_MANUAL); // off-peak now, auto-resume disabled
    await commands.offpeak.handler("reload", ctx);
    assert.equal(sent.length, 0); // auto is off: reload alone resumes nothing
    notes.length = 0;
    await commands.offpeak.handler("resume", ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /task A/);
    assert.match(sent[0], /RESUME-MARKER/);
    await commands.offpeak.handler("resume", ctx); // queue drained
    assert.equal(sent.length, 1);
    assert.match(notes.map((n) => n.message).join("\n"), /nothing to resume/);
    await handlers.session_shutdown({}, ctx);
  });

  it("auto-resume fires on the peak→off-peak transition when enabled", async () => {
    const { ctx, handlers, commands, sent } = makeHarness();
    const dir = makeProject(BLOCK_RESUME);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "task B" }, ctx);
    await __offpeakTick(); // watchdog observes peak (lastAllowed=false)
    writeProjectConfig(dir, ALLOW_RESUME);
    await commands.offpeak.handler("reload", ctx); // reload ticks: sees transition
    assert.equal(sent.length, 1);
    assert.match(sent[0], /task B/);
    assert.match(sent[0], /auto-resume/);
    await __offpeakTick(); // no duplicate resume
    assert.equal(sent.length, 1);
    await handlers.session_shutdown({}, ctx);
  });

  it("aborted run without queued prompts still auto-resumes the turn", async () => {
    const { ctx, handlers, commands, calls, sent } = makeHarness();
    const dir = makeProject(BLOCK_RESUME);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.turn_start({}, ctx); // peak: abort, mark interrupted
    assert.equal(calls.aborts, 1);
    await __offpeakTick();
    writeProjectConfig(dir, ALLOW_RESUME);
    await commands.offpeak.handler("reload", ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /auto-resume/);
    await handlers.session_shutdown({}, ctx);
  });

  it("no auto-resume when resumeAfterPeak is false (queue survives)", async () => {
    const { ctx, handlers, commands, notes, sent } = makeHarness();
    const dir = makeProject(BLOCK_RESUME);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "task C" }, ctx);
    await __offpeakTick();
    writeProjectConfig(dir, ALLOW_MANUAL);
    await commands.offpeak.handler("reload", ctx);
    assert.equal(sent.length, 0);
    notes.length = 0;
    await commands.offpeak.handler("status", ctx);
    assert.match(notes.map((n) => n.message).join("\n"), /1 queued/);
    await handlers.session_shutdown({}, ctx);
  });

  it("manual takeover in off-peak clears the queue", async () => {
    const { ctx, handlers, commands, notes, sent } = makeHarness();
    const dir = makeProject(BLOCK_RESUME);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "stale wish" }, ctx);
    writeProjectConfig(dir, ALLOW_MANUAL);
    await commands.offpeak.handler("reload", ctx);
    assert.equal((await handlers.input({ text: "i'm back" }, ctx)).action, "continue");
    await __offpeakTick();
    assert.equal(sent.length, 0);
    notes.length = 0;
    await commands.offpeak.handler("status", ctx);
    assert.doesNotMatch(notes.map((n) => n.message).join("\n"), /queued/);
    await handlers.session_shutdown({}, ctx);
  });
});

describe("wiring: model filter bypass", () => {
  const { ctx, handlers } = makeHarness({ provider: "openai", id: "gpt-x" });
  ctx.cwd = makeProject(DEEPSEEK_ONLY);

  it("unguarded model is never blocked", async () => {
    await handlers.session_start({}, ctx);
    assert.equal((await handlers.input({ text: "hello" }, ctx)).action, "continue");
    assert.equal(await handlers.tool_call({ name: "bash" }, ctx), undefined);
    await handlers.session_shutdown({}, ctx);
  });
});

describe("wiring: per-model profiles", () => {
  // Default blocks everything; the "always" profile frees openrouter models.
  const MIXED = {
    timezone: "UTC",
    enabled: true,
    allow: [],
    models: ["*"],
    profiles: [
      { name: "always", models: ["openrouter/*"], allow: [{ days: ["daily"], from: "00:00", to: "24:00" }] },
    ],
  };

  it("deepseek blocked, openrouter allowed, status bar tags the profile", async () => {
    const ds = makeHarness({ provider: "deepseek", id: "deepseek-chat" });
    ds.ctx.cwd = makeProject(MIXED);
    await ds.handlers.session_start({}, ds.ctx);
    assert.equal((await ds.handlers.input({ text: "hi" }, ds.ctx)).action, "handled");
    assert.match(ds.statuses.offpeak, /⛔ peak/);
    assert.doesNotMatch(ds.statuses.offpeak, /\[always\]/); // default profile: no tag
    await ds.handlers.session_shutdown({}, ds.ctx);

    const or = makeHarness({ provider: "openrouter", id: "free-model" });
    or.ctx.cwd = makeProject(MIXED);
    await or.handlers.session_start({}, or.ctx);
    assert.equal((await or.handlers.input({ text: "hi" }, or.ctx)).action, "continue");
    assert.equal(await or.handlers.tool_call({ name: "bash" }, or.ctx), undefined);
    assert.match(or.statuses.offpeak, /off-peak/);
    assert.match(or.statuses.offpeak, /\[always\]/);
    await or.handlers.session_shutdown({}, or.ctx);
  });

  it("status lists every profile, check names the active one", async () => {
    const { ctx, handlers, commands, notes } = makeHarness({ provider: "openrouter", id: "m" });
    ctx.cwd = makeProject(MIXED);
    await handlers.session_start({}, ctx);
    notes.length = 0;
    await commands.offpeak.handler("status", ctx);
    const text = notes.map((n) => n.message).join("\n");
    assert.match(text, /profile "always": off-peak/);
    assert.match(text, /profile "default": PEAK/);
    assert.match(text, /\[current model\]/);
    notes.length = 0;
    await commands.offpeak.handler("check 2026-09-14T12:00:00Z", ctx);
    assert.match(notes.map((n) => n.message).join("\n"), /\[always\].*allowed/);
    await handlers.session_shutdown({}, ctx);
  });

  it("model switch re-baselines the watchdog (no phantom transition)", async () => {
    const h = makeHarness({ provider: "openrouter", id: "m" });
    h.ctx.cwd = makeProject(MIXED);
    await h.handlers.session_start({}, h.ctx);
    await __offpeakTick(); // watchdog observes allowed (lastAllowed=true)
    h.ctx.model = { provider: "deepseek", id: "deepseek-chat" };
    await h.handlers.model_select({}, h.ctx); // re-baseline to peak + refresh bar
    assert.match(h.statuses.offpeak, /⛔ peak/);
    h.notes.length = 0;
    await __offpeakTick(); // allowed(false) === lastAllowed(false): stay silent
    assert.doesNotMatch(h.notes.map((n) => n.message).join("\n"), /window started/);
    await h.handlers.session_shutdown({}, h.ctx);
  });

  it("auto-resume honors the active profile's flag (inherited windows)", async () => {
    const blocked = {
      timezone: "UTC",
      enabled: true,
      allow: [],
      models: ["*"],
      profiles: [{ name: "r", models: ["deepseek/*"], allow: [], resumeAfterPeak: true }],
    };
    const { ctx, handlers, commands, sent } = makeHarness();
    const dir = makeProject(blocked);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "profiled task" }, ctx);
    await __offpeakTick();
    // Off-peak arrives via the DEFAULT windows; the profile inherits them.
    writeProjectConfig(dir, {
      timezone: "UTC",
      enabled: true,
      allow: [{ days: ["daily"], from: "00:00", to: "24:00" }],
      models: ["*"],
      profiles: [{ name: "r", models: ["deepseek/*"], resumeAfterPeak: true }],
    });
    await commands.offpeak.handler("reload", ctx);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /profiled task/);
    await handlers.session_shutdown({}, ctx);
  });

  it("profile opt-out beats the top-level resume flag", async () => {
    const blocked = {
      timezone: "UTC",
      enabled: true,
      allow: [],
      models: ["*"],
      resumeAfterPeak: true, // top level says auto…
      profiles: [{ name: "r", models: ["deepseek/*"], allow: [], resumeAfterPeak: false }], // …profile says manual
    };
    const { ctx, handlers, commands, notes, sent } = makeHarness();
    const dir = makeProject(blocked);
    ctx.cwd = dir;
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "profiled task" }, ctx);
    await __offpeakTick();
    writeProjectConfig(dir, {
      timezone: "UTC",
      enabled: true,
      allow: [{ days: ["daily"], from: "00:00", to: "24:00" }],
      models: ["*"],
      resumeAfterPeak: true,
      profiles: [{ name: "r", models: ["deepseek/*"], resumeAfterPeak: false }],
    });
    await commands.offpeak.handler("reload", ctx);
    assert.equal(sent.length, 0);
    notes.length = 0;
    await commands.offpeak.handler("status", ctx);
    assert.match(notes.map((n) => n.message).join("\n"), /manual/);
    await handlers.session_shutdown({}, ctx);
  });
});
