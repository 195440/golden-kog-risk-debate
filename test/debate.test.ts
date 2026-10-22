import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  debate,
  extractNumbers,
  findProblems,
  MAX_ADVOCATE_WORDS,
  MAX_REVIEWER_WORDS,
  NO_CASE_TEXT,
  REFUSED_WORDS,
} from "../src/debate.ts";
import type { Debate, DebateDeps, DebateInput, Role, RouteArgs, RouteResult } from "../src/debate.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FACTS = [
  "Top 10 holders own 62.5 percent of supply.",
  "Liquidity pool holds 48,200 USD.",
  "Liquidity lock ends in 90 days.",
  "Deployer wallet holds 4.1 percent of supply.",
  "Mint authority is revoked.",
].join("\n");

const SOUND_OK =
  "Mint authority is revoked and the liquidity pool holds 48,200 USD with a lock of 90 days, so the pool cannot be pulled soon.";
const FRAGILE_OK =
  "The top 10 holders own 62.5 percent of supply and the deployer wallet holds 4.1 percent, so a few wallets can move the market.";
const REVIEWER_TEXT =
  "Both cases rest on measured facts. The lock and the revoked mint support the sound case, while 62.5 percent held by 10 wallets supports the fragile case.";

function reviewerJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: REVIEWER_TEXT,
    weight: ["top_holders", "lp_lock"],
    unknown: ["holder history"],
    tension: "Locked liquidity against concentrated ownership.",
    ...over,
  });
}

function makeInput(over: Partial<DebateInput> = {}): DebateInput {
  return {
    facts_text: FACTS,
    level: "MEDIUM",
    points: 37,
    flag_ids: ["top_holders", "lp_lock", "deployer_share"],
    unknown: ["holder history", "contract audit"],
    ...over,
  };
}

type Handler = (args: RouteArgs) => RouteResult | Promise<RouteResult>;

function scripted(script: Partial<Record<Role, Handler>>) {
  const calls: RouteArgs[] = [];
  const route = async (args: RouteArgs): Promise<RouteResult> => {
    calls.push(args);
    const handler = script[args.payload.role];
    if (!handler) throw new Error(`no script for ${args.payload.role}`);
    return handler(args);
  };
  return { route, calls };
}

function happy(extra: Partial<Record<Role, Handler>> = {}) {
  return scripted({
    sound: () => ({ content: SOUND_OK }),
    fragile: () => ({ content: FRAGILE_OK }),
    reviewer: () => ({ content: reviewerJson() }),
    ...extra,
  });
}

const never = (): Promise<RouteResult> => new Promise(() => {});

async function run(script: ReturnType<typeof scripted>, deps: Partial<DebateDeps> = {}, input = makeInput()) {
  return debate(input, { route: script.route, mode: "on", ...deps });
}

function assertEmptyRejected(d: Debate) {
  assert.equal(d.status, "rejected");
  assert.equal(d.sound, "");
  assert.equal(d.fragile, "");
  assert.equal(d.reviewer, "");
  assert.deepEqual(d.weight, []);
  assert.deepEqual(d.unknown, []);
  assert.equal(d.shown, false);
  assert.ok(d.rejected.length > 0);
}

// ---------------------------------------------------------------------------
// A1 The two advocates are called in parallel with roles sound and fragile,
//    then the reviewer with both texts and the facts.
// ---------------------------------------------------------------------------

