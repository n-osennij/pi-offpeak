/**
 * pi-offpeak — pure schedule logic (no imports, no side effects).
 *
 * Kept dependency-free so it can be unit-tested with plain node
 * (`node --experimental-strip-types --test`) without loading pi.
 */

export interface AllowRule {
  /** Weekday selectors. Empty/omitted = every day.
   *  Accepts: mon tue wed thu fri sat sun (case-insensitive),
   *  "weekdays" (mon–fri), "weekend" (sat+sun), "daily" (all week). */
  days?: string[];
  /** "HH:MM", 24h. "24:00" is allowed as an end-of-day bound. */
  from: string;
  /** "HH:MM", 24h. May be <= `from` for an overnight window (e.g. 22:00 → 02:00). */
  to: string;
}

export interface GuardConfig {
  /** IANA timezone, e.g. "UTC", "Europe/Moscow". Default "UTC".
   *  This is the default for all profiles; a profile may set its own. */
  timezone?: string;
  /** Master switch default. Can be toggled at runtime via /offpeak. Default true. */
  enabled?: boolean;
  /** Allowlist of time windows. A moment is allowed iff it matches ANY rule.
   *  This is the DEFAULT profile's windows; named profiles may override. */
  allow?: AllowRule[];
  /** Model patterns the DEFAULT profile applies to. Default ["*"] (all models).
   *  Entries match "provider/modelId" or a bare "modelId"; "*" = any sequence. */
  models?: string[];
  /** Message shown when a request is blocked. Supports {until} placeholder. */
  blockMessage?: string;
  /** Abort an in-flight agent run when a peak window starts. Default true. */
  abortInFlight?: boolean;
  /** Pause-and-resume: when a peak window ends, automatically continue
   *  peak-interrupted work (aborted runs, queued peak-time prompts).
   *  Default false (guard only stops; the session stays idle until you
   *  nudge it or run /offpeak resume). */
  resumeAfterPeak?: boolean;
  /** Message injected to continue interrupted work on resume. */
  resumeMessage?: string;
  /** Per-model schedules. First matching profile wins; models matching
   *  nothing fall back to the default profile above. A profile inherits
   *  every field it omits from the top-level defaults. */
  profiles?: ProfileConfig[];
}

/** One named per-model schedule. Any omitted field is inherited from the
 *  top-level config (which itself falls back to built-in defaults), except
 *  `allow`: when present it REPLACES the default windows (no merging). */
export interface ProfileConfig {
  /** Short label shown in the status bar and /offpeak status.
   *  Auto-generated ("profile-1", …) with a warning when omitted. */
  name?: string;
  /** Model patterns for this profile (same syntax as GuardConfig.models).
   *  Inherits the top-level `models` when omitted. */
  models?: string[];
  /** IANA timezone for this profile's windows. Inherits top-level. */
  timezone?: string;
  /** Allowlist windows for these models. Replaces top-level `allow`. */
  allow?: AllowRule[];
  blockMessage?: string;
  abortInFlight?: boolean;
  resumeAfterPeak?: boolean;
  resumeMessage?: string;
}

export interface CompiledRule {
  days: Set<number>; // 0 = Sunday … 6 = Saturday
  from: number; // minutes since midnight, 0..1440
  to: number; // minutes since midnight, 0..1440
}

export interface CompileWarnings {
  rules: CompiledRule[];
  invalid: string[]; // human-readable warnings, empty when clean
}

const DAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** DeepSeek off-peak in UTC: peak = 01–04 & 06–10 Mon–Fri, everything else is allowed. */
export function defaultAllowRules(): AllowRule[] {
  return [
    { days: ["mon", "tue", "wed", "thu", "fri"], from: "00:00", to: "01:00" },
    { days: ["mon", "tue", "wed", "thu", "fri"], from: "04:00", to: "06:00" },
    { days: ["mon", "tue", "wed", "thu", "fri"], from: "10:00", to: "24:00" },
    { days: ["sat", "sun"], from: "00:00", to: "24:00" },
  ];
}

export function defaultConfig(): Required<
  Pick<GuardConfig, "timezone" | "enabled" | "abortInFlight" | "resumeAfterPeak">
> & Pick<GuardConfig, "allow" | "models" | "blockMessage" | "resumeMessage"> {
  return {
    timezone: "UTC",
    enabled: true,
    allow: defaultAllowRules(),
    models: ["*"],
    blockMessage: "Off-peak guard: model requests are blocked now (peak rates). Resumes {until}.",
    abortInFlight: true,
    resumeAfterPeak: true,
    resumeMessage: "Off-peak rates are back in effect. Continue the interrupted task where you left off.",
  };
}

export interface CompiledProfile {
  name: string;
  /** True for the top-level config; always last, the fallback. */
  isDefault: boolean;
  models: string[];
  timezone: string;
  rules: CompiledRule[];
  blockMessage: string;
  abortInFlight: boolean;
  resumeAfterPeak: boolean;
  resumeMessage: string;
}

/** First non-empty string wins (profile → top level → built-in default). */
function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v !== "") return v;
  return undefined;
}

