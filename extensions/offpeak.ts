/**
 * pi-offpeak — block model requests outside allowed (off-peak) time windows.
 *
 * Enforcement (defence in depth, cheapest check first):
 *  1. `input` — swallow new user prompts during peak (no LLM call at all).
 *     Swallowed prompts are kept in a small bounded queue for resume.
 *  2. `turn_start` — abort an autonomous multi-turn run at a turn boundary.
 *  3. `tool_call` — block tool side-effects during peak (terminate the batch).
 *  4. interval watchdog (15s, from session_start) — abort a long in-flight
 *     LLM/tool call exactly when a peak window starts (your 04:00 deadline).
 *  5. resume — on a peak→off-peak transition, optionally (`resumeAfterPeak`)
 *     continue peak-interrupted work via pi.sendUserMessage; always
 *     available on demand as `/offpeak resume`.
 *
 * Default semantics are stop-and-drop: peak blocks and aborts, and the
 * session then sits idle until nudged. Pause-and-continue (auto-resume +
 * replay of peak-time prompts) is opt-in via `resumeAfterPeak: true`.
 *
 * Config resolution: project `.pi/pi-offpeak.json` overlays global
 * `<agentDir>/pi-offpeak.json`; missing pieces fall back to built-in
 * DeepSeek off-peak defaults (peak 01–04 & 06–10 UTC Mon–Fri).
 * The top level is the DEFAULT profile; `profiles[]` adds per-model
 * schedules (first match wins, omitted fields inherited).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  clockInZone,
  compileProfiles,
  defaultConfig,
  describeResume,
  formatDuration,
  isAllowedAt,
  matchProfile,
  nextTransition,
  type CompiledProfile,
  type GuardConfig,
} from "./schedule.ts";

const FILE_NAME = "pi-offpeak.json";
const STATUS_KEY = "offpeak";
const WATCHDOG_MS = 15_000;
/** Peak-time prompts kept for resume. Bounded: oldest beyond the cap drop. */
const MAX_QUEUED_INPUTS = 10;

interface LoadedConfig {
  config: GuardConfig;
  /** Named profiles in config order, default profile last (the fallback). */
  profiles: CompiledProfile[];
  warnings: string[];
  sources: string[]; // which files contributed
}

function agentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return join(homedir(), ".pi", "agent");
  }
}