test("A1: sound and fragile advocates run in parallel, then the reviewer gets both texts and the facts", async () => {
  let inFlight = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: string[] = [];

  // Neither advocate can finish until both are in flight. A sequential implementation
  // never opens the gate and ends in a timeout, which fails the assertions below.
  const advocate = (content: string): Handler => async (args) => {
    order.push(`start:${args.payload.role}`);
    if (++inFlight === 2) release();
    await gate;
    order.push(`end:${args.payload.role}`);
    return { content };
  };
  const s = scripted({
    sound: advocate(SOUND_OK),
    fragile: advocate(FRAGILE_OK),
    reviewer: (args) => {
      order.push(`start:${args.payload.role}`);
      return { content: reviewerJson() };
    },
  });

  const d = await run(s, { timeoutMs: 1000 });

  assert.equal(d.status, "ok");
  assert.equal(s.calls.length, 3);
  assert.deepEqual(order.slice(0, 2).sort(), ["start:fragile", "start:sound"]);
  assert.equal(order[order.length - 1], "start:reviewer");
  assert.ok(order.indexOf("start:reviewer") > order.indexOf("end:sound"));
  assert.ok(order.indexOf("start:reviewer") > order.indexOf("end:fragile"));

  const byRole = Object.fromEntries(s.calls.map((c) => [c.payload.role, c]));
  assert.deepEqual(Object.keys(byRole).sort(), ["fragile", "reviewer", "sound"]);

  for (const role of ["sound", "fragile"] as const) {
    const c = byRole[role];
    assert.equal(c.task_type, "risk_debate");
    assert.equal(c.tier_class, "text");
    assert.equal(c.complexity, "exec");
    assert.equal(c.constitutional_flag, false);
    assert.equal(c.agent_id, "golden-kog");
    assert.equal(typeof c.context_tokens, "number");
    assert.ok(c.context_tokens > 0);
    assert.ok(c.payload.system.length > 0);
    assert.ok(c.payload.prompt.includes(FACTS));
    assert.ok(c.payload.max_tokens > 0);
  }
  assert.notEqual(byRole.sound.payload.system, byRole.fragile.payload.system);

  const r = byRole.reviewer;
  assert.equal(r.complexity, "apex");
  assert.equal(r.task_type, "risk_debate");
  assert.equal(r.tier_class, "text");
  assert.equal(r.constitutional_flag, false);
  assert.equal(r.agent_id, "golden-kog");
  assert.ok(r.payload.prompt.includes(SOUND_OK));
  assert.ok(r.payload.prompt.includes(FRAGILE_OK));
  assert.ok(r.payload.prompt.includes(FACTS));

  assert.equal(d.sound, SOUND_OK);
  assert.equal(d.fragile, FRAGILE_OK);
  assert.equal(d.reviewer, REVIEWER_TEXT);
});

test("A1: the reviewer sees the kept text of an advocate, not the refused one", async () => {
  const s = happy({ sound: () => ({ content: "The pool holds 99,999 USD." }) });
  const d = await run(s);
  const reviewerCall = s.calls.find((c) => c.payload.role === "reviewer")!;
  assert.ok(!reviewerCall.payload.prompt.includes("99,999"));
  assert.ok(reviewerCall.payload.prompt.includes(NO_CASE_TEXT));
  assert.equal(d.sound, NO_CASE_TEXT);
});

// ---------------------------------------------------------------------------
// A2 A part with a number not in facts_text is replaced (advocate) or drops the
//    debate (reviewer), with the reason kept.
// ---------------------------------------------------------------------------

test("A2: an advocate with a number that is not in the facts is replaced and the reason is kept", async () => {
  const s = happy({ fragile: () => ({ content: "The top 10 holders own 71.2 percent of supply." }) });
  const d = await run(s);

  assert.equal(d.status, "ok");
  // The replacement is exactly this sentence, pinned here on purpose.
  assert.equal(NO_CASE_TEXT, "No case could be written from the measured facts.");
  assert.equal(d.fragile, "No case could be written from the measured facts.");
  assert.equal(d.sound, SOUND_OK);
  assert.equal(d.rejected.length, 1);
  assert.match(d.rejected[0], /^fragile: number 71\.2 is not in facts_text$/);
});