function resolveTimezone(raw: unknown, fallback: string, warnings: string[], who: string): string {
  const tz = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
  if (!isValidTimezone(tz)) {
    warnings.push(`${who}: unknown timezone "${tz}", falling back to UTC`);
    return "UTC";
  }
  return tz;
}

/**
 * Compile the default profile plus every named profile into fully-resolved
 * schedules (inheritance applied, rules compiled). Returns named profiles
 * in config order with the default profile LAST (it is the fallback).
 *
 * Expects the already-merged config (global + project overlaid, built-in
 * defaults filled in where both files are silent).
 */
export function compileProfiles(cfg: GuardConfig): { profiles: CompiledProfile[]; warnings: string[] } {
  const warnings: string[] = [];
  const d = defaultConfig();

  const baseTimezone =
    typeof cfg.timezone === "string" && cfg.timezone.trim() !== "" ? cfg.timezone.trim() : d.timezone;
  const baseModels = Array.isArray(cfg.models) ? cfg.models.map(String) : d.models!;
  const baseAllow = Array.isArray(cfg.allow) ? cfg.allow : d.allow!;

  const compileOne = (
    who: string,
    name: string,
    isDefault: boolean,
    raw: ProfileConfig | GuardConfig,
  ): CompiledProfile => {
    const timezone = resolveTimezone(raw.timezone, baseTimezone, warnings, who);
    const models = Array.isArray(raw.models) ? raw.models.map(String) : baseModels;
    // Named profiles without `allow` inherit the default windows.
    // (For the default profile itself, raw.allow IS the base windows.)
    const allow = Array.isArray((raw as ProfileConfig).allow) ? (raw as ProfileConfig).allow! : baseAllow;
    const { rules, invalid } = compileRules(allow);
    warnings.push(...invalid.map((m) => `${who}: ${m}`));
    if (rules.length === 0) {
      warnings.push(
        `${who}: no valid allow rules — ${isDefault ? "models outside any profile are blocked" : "these models are blocked"} while the guard is on`,
      );
    }
    return {
      name,
      isDefault,
      models,
      timezone,
      rules,
      blockMessage: pickStr(raw.blockMessage, cfg.blockMessage, d.blockMessage)!,
      abortInFlight: raw.abortInFlight ?? cfg.abortInFlight ?? d.abortInFlight,
      resumeAfterPeak: raw.resumeAfterPeak ?? cfg.resumeAfterPeak ?? d.resumeAfterPeak,
      resumeMessage: pickStr(raw.resumeMessage, cfg.resumeMessage, d.resumeMessage)!,
    };
  };

  const named: CompiledProfile[] = [];
  const rawProfiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  rawProfiles.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warnings.push(`profiles[${i}]: ignored (want an object with name/models/allow)`);
      return;
    }
    const rec = raw as ProfileConfig;
    const name = typeof rec.name === "string" && rec.name.trim() !== "" ? rec.name.trim() : `profile-${i + 1}`;
    if (name === `profile-${i + 1}`) warnings.push(`profiles[${i}]: no name — calling it "${name}"`);
    named.push(compileOne(`profile "${name}"`, name, false, rec));
  });

  const fallback = compileOne("default", "default", true, cfg);
  return { profiles: [...named, fallback], warnings };
}

/**
 * Effective profile for a model: first matching profile wins (config order,
 * default last as the fallback). Unknown model identity resolves to the
 * default profile (fail-closed: still guarded, never silently bypassed).
 * Returns undefined only when the identity is known and nothing matches —
 * those models are unguarded.
 */
export function matchProfile(
  profiles: CompiledProfile[],
  provider: string | undefined,
  modelId: string | undefined,
): CompiledProfile | undefined {
  const fallback = profiles.find((p) => p.isDefault) ?? profiles[profiles.length - 1];
  if ((!provider || provider === "") && (!modelId || modelId === "")) return fallback;
  for (const p of profiles) {
    if (isModelGuarded(provider, modelId, p.models)) return p;
  }
  return undefined;
}

export function parseTime(raw: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min < 0 || min > 59) return null;
  if (h === 24 && min === 0) return 1440;
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

export function expandDays(rawDays: string[] | undefined, ruleLabel: string): { days: Set<number>; invalid: string[] } {
  const days = new Set<number>();
  const invalid: string[] = [];
  if (!rawDays || rawDays.length === 0) {
    for (let i = 0; i < 7; i++) days.add(i);
    return { days, invalid };
  }
  for (const raw of rawDays) {
    const d = String(raw).trim().toLowerCase();
    if (d === "weekdays") {
      for (let i = 1; i <= 5; i++) days.add(i);
    } else if (d === "weekend") {
      days.add(0);
      days.add(6);
    } else if (d === "daily") {
      for (let i = 0; i < 7; i++) days.add(i);
    } else if (d in DAY_ALIASES) {
      days.add(DAY_ALIASES[d]);
    } else {
      invalid.push(`rule "${ruleLabel}": unknown day "${raw}"`);
    }
  }
  return { days, invalid };
}

