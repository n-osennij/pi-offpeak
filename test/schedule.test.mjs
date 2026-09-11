import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileProfiles,
  compileRules,
  defaultAllowRules,
  describeResume,
  expandDays,
  isAllowedAt,
  isModelGuarded,
  matchProfile,
  nextTransition,
  parseTime,
} from "../extensions/schedule.ts";

const TZ = "UTC";
const rules = compileRules(defaultAllowRules()).rules;

// DeepSeek: peak = 01–04 & 06–10 UTC, Mon–Fri.

describe("parseTime", () => {
  it("parses HH:MM and 24:00", () => {
    assert.equal(parseTime("00:00"), 0);
    assert.equal(parseTime("01:00"), 60);
    assert.equal(parseTime("24:00"), 1440);
    assert.equal(parseTime("9:05"), 545);
  });
  it("rejects garbage", () => {
    assert.equal(parseTime("24:01"), null);
    assert.equal(parseTime("ab:cd"), null);
    assert.equal(parseTime("10"), null);
  });
});

describe("expandDays", () => {
  it("supports aliases", () => {
    assert.deepEqual([...expandDays(["weekdays"], "t").days].sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual([...expandDays(["weekend"], "t").days].sort(), [0, 6]);
    assert.equal(expandDays(["daily"], "t").days.size, 7);
    assert.deepEqual([...expandDays(["Mon", "FRI"], "t").days].sort(), [1, 5]);
  });
  it("flags unknown days", () => {
    const r = expandDays(["funday"], "t");
    assert.equal(r.days.size, 0);
    assert.equal(r.invalid.length, 1);
  });
});

describe("DeepSeek default schedule (UTC)", () => {
  // Monday 2026-09-14 is a Monday.
  const at = (iso) => new Date(iso);
  it("allows weekday off-peak", () => {
    assert.equal(isAllowedAt(at("2026-09-14T00:30:00Z"), rules, TZ), true);
    assert.equal(isAllowedAt(at("2026-09-14T05:00:00Z"), rules, TZ), true);
    assert.equal(isAllowedAt(at("2026-09-14T12:00:00Z"), rules, TZ), true);
    assert.equal(isAllowedAt(at("2026-09-14T23:59:00Z"), rules, TZ), true);
  });
  it("blocks weekday peak", () => {
    assert.equal(isAllowedAt(at("2026-09-14T01:00:00Z"), rules, TZ), false);
    assert.equal(isAllowedAt(at("2026-09-14T03:59:00Z"), rules, TZ), false);
    assert.equal(isAllowedAt(at("2026-09-14T06:00:00Z"), rules, TZ), false);
    assert.equal(isAllowedAt(at("2026-09-14T09:59:00Z"), rules, TZ), false);
  });
  it("peak edges: end is exclusive", () => {
    assert.equal(isAllowedAt(at("2026-09-14T04:00:00Z"), rules, TZ), true);
    assert.equal(isAllowedAt(at("2026-09-14T10:00:00Z"), rules, TZ), true);
  });
  it("allows the whole weekend", () => {
    assert.equal(isAllowedAt(at("2026-09-12T03:00:00Z"), rules, TZ), true); // Sat, peak hours
    assert.equal(isAllowedAt(at("2026-09-13T08:00:00Z"), rules, TZ), true); // Sun
  });
});

describe("overnight rules", () => {
  const r = compileRules([{ days: ["fri"], from: "22:00", to: "02:00" }]).rules;
  it("spills into Saturday", () => {
    assert.equal(isAllowedAt(new Date("2026-09-11T23:00:00Z"), r, TZ), true); // Fri
    assert.equal(isAllowedAt(new Date("2026-09-12T01:00:00Z"), r, TZ), true); // Sat early
    assert.equal(isAllowedAt(new Date("2026-09-12T03:00:00Z"), r, TZ), false);
    assert.equal(isAllowedAt(new Date("2026-09-10T23:00:00Z"), r, TZ), false); // Thu
  });
});

describe("nextTransition / describeResume", () => {
  it("finds the 04:00 deadline from inside peak", () => {
    const tr = nextTransition(new Date("2026-09-14T02:00:00Z"), rules, TZ);
    assert.ok(tr);
    assert.equal(tr.toAllowed, true);
    assert.equal(tr.at.toISOString(), "2026-09-14T04:00:00.000Z");
  });
  it("finds Friday 10:00 → Monday? no — same-day evening is allowed", () => {
    const tr = nextTransition(new Date("2026-09-14T12:00:00Z"), rules, TZ);
    assert.ok(tr);
    assert.equal(tr.toAllowed, false); // next flip is Tue 01:00 peak
    assert.equal(tr.at.toISOString(), "2026-09-15T01:00:00.000Z");
  });
  it("mentions resume time", () => {
    const s = describeResume(new Date("2026-09-14T02:00:00Z"), rules, TZ);
    assert.match(s, /04:00/);
  });
});

describe("isModelGuarded", () => {
  it("matches provider/id and bare id, fail-closed", () => {
    assert.equal(isModelGuarded("a", "b", ["*"]), true);
    assert.equal(isModelGuarded("a", "b", []), true);
    assert.equal(isModelGuarded("deepseek", "deepseek-chat", ["deepseek/*"]), true);
    assert.equal(isModelGuarded("openrouter", "deepseek-chat", ["deepseek-chat"]), true);
    assert.equal(isModelGuarded("openrouter", "gpt-x", ["deepseek/*"]), false);
    assert.equal(isModelGuarded(undefined, undefined, ["deepseek/*"]), true);
  });
});

const BASE = {
  timezone: "UTC",
  enabled: true,
  allow: [{ days: ["daily"], from: "00:00", to: "24:00" }], // default: always allowed
  models: ["*"],
  abortInFlight: true,
  resumeAfterPeak: false,
  blockMessage: "blocked {until}",
  resumeMessage: "go on",
};

describe("compileProfiles / matchProfile", () => {
  it("default-only config yields one fallback profile", () => {
    const { profiles, warnings } = compileProfiles(BASE);
    assert.equal(warnings.length, 0);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "default");
    assert.equal(profiles[0].isDefault, true);
    assert.equal(matchProfile(profiles, "deepseek", "x")?.name, "default");
  });

  it("named profile inherits omitted fields, overrides allow/timezone", () => {
    const { profiles, warnings } = compileProfiles({
      ...BASE,
      profiles: [
        {
          name: "night",
          models: ["*deepseek*"],
          timezone: "Europe/Minsk",
          allow: [{ days: ["mon"], from: "10:00", to: "11:00" }],
          resumeAfterPeak: true,
        },
      ],
    });
    assert.equal(warnings.length, 0);
    assert.equal(profiles.length, 2);
    const night = profiles[0];
    assert.equal(night.name, "night");
    assert.equal(night.isDefault, false);
    assert.equal(night.timezone, "Europe/Minsk");
    assert.equal(night.resumeAfterPeak, true);
    // inherited from top level:
    assert.equal(night.abortInFlight, true);
    assert.equal(night.blockMessage, "blocked {until}");
    // default profile untouched:
    assert.equal(profiles[1].isDefault, true);
    assert.equal(profiles[1].timezone, "UTC");
  });

  it("profile allow REPLACES (not merges) the default windows", () => {
    const { profiles } = compileProfiles({
      ...BASE, // default allows everything
      profiles: [{ name: "strict", models: ["a/*"], allow: [] }],
    });
    const strict = profiles[0];
    // Monday noon UTC: default allows, strict profile blocks.
    assert.equal(isAllowedAt(new Date("2026-09-14T12:00:00Z"), strict.rules, strict.timezone), false);
    assert.equal(matchProfile(profiles, "a", "m")?.name, "strict");
    assert.equal(matchProfile(profiles, "b", "m")?.name, "default");
  });

  it("first matching profile wins", () => {
    const { profiles } = compileProfiles({
      ...BASE,
      profiles: [
        { name: "first", models: ["*gpt*"] },
        { name: "second", models: ["openrouter/*"] },
      ],
    });
    assert.equal(matchProfile(profiles, "openrouter", "gpt-x")?.name, "first");
    assert.equal(matchProfile(profiles, "openrouter", "other")?.name, "second");
  });

  it("known model matching nothing is unguarded; unknown identity falls back to default", () => {
    const { profiles } = compileProfiles({
      ...BASE,
      models: ["deepseek/*"], // default narrowed
      profiles: [{ name: "o", models: ["openrouter/*"] }],
    });
    assert.equal(matchProfile(profiles, "anthropic", "claude", ), undefined);
    assert.equal(matchProfile(profiles, undefined, undefined)?.isDefault, true);
  });

  it("bad entries warn: auto-name, non-object skip, bad timezone, empty rules", () => {
    const { profiles, warnings } = compileProfiles({
      ...BASE,
      profiles: [
        { models: ["a/*"] }, // no name
        "nope", // not an object
        { name: "badtz", models: ["b/*"], timezone: "Mars/Olympus" },
        { name: "empty", models: ["c/*"], allow: [] },
      ],
    });
    const text = warnings.join("\n");
    assert.match(text, /no name — calling it "profile-1"/);
    assert.match(text, /profiles\[1\]: ignored/);
    assert.match(text, /profile "badtz": unknown timezone/);
    assert.match(text, /profile "empty": no valid allow rules/);
    assert.equal(profiles.find((p) => p.name === "badtz")?.timezone, "UTC");
    assert.equal(profiles.length, 4); // 3 named + default
  });
});