test("A2: numbers must be written the same way as in the facts", async () => {
  for (const bad of ["The pool holds 48200 USD.", "Holders own 62.50 percent.", "The lock ends in 90.0 days."]) {
    const d = await run(happy({ sound: () => ({ content: bad }) }));
    assert.equal(d.sound, NO_CASE_TEXT, bad);
    assert.equal(d.rejected.length, 1, bad);
  }
  // Same way: grouping, decimals, trailing sentence punctuation and units around the number are fine.
  const ok = "The pool holds 48,200, the lock is 90 days and holders own 62.5% of it.";
  const d = await run(happy({ sound: () => ({ content: ok }) }));
  assert.equal(d.sound, ok);
  assert.deepEqual(d.rejected, []);
});

test("A2: extractNumbers reads grouped and decimal numbers as one number", () => {
  assert.deepEqual(extractNumbers("1,234.50 USD, 3, 4 and 12.5%."), ["1,234.50", "3", "4", "12.5"]);
  assert.deepEqual(extractNumbers("no numbers here"), []);
});

test("A2: a reviewer with a number that is not in the facts drops the debate and keeps the reason", async () => {
  const s = happy({ reviewer: () => ({ content: reviewerJson({ text: "The top 25 wallets decide the outcome." }) }) });
  const d = await run(s);

  assertEmptyRejected(d);
  assert.ok(d.rejected.some((r) => /^reviewer: number 25 is not in facts_text$/.test(r)));
});

test("A2: a number in the facts for one part is enough for another part to use it", async () => {
  const d = await run(happy());
  assert.equal(d.status, "ok");
  assert.deepEqual(d.rejected, []);
});

// ---------------------------------------------------------------------------
// A3 A part with a refused word, a long dash, a non Latin digit, too many words
//    or a deps.check problem is refused the same way.
// ---------------------------------------------------------------------------

test("A3: every refused word is refused, for an advocate", async () => {
  assert.equal(REFUSED_WORDS.length, 17);
  for (const word of REFUSED_WORDS) {
    const d = await run(happy({ sound: () => ({ content: `The structure shows ${word} here.` }) }));
    assert.equal(d.sound, NO_CASE_TEXT, word);
    assert.ok(
      d.rejected.some((r) => r === `sound: refused word "${word}"`),
      `${word}: ${JSON.stringify(d.rejected)}`,
    );
    assert.equal(d.status, "ok", word);
  }
});

test("A3: every refused word is refused, for the reviewer, and drops the debate", async () => {
  for (const word of REFUSED_WORDS) {
    const d = await run(happy({ reviewer: () => ({ content: reviewerJson({ text: `The review says ${word}.` }) }) }));
    assertEmptyRejected(d);
    assert.ok(d.rejected.some((r) => r === `reviewer: refused word "${word}"`), word);
  }
});

test("A3: refused words match whole words, any case, any spacing", async () => {
  for (const text of ["It is BULLISH.", "A Price   Target is set.", "Not Financial Advice.", "an exit, then an Entry"]) {
    const d = await run(happy({ fragile: () => ({ content: text }) }));
    assert.equal(d.fragile, NO_CASE_TEXT, text);
  }
  // Words that only contain a refused word are fine.
  const clean = "A bearer token and a gentry wallet appear in the facts.";
  assert.deepEqual(findProblems(clean, new Set(), 50), []);
});

test("A3: long dashes are refused", async () => {
  for (const dash of ["\u2014", "\u2013", "\u2212", "\u2015", "--"]) {
    const d = await run(happy({ sound: () => ({ content: `Mint authority is revoked ${dash} that helps.` }) }));
    assert.equal(d.sound, NO_CASE_TEXT, JSON.stringify(dash));
    assert.ok(d.rejected.includes("sound: long dash"), JSON.stringify(dash));
  }
  // A plain hyphen inside a word is not a long dash.
  assert.deepEqual(findProblems("A well-known lock.", new Set(), 50), []);
});

test("A3: non Latin digits are refused", async () => {
  for (const digit of ["\u0663", "\uFF13", "\u00B2", "\u09E9"]) {
    const d = await run(happy({ fragile: () => ({ content: `Holders own ${digit} wallets.` }) }));
    assert.equal(d.fragile, NO_CASE_TEXT, digit);
    assert.ok(d.rejected.includes("fragile: non Latin digit"), digit);
  }
});