export function compileRules(allow: AllowRule[] | undefined): CompileWarnings {
  const rules: CompiledRule[] = [];
  const invalid: string[] = [];
  for (const rule of allow ?? []) {
    const label = `${rule.from ?? "?"}→${rule.to ?? "?"} [${(rule.days ?? ["daily"]).join(",")}]`;
    const from = parseTime(rule.from);
    const to = parseTime(rule.to);
    if (from === null) {
      invalid.push(`rule "${label}": bad "from" time "${rule.from}" (want HH:MM)`);
      continue;
    }
    if (to === null) {
      invalid.push(`rule "${label}": bad "to" time "${rule.to}" (want HH:MM)`);
      continue;
    }
    const { days, invalid: badDays } = expandDays(rule.days, label);
    invalid.push(...badDays);
    if (days.size === 0) {
      invalid.push(`rule "${label}": no valid days`);
      continue;
    }
    rules.push({ days, from, to });
  }
  return { rules, invalid };
}

// Intl formatters are expensive to construct — cache one per timezone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `date` in `timeZone`: single formatToParts walk. */
function zoneParts(date: Date, timeZone: string): { weekday: number; clock: string; minutes: number } {
  const parts = formatterFor(timeZone).formatToParts(date);
  let weekday = -1;
  let wd = "";
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") {
      wd = p.value;
      weekday = WEEKDAY_SHORT.indexOf(p.value);
    } else if (p.type === "hour") hour = Number(p.value) % 24; // "24" at midnight
    else if (p.type === "minute") minute = Number(p.value);
  }
  if (weekday < 0) throw new Error(`could not resolve weekday for timezone "${timeZone}"`);
  return {
    weekday,
    clock: `${wd} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
  };
}

/** Wall-clock weekday + minutes-since-midnight of `date` in `timeZone`. */
export function tzParts(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const { weekday, minutes } = zoneParts(date, timeZone);
  return { weekday, minutes };
}

/**
 * True iff `date` falls inside ANY rule (allowlist semantics).
 * Overnight rules (from > to) start on the listed days and spill past midnight:
 * e.g. {days:[fri], from 22:00, to 02:00} covers Fri 22:00 → Sat 02:00.
 * A rule with from == to means "whole listed days".
 */
export function isAllowedAt(date: Date, rules: CompiledRule[], timeZone: string): boolean {
  const { weekday, minutes } = tzParts(date, timeZone);
  const yesterday = (weekday + 6) % 7;
  for (const rule of rules) {
    if (rule.from === rule.to) {
      if (rule.days.has(weekday)) return true;
      continue;
    }
    if (rule.from < rule.to) {
      if (rule.days.has(weekday) && minutes >= rule.from && minutes < rule.to) return true;
    } else {
      if (rule.days.has(weekday) && minutes >= rule.from) return true;
      if (rule.days.has(yesterday) && minutes < rule.to) return true;
    }
  }
  return false;
}

/**
 * Find the next moment (minute granularity, up to 8 days ahead) where the
 * allowed-state flips. Returns null when it never flips (always allow/deny).
 */
export function nextTransition(
  from: Date,
  rules: CompiledRule[],
  timeZone: string,
): { at: Date; toAllowed: boolean } | null {
  const start = isAllowedAt(from, rules, timeZone);
  let t = Math.ceil(from.getTime() / 60000) * 60000;
  const end = t + 8 * 24 * 60 * 60000;
  for (t += 60000; t <= end; t += 60000) {
    const d = new Date(t);
    if (isAllowedAt(d, rules, timeZone) !== start) return { at: d, toAllowed: !start };
  }
  return null;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, "0")}m`;
  return `${mins}m`;
}

/** "in 3h12m" / "at Mon 10:00 UTC" style countdown for block messages. */
export function describeResume(now: Date, rules: CompiledRule[], timeZone: string): string {
  const tr = nextTransition(now, rules, timeZone);
  if (!tr) return "when the schedule allows";
  const inMs = tr.at.getTime() - now.getTime();
  // Resume clock time in the configured timezone (validated at compile).
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(tr.at);
  return `in ${formatDuration(inMs)} (${clock} ${timeZone})`;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/**
 * Whether the guard applies to a model. Fail-closed: unknown/empty model
 * identity counts as guarded while the guard is enabled.
 */
export function isModelGuarded(
  provider: string | undefined,
  modelId: string | undefined,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const pats = patterns.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (pats.length === 0 || pats.includes("*")) return true;
  const candidates: string[] = [];
  if (provider && modelId) candidates.push(`${provider}/${modelId}`.toLowerCase());
  if (modelId) candidates.push(modelId.toLowerCase());
  if (provider && !modelId) candidates.push(provider.toLowerCase());
  if (candidates.length === 0) return true; // fail-closed
  return pats.some((p) => {
    const re = wildcardToRegExp(p);
    return candidates.some((c) => re.test(c));
  });
}

/** Render "HH:MM" wall-clock of `date` in `timeZone` (for /offpeak status). */
export function clockInZone(date: Date, timeZone: string): string {
  return zoneParts(date, timeZone).clock;
}