function readJsonFile(path: string): { data: unknown; error?: string } {
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    return { data: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function loadConfig(cwd: string): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  const defaults = defaultConfig();

  let merged: GuardConfig = {
    timezone: defaults.timezone,
    enabled: defaults.enabled,
    allow: defaults.allow,
    models: defaults.models,
    blockMessage: defaults.blockMessage,
    abortInFlight: defaults.abortInFlight,
    resumeAfterPeak: defaults.resumeAfterPeak,
    resumeMessage: defaults.resumeMessage,
  };

  const overlay = (data: unknown, source: string) => {
    const rec = asRecord(data);
    if (Object.keys(rec).length === 0) {
      if (data !== undefined) warnings.push(`${source}: ignored (want a JSON object)`);
      return;
    }
    sources.push(source);
    for (const k of ["enabled", "abortInFlight", "resumeAfterPeak"] as const) {
      if (rec[k] !== undefined) merged[k] = rec[k] === true;
    }
    for (const k of ["timezone", "blockMessage", "resumeMessage"] as const) {
      if (rec[k] !== undefined) merged[k] = String(rec[k]);
    }
    if (rec.allow !== undefined) merged.allow = Array.isArray(rec.allow) ? rec.allow : [];
    if (rec.models !== undefined) merged.models = Array.isArray(rec.models) ? rec.models.map(String) : [];
    if (rec.profiles !== undefined) {
      if (Array.isArray(rec.profiles)) merged.profiles = rec.profiles;
      else {
        warnings.push(`${source}: "profiles" ignored (want an array) — using previous profiles`);
      }
    }
  };

  const globalPath = join(agentDir(), FILE_NAME);
  if (existsSync(globalPath)) {
    const { data, error } = readJsonFile(globalPath);
    if (error) warnings.push(`${globalPath}: ${error}`);
    else overlay(data, globalPath);
  }

  try {
    const projectPath = join(cwd, CONFIG_DIR_NAME, FILE_NAME);
    if (existsSync(projectPath)) {
      const { data, error } = readJsonFile(projectPath);
      if (error) warnings.push(`${projectPath}: ${error}`);
      else overlay(data, projectPath);
    }
  } catch (err) {
    warnings.push(`project config: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { profiles, warnings: profileWarnings } = compileProfiles(merged);
  warnings.push(...profileWarnings);

  return { config: merged, profiles, warnings, sources };
}

/** Test seam: runs one watchdog iteration against the active session, if any.
 *  Lets tests drive peak→off-peak transitions deterministically. */
export async function __offpeakTick(): Promise<void> {
  await watchdogTickFn?.();
}

// Assigned inside the default export (single extension instance per process).
let watchdogTickFn: (() => Promise<void>) | undefined;

export default function (pi: ExtensionAPI) {
  const boot = defaultConfig();
  // Built-in message fallbacks (constant for the process lifetime).
  const fallbackBlock = boot.blockMessage!;
  const fallbackResume = boot.resumeMessage!;
  let loaded: LoadedConfig = {
    config: { ...boot },
    profiles: compileProfiles(boot).profiles,
    warnings: [],
    sources: [],
  };
  let enabled = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let lastAllowed: boolean | undefined;
  let notifiedPeak = false; // notify once per peak episode (avoid spam)
  // Pause-and-resume state. Set when peak stops work (aborted run or
  // swallowed prompt), cleared on resume or manual user takeover.
  let peakInterrupted = false;
  let pendingInputs: string[] = [];

  /** Effective schedule for the current model: first matching profile wins. */
  const effectiveProfile = (ctx: ExtensionContext): CompiledProfile | undefined =>
    matchProfile(loaded.profiles, ctx.model?.provider, ctx.model?.id);

  /** Active profile, or undefined when the guard is off / model unguarded. */
  const activeProfile = (ctx: ExtensionContext): CompiledProfile | undefined =>
    enabled ? effectiveProfile(ctx) : undefined;

  const defaultProfile = (): CompiledProfile =>
    loaded.profiles.find((p) => p.isDefault) ?? loaded.profiles[0];

  const isBlockedNow = (ctx: ExtensionContext): boolean => {
    const p = activeProfile(ctx);
    if (!p) return false;
    return !isAllowedAt(new Date(), p.rules, p.timezone);
  };

  const blockText = (ctx: ExtensionContext): string => {
    // All callers hold a blocked profile (checked via isBlockedNow first).
    const p = effectiveProfile(ctx)!;
    const template = p.blockMessage || fallbackBlock;
    return template.replaceAll("{until}", describeResume(new Date(), p.rules, p.timezone));
  };

  /** Short status-bar text. Non-default profiles are tagged: `🌙 off-peak ✓2h [night]`. */
  const statusText = (ctx: ExtensionContext): string => {
    if (!enabled) return "offpeak OFF";
    const p = effectiveProfile(ctx);
    if (!p) {
      return "offpeak bypass (model)";
    }
    const now = new Date();
    const allowed = isAllowedAt(now, p.rules, p.timezone);
    const tr = nextTransition(now, p.rules, p.timezone);
    const countdown = tr ? ` ${tr.toAllowed ? "✓" : "⛔"}${formatDuration(tr.at.getTime() - now.getTime())}` : "";
    const tag = p.isDefault ? "" : ` [${p.name.slice(0, 14)}]`;
    return allowed ? `🌙 off-peak${countdown}${tag}` : `⛔ peak${countdown}${tag}`;
  };

  const refreshStatus = (ctx: ExtensionContext) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, statusText(ctx));
    } catch {
      // setStatus may be unavailable in some modes — status bar is best-effort.
    }
  };

  const say = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning") => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // ignore — fall through to stderr below
    }
    if (!ctx.hasUI) {
      // Non-interactive modes (-p / --mode json): make the block visible.
      console.error(`[pi-offpeak] ${message}`);
    }
  };

  const clearInterruption = () => {
    peakInterrupted = false;
    pendingInputs = [];
  };

  const queueInput = (text: string) => {
    pendingInputs.push(text);
    while (pendingInputs.length > MAX_QUEUED_INPUTS) pendingInputs.shift();
    peakInterrupted = true;
  };

  /** Continue peak-interrupted work now (off-peak required, idle required).
   *  Resume options come from the current model's profile.
   *  Returns true when a turn was triggered. */
  const tryResume = (ctx: ExtensionContext, reason: "auto" | "manual"): boolean => {
    const p = activeProfile(ctx);
    if (!p) {
      clearInterruption();
      return false;
    }
    if (isBlockedNow(ctx)) return false; // still peak
    if (!ctx.isIdle()) return false;
    if (reason === "auto" && p.resumeAfterPeak !== true) return false;
    if (pendingInputs.length === 0 && !peakInterrupted) return false;
    const segments = [...pendingInputs];
    const note = `[pi-offpeak ${reason === "auto" ? "auto-resume" : "resume"}] ${p.resumeMessage || fallbackResume}`;
    segments.push(note);
    clearInterruption();
    try {
      pi.sendUserMessage(segments.join("\n\n"));
      return true;
    } catch {
      return false;
    }
  };

  const stopTimer = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const watchdogTick = async () => {
    const c = lastCtx;
    if (!c) return;
    const now = new Date();
    const ap = activeProfile(c);
    const allowed = ap ? isAllowedAt(now, ap.rules, ap.timezone) : true;

    if (lastAllowed !== undefined && allowed !== lastAllowed) {
      // Window transition.
      notifiedPeak = false;
      refreshStatus(c);
      if (!allowed && ap) {
        say(c, `Peak window started (${clockInZone(now, ap.timezone)} ${ap.timezone}). Model requests are blocked.`, "warning");
      } else if (allowed && ap) {
        say(c, "Off-peak window started — model requests allowed again.", "info");
        const queued = pendingInputs.length;
        if (tryResume(c, "auto")) {
          say(c, `pi-offpeak: resumed peak-interrupted work${queued > 0 ? ` (${queued} queued prompt${queued === 1 ? "" : "s"} replayed)` : ""}.`, "info");
        }
      }
    } else if (lastAllowed === undefined) {
      refreshStatus(c);
    }
    lastAllowed = allowed;

    if (ap && !allowed && !c.isIdle()) {
      // Deadline crossed mid-run: stop burning peak tokens.
      peakInterrupted = true;
      if (ap.abortInFlight !== false) {
        try {
          c.abort();
        } catch {
          // abort is best-effort
        }
      }
      if (!notifiedPeak) {
        notifiedPeak = true;
        const tail =
          ap.resumeAfterPeak === true
            ? "It will auto-resume when off-peak starts."
            : "It will stay stopped until you nudge it (/offpeak resume).";
        say(c, `Peak window started — in-flight run aborted. ${tail}`, "warning");
      }
      refreshStatus(c);
    }
  };

  watchdogTickFn = watchdogTick;

  const startTimer = (ctx: ExtensionContext, fresh = true) => {
    stopTimer();
    lastCtx = ctx;
    if (fresh) {
      // Fresh session: forget previous observations and interruption state.
      lastAllowed = undefined;
      notifiedPeak = false;
      clearInterruption();
    }
    timer = setInterval(() => {
      void watchdogTick();
    }, WATCHDOG_MS);
    // Don't keep the process alive just for the watchdog (matters for -p runs).
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  };

  const describeState = (ctx: ExtensionContext): string[] => {
    const now = new Date();
    const lines: string[] = [];
    lines.push(`guard: ${enabled ? "ON" : "OFF"}`);
    const ap = enabled ? effectiveProfile(ctx) : undefined;
    if (ap) {
      lines.push(
        `profile: "${ap.name}"${ap.isDefault ? " (default)" : ""} — models: ${ap.models.join(", ") || "*"}`,
      );
    } else {
      lines.push("profile: none — current model matches nothing (unguarded)");
    }
    const cur = ap ?? defaultProfile();
    lines.push(
      `resume: ${cur.resumeAfterPeak === true ? "auto" : "manual (/offpeak resume)"}` +
        (pendingInputs.length > 0 ? `, ${pendingInputs.length} queued` : "") +
        (peakInterrupted ? ", interrupted-work pending" : ""),
    );
    lines.push(`time: ${clockInZone(now, cur.timezone)} (${cur.timezone})`);
    if (enabled) {
      for (const p of loaded.profiles) {
        const a = isAllowedAt(now, p.rules, p.timezone);
        const tr = nextTransition(now, p.rules, p.timezone);
        lines.push(
          `profile "${p.name}": ${a ? "off-peak" : "PEAK"} (${p.timezone})` +
            (tr ? `, next ${tr.toAllowed ? "off-peak" : "peak"} ${describeResume(now, p.rules, p.timezone)}` : "") +
            (p === ap ? " [current model]" : ""),
        );
      }
    }
    lines.push(`config: ${loaded.sources.length > 0 ? loaded.sources.join(" ← ") : "built-in defaults"}`);
    for (const w of loaded.warnings) lines.push(`warn: ${w}`);
    return lines;
  };

  // ---- lifecycle ---------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    loaded = loadConfig(ctx.cwd);
    enabled = loaded.config.enabled !== false;
    for (const w of loaded.warnings) say(ctx, `pi-offpeak: ${w}`, "warning");
    if (loaded.sources.length === 0) {
      // Fresh install, no config file anywhere: built-in DeepSeek off-peak
      // defaults are in effect. Say so once, or users will wonder whether
      // the guard is even on.
      const dtz = defaultProfile().timezone;
      say(
        ctx,
        `pi-offpeak: no config file found — using built-in DeepSeek off-peak defaults (${dtz}). ` +
          `To customize, copy pi-offpeak.example.json to ${join(agentDir(), FILE_NAME)}.`,
        "info",
      );
    }
    refreshStatus(ctx);
    startTimer(ctx);
    if (enabled && isBlockedNow(ctx)) {
      say(ctx, `${blockText(ctx)} Guard is ON — send /offpeak off to bypass (peak rates apply).`, "warning");
      notifiedPeak = true;
    }
  });

  pi.on("session_shutdown", async () => {
    stopTimer();
    const c = lastCtx;
    lastCtx = undefined;
    if (c) {
      try {
        c.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // ignore
      }
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    // A model switch can change the effective profile (different windows):
    // re-baseline so the watchdog doesn't report a phantom transition.
    const p = activeProfile(ctx);
    lastAllowed = p ? isAllowedAt(new Date(), p.rules, p.timezone) : true;
    refreshStatus(ctx);
  });

  // ---- enforcement --------------------------------------------------------

  // 1) New user prompts: swallow during peak so no LLM call happens at all.
  //    The text is queued (bounded) so resume can replay it — pause, not loss.
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/offpeak")) return { action: "continue" as const };
    if (!isBlockedNow(ctx)) {
      notifiedPeak = false;
      // Manual takeover: the user is driving again, stale peak state goes.
      clearInterruption();
      return { action: "continue" as const };
    }
    queueInput(event.text);
    if (!notifiedPeak) {
      notifiedPeak = true;
      say(ctx, blockText(ctx), "warning");
    }
    return { action: "handled" as const };
  });

  // 2) Autonomous loop turn boundary: stop a run that crossed into peak.
  pi.on("turn_start", async (_event, ctx) => {
    if (!isBlockedNow(ctx)) return;
    refreshStatus(ctx);
    peakInterrupted = true;
    try {
      ctx.abort();
    } catch {
      // ignore
    }
    if (!notifiedPeak) {
      notifiedPeak = true;
      say(ctx, `${blockText(ctx)} Aborted turn at peak boundary.`, "warning");
    }
  });

  // 3) Belt-and-suspenders: no tool side-effects during peak.
  pi.on("tool_call", async (_event, ctx) => {
    if (!isBlockedNow(ctx)) return undefined;
    return { block: true, reason: `Blocked by pi-offpeak: ${blockText(ctx)}`, terminate: true };
  });

  // ---- slash command ------------------------------------------------------

  pi.registerCommand("offpeak", {
    description: "Off-peak guard: on | off | status | reload | resume | check [ISO time]",
    getArgumentCompletions: (prefix) => {
      const all = ["on", "off", "status", "reload", "resume", "check"];
      const items = all.filter((c) => c.startsWith(prefix.trim().toLowerCase()));
      return items.map((label) => ({ label, value: label }));
    },
    handler: async (args, ctx) => {
      const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const sub = (subRaw || "status").toLowerCase();

      if (sub === "on" || sub === "enable" || sub === "start") {
        enabled = true;
        notifiedPeak = false;
        refreshStatus(ctx);
        say(ctx, "pi-offpeak guard ON.", "info");
      } else if (sub === "off" || sub === "disable" || sub === "stop") {
        enabled = false;
        clearInterruption(); // guard off = you own billing now; drop pending resume state
        try {
          ctx.ui.setStatus(STATUS_KEY, "offpeak OFF");
        } catch {
          // ignore
        }
        say(ctx, "pi-offpeak guard OFF — peak-rate requests are allowed. Careful with billing.", "warning");
      } else if (sub === "reload") {
        loaded = loadConfig(ctx.cwd);
        enabled = loaded.config.enabled !== false;
        notifiedPeak = false;
        refreshStatus(ctx);
        if (lastCtx) {
          // Re-arm watchdog against the fresh schedule, keeping the last
          // observation so the next tick still detects a boundary crossing.
          // Queued peak prompts survive reload; run /offpeak resume to replay.
          const c = lastCtx;
          startTimer(c, false);
          refreshStatus(c);
          void watchdogTick();
        }
        say(ctx, "pi-offpeak config reloaded.", "info");
        for (const line of describeState(ctx)) say(ctx, `pi-offpeak: ${line}`, "info");
      } else if (sub === "resume" || sub === "continue") {
        // Manual resume: works regardless of resumeAfterPeak (explicit intent).
        const queued = pendingInputs.length;
        if (tryResume(ctx, "manual")) {
          say(ctx, `pi-offpeak: resumed${queued > 0 ? ` (${queued} queued prompt${queued === 1 ? "" : "s"} replayed)` : ""}.`, "info");
        } else if (isBlockedNow(ctx)) {
          say(ctx, `pi-offpeak: still peak — ${blockText(ctx)}`, "warning");
        } else {
          say(ctx, "pi-offpeak: nothing to resume (no interrupted work).", "info");
        }
      } else if (sub === "check") {
        const at = rest.length > 0 ? new Date(rest.join(" ")) : new Date();
        if (Number.isNaN(at.getTime())) {
          say(ctx, `pi-offpeak: cannot parse time "${rest.join(" ")}" (try ISO, e.g. 2026-09-12T02:30:00Z).`, "error");
          return;
        }
        const p = effectiveProfile(ctx);
        const cur = p ?? defaultProfile();
        const allowed = p ? isAllowedAt(at, p.rules, p.timezone) : true;
        const who = p && !p.isDefault ? ` [${p.name}]` : "";
        say(
          ctx,
          `pi-offpeak${who}: ${clockInZone(at, cur.timezone)} ${cur.timezone} → ${allowed ? "off-peak (allowed)" : "PEAK (blocked)"}.`,
          allowed ? "info" : "warning",
        );
      } else {
        // status (default)
        for (const line of describeState(ctx)) say(ctx, `pi-offpeak: ${line}`, "info");
      }
    },
  });
}