test("A3: word limits are 180 for an advocate and 150 for the reviewer", async () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  assert.equal(MAX_ADVOCATE_WORDS, 180);
  assert.equal(MAX_REVIEWER_WORDS, 150);

  const atLimit = await run(happy({ sound: () => ({ content: words(180) }) }));
  assert.equal(atLimit.sound, words(180));

  const over = await run(happy({ sound: () => ({ content: words(181) }) }));
  assert.equal(over.sound, NO_CASE_TEXT);
  assert.ok(over.rejected.includes("sound: too many words (181, limit 180)"));

  const reviewerAt = await run(happy({ reviewer: () => ({ content: reviewerJson({ text: words(150) }) }) }));
  assert.equal(reviewerAt.status, "ok");
  assert.equal(reviewerAt.reviewer, words(150));

  const reviewerOver = await run(happy({ reviewer: () => ({ content: reviewerJson({ text: words(151) }) }) }));
  assertEmptyRejected(reviewerOver);
  assert.ok(reviewerOver.rejected.includes("reviewer: too many words (151, limit 150)"));
});

test("A3: a deps.check problem refuses the part, and an empty list passes it", async () => {
  const seen: string[] = [];
  const check = (text: string): string[] => {
    seen.push(text);
    return text.includes("pulled soon") ? ["mentions timing"] : [];
  };
  const d = await run(happy(), { check });
  assert.equal(d.sound, NO_CASE_TEXT);
  assert.ok(d.rejected.includes("sound: check: mentions timing"));
  assert.equal(d.fragile, FRAGILE_OK);
  assert.deepEqual(d.rejected.length, 1);
  // The guard sees the sound text, the fragile text and the reviewer text.
  assert.deepEqual(seen, [SOUND_OK, FRAGILE_OK, REVIEWER_TEXT]);

  const clean = await run(happy(), { check: () => [] });
  assert.deepEqual(clean.rejected, []);

  const reviewerGuard = await run(happy(), { check: (t) => (t === REVIEWER_TEXT ? ["no"] : []) });
  assertEmptyRejected(reviewerGuard);
  assert.ok(reviewerGuard.rejected.includes("reviewer: check: no"));
});

test("A3: a guard that throws refuses the part instead of throwing", async () => {
  const d = await run(happy(), {
    check: () => {
      throw new Error("guard down");
    },
  });
  assertEmptyRejected(d);
  assert.ok(d.rejected.some((r) => r.includes("guard down")));
});

test("A3: several problems in one part are all kept", async () => {
  const d = await run(happy({ sound: () => ({ content: "Bullish at 77 \u2014 \u0663 wallets." }) }));
  assert.equal(d.sound, NO_CASE_TEXT);
  const reasons = d.rejected.join("\n");
  assert.match(reasons, /number 77/);
  assert.match(reasons, /refused word "bullish"/);
  assert.match(reasons, /long dash/);
  assert.match(reasons, /non Latin digit/);
});

test("A3: both advocates refused still reaches the reviewer and keeps both reasons", async () => {
  const s = happy({
    sound: () => ({ content: "Bullish." }),
    fragile: () => ({ content: "Bearish." }),
  });
  const d = await run(s);
  assert.equal(d.status, "ok");
  assert.equal(d.sound, NO_CASE_TEXT);
  assert.equal(d.fragile, NO_CASE_TEXT);
  assert.equal(d.rejected.length, 2);
  assert.equal(s.calls.length, 3);
});

// ---------------------------------------------------------------------------
// A4 The reviewer JSON is parsed; weight keeps only known flag ids; unparseable
//    JSON gives status rejected.
// ---------------------------------------------------------------------------

test("A4: the reviewer JSON is parsed and weight keeps only known flag ids", async () => {
  const s = happy({
    reviewer: () => ({
      content: reviewerJson({ weight: ["lp_lock", "invented_rule", "top_holders", "lp_lock", 7, ""] }),
    }),
  });
  const d = await run(s);
  assert.equal(d.status, "ok");
  assert.equal(d.reviewer, REVIEWER_TEXT);
  assert.deepEqual(d.weight, ["lp_lock", "top_holders"]);
  assert.deepEqual(d.unknown, ["holder history"]);
  assert.equal(d.tension, "Locked liquidity against concentrated ownership.");
});

test("A4: weight is empty when the input has no flag ids", async () => {
  const d = await run(happy(), {}, makeInput({ flag_ids: [] }));
  assert.equal(d.status, "ok");
  assert.deepEqual(d.weight, []);
});

test("A4: tension is left out when the reviewer gives none", async () => {
  const withoutKey = await run(happy({ reviewer: () => ({ content: JSON.stringify({ text: REVIEWER_TEXT, weight: [], unknown: [] }) }) }));
  assert.equal(withoutKey.status, "ok");
  assert.equal("tension" in withoutKey, false);

  const blank = await run(happy({ reviewer: () => ({ content: reviewerJson({ tension: "   " }) }) }));
  assert.equal("tension" in blank, false);
});

test("A4: missing weight and unknown lists default to empty", async () => {
  const d = await run(happy({ reviewer: () => ({ content: JSON.stringify({ text: REVIEWER_TEXT }) }) }));
  assert.equal(d.status, "ok");
  assert.deepEqual(d.weight, []);
  assert.deepEqual(d.unknown, []);
});

test("A4: a JSON code fence around the answer is read", async () => {
  const d = await run(happy({ reviewer: () => ({ content: "```json\n" + reviewerJson() + "\n```" }) }));
  assert.equal(d.status, "ok");
  assert.equal(d.reviewer, REVIEWER_TEXT);
});

test("A4: unparseable reviewer JSON gives status rejected with empty texts", async () => {
  for (const content of ["not json at all", "{\"text\": \"cut off", "", "[1, 2]", "null", "{}", "{\"text\": 5}", "{\"text\": \"  \"}"]) {
    const d = await run(happy({ reviewer: () => ({ content }) }));
    assertEmptyRejected(d);
    assert.ok(d.rejected.some((r) => r.startsWith("reviewer:")), content);
  }
});

test("A4: a refused word in the tension drops the debate, one in an unknown line drops only that line", async () => {
  const badTension = await run(happy({ reviewer: () => ({ content: reviewerJson({ tension: "A clear upside exists." }) }) }));
  assertEmptyRejected(badTension);

  const badUnknown = await run(
    happy({ reviewer: () => ({ content: reviewerJson({ unknown: ["holder history", "price target unknown"] }) }) }),
  );
  assert.equal(badUnknown.status, "ok");
  assert.deepEqual(badUnknown.unknown, ["holder history"]);
  assert.ok(badUnknown.rejected.some((r) => r.startsWith("reviewer unknown:")));
});

// ---------------------------------------------------------------------------
// A5 A call over timeoutMs gives status timeout, without throwing.
// ---------------------------------------------------------------------------

test("A5: a reviewer call over timeoutMs gives status timeout without throwing", async () => {
  const started = Date.now();
  const d = await run(happy({ reviewer: never }), { timeoutMs: 40 });
  assert.equal(d.status, "timeout");
  assert.equal(d.shown, false);
  assert.equal(d.reviewer, "");
  assert.ok(Date.now() - started < 2000);
  assert.ok(d.rejected.some((r) => r.startsWith("reviewer:")));
});

test("A5: an advocate call over timeoutMs gives status timeout and the reviewer is never called", async () => {
  const s = happy({ fragile: never });
  const d = await run(s, { timeoutMs: 40 });
  assert.equal(d.status, "timeout");
  assert.equal(d.sound, "");
  assert.equal(d.fragile, "");
  assert.equal(s.calls.filter((c) => c.payload.role === "reviewer").length, 0);
});

test("A5: a late answer after the timeout is ignored", async () => {
  const late = () => new Promise<RouteResult>((resolve) => setTimeout(() => resolve({ content: SOUND_OK, cost_usd: 5 }), 120));
  const d = await run(happy({ sound: late }), { timeoutMs: 30 });
  assert.equal(d.status, "timeout");
  assert.equal(d.usd < 5, true);
  await new Promise((r) => setTimeout(r, 200));
});

test("A5: the timeout applies to each call, so three calls that each stay under it all finish", async () => {
  const slow = (content: string): Handler => () => new Promise((resolve) => setTimeout(() => resolve({ content }), 40));
  const d = await run(
    scripted({ sound: slow(SOUND_OK), fragile: slow(FRAGILE_OK), reviewer: slow(reviewerJson()) }),
    { timeoutMs: 100 },
  );
  assert.equal(d.status, "ok");
});

test("A5: a route that throws never makes debate() throw", async () => {
  const boom: Handler = () => {
    throw new Error("route exploded");
  };
  const advocateDown = await run(happy({ sound: boom }));
  assert.equal(advocateDown.status, "ok");
  assert.equal(advocateDown.sound, NO_CASE_TEXT);
  assert.ok(advocateDown.rejected.some((r) => r.includes("route exploded")));

  const reviewerDown = await run(happy({ reviewer: () => Promise.reject(new Error("reviewer down")) }));
  assertEmptyRejected(reviewerDown);

  const noContent = await run(happy({ reviewer: () => ({}) as RouteResult }));
  assertEmptyRejected(noContent);

  const noRoute = await debate(makeInput(), {} as DebateDeps);
  assert.equal(noRoute.status, "rejected");
});

// ---------------------------------------------------------------------------
// A6 mode off makes no call; shadow logs and returns shown false; on returns
//    shown true; usd sums the calls.
// ---------------------------------------------------------------------------

test("A6: mode off makes no route call and no log", async () => {
  const s = happy();
  const logs: object[] = [];
  const d = await debate(makeInput(), { route: s.route, mode: "off", log: (row) => logs.push(row) });
  assert.equal(s.calls.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(d.status, "off");
  assert.equal(d.shown, false);
  assert.equal(d.usd, 0);
  assert.deepEqual(d.rejected, []);
  assert.equal(d.sound + d.fragile + d.reviewer, "");
});

test("A6: mode shadow runs everything, logs the Debate and returns it with shown false", async () => {
  const s = happy();
  const logs: object[] = [];
  const d = await debate(makeInput(), { route: s.route, mode: "shadow", log: (row) => logs.push(row) });
  assert.equal(s.calls.length, 3);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], d);
  assert.equal(d.status, "ok");
  assert.equal(d.shown, false);
  assert.equal(d.sound, SOUND_OK);
  assert.equal(d.reviewer, REVIEWER_TEXT);
});

test("A6: mode defaults to shadow", async () => {
  const s = happy();
  const logs: object[] = [];
  const d = await debate(makeInput(), { route: s.route, log: (row) => logs.push(row) });
  assert.equal(d.shown, false);
  assert.equal(d.status, "ok");
  assert.equal(logs.length, 1);
  assert.equal(s.calls.length, 3);
});

test("A6: mode on returns shown true", async () => {
  const s = happy();
  const d = await debate(makeInput(), { route: s.route, mode: "on" });
  assert.equal(d.shown, true);
  assert.equal(d.status, "ok");
});

test("A6: shown stays false in mode on when the debate is not ok", async () => {
  const d = await run(happy({ reviewer: () => ({ content: "nope" }) }));
  assert.equal(d.status, "rejected");
  assert.equal(d.shown, false);
});

test("A6: usd sums cost_usd of the calls, models are kept per role", async () => {
  const s = scripted({
    sound: () => ({ content: SOUND_OK, model: "exec-a", cost_usd: 0.1 }),
    fragile: () => ({ content: FRAGILE_OK, model: "exec-b", cost_usd: 0.2 }),
    reviewer: () => ({ content: reviewerJson(), model: "apex-c", cost_usd: 0.3 }),
  });
  const d = await run(s);
  assert.equal(d.usd, 0.6);
  assert.deepEqual(d.models, { sound: "exec-a", fragile: "exec-b", reviewer: "apex-c" });
});

test("A6: usd counts calls whose text was refused, and ignores missing or invalid costs", async () => {
  const s = scripted({
    sound: () => ({ content: "Bullish.", cost_usd: 0.25 }),
    fragile: () => ({ content: FRAGILE_OK }),
    reviewer: () => ({ content: "garbage", cost_usd: Number.NaN }),
  });
  const d = await run(s);
  assert.equal(d.status, "rejected");
  assert.equal(d.usd, 0.25);
});

test("A6: the debate never returns or changes a level or points", async () => {
  const input = Object.freeze(
    makeInput({ flag_ids: Object.freeze(["top_holders", "lp_lock"]) as unknown as string[] }),
  ) as DebateInput;
  const before = JSON.stringify(input);
  const d = await debate(input, { route: happy().route, mode: "on" });
  assert.equal(JSON.stringify(input), before);
  assert.equal("level" in d, false);
  assert.equal("points" in d, false);
  assert.deepEqual(Object.keys(d).sort(), [
    "fragile",
    "models",
    "rejected",
    "reviewer",
    "shown",
    "sound",
    "status",
    "tension",
    "unknown",
    "usd",
    "weight",
  ]);
});

test("A6: a log that throws does not break the debate", async () => {
  const d = await debate(makeInput(), {
    route: happy().route,
    log: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(d.status, "ok");
});

// ---------------------------------------------------------------------------
// A7 The README shows the call flow, the rules, an example Debate, and credits
//    TradingAgents.
// ---------------------------------------------------------------------------

function readme(): string {
  return fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
}

function fenced(md: string, lang: string): string[] {
  return [...md.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
}

test("A7: the README shows the call flow, the rules and an example Debate", () => {
  const md = readme();
  assert.match(md, /^#{1,3} .*call flow/im);
  assert.match(md, /^#{1,3} .*rules/im);
  assert.match(md, /^#{1,3} .*example/im);
  for (const role of ["sound", "fragile", "reviewer"]) assert.ok(md.includes(role), role);
  for (const word of REFUSED_WORDS) assert.ok(md.includes(word), `README lists refused word ${word}`);
  for (const mode of ["off", "shadow", "on"]) assert.ok(md.includes(`\`${mode}\``), mode);
});

test("A7: the README credits TradingAgents", () => {
  const md = readme();
  assert.match(md, /TradingAgents/);
  assert.match(md, /TauricResearch/);
  assert.match(md, /Apache 2\.0/);
  assert.match(md, /without its trader or portfolio manager/i);
});

test("A7: the example Debate in the README is valid and obeys the rules of its own facts", () => {
  const md = readme();
  const [facts] = fenced(md, "text");
  const [exampleJson] = fenced(md, "json");
  assert.ok(facts, "README has a text block with the example facts");
  assert.ok(exampleJson, "README has a json block with the example Debate");

  const example = JSON.parse(exampleJson) as Debate;
  assert.deepEqual(Object.keys(example).sort(), [
    "fragile",
    "models",
    "rejected",
    "reviewer",
    "shown",
    "sound",
    "status",
    "tension",
    "unknown",
    "usd",
    "weight",
  ]);
  assert.equal(example.status, "ok");
  assert.equal(typeof example.shown, "boolean");
  assert.equal(typeof example.usd, "number");

  const factNumbers = new Set(extractNumbers(facts));
  assert.deepEqual(findProblems(example.sound, factNumbers, MAX_ADVOCATE_WORDS), []);
  assert.deepEqual(findProblems(example.fragile, factNumbers, MAX_ADVOCATE_WORDS), []);
  assert.deepEqual(findProblems(example.reviewer, factNumbers, MAX_REVIEWER_WORDS), []);
});
