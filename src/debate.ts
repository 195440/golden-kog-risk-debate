// Golden Kog risk debate module.
//
// A two sided structure debate for a token risk analysis: two advocates argue from
// measured facts (one for a sound structure, one for a fragile structure), then a
// reviewer weighs them. It is a risk tool, never a trading tool: no buy or sell view,
// no price target, no entry or exit, no advice, and it never returns or changes a
// risk level or points.
//
// The pattern is adapted from TradingAgents (TauricResearch, Apache 2.0), without its
// trader or portfolio manager. See README.md for the credit.
//
// No runtime dependency. Node 22. Only erasable TypeScript syntax is used so the file
// runs with `node --experimental-strip-types`.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = "sound" | "fragile" | "reviewer";
export type DebateMode = "off" | "shadow" | "on";
export type DebateStatus = "ok" | "rejected" | "timeout" | "off";

export interface DebateInput {
  /** Block of measured facts, one fact per line, every number already computed. */
  facts_text: string;
  level: string;
  points: number;
  /** Ids of the risk rules that fired. */
  flag_ids: string[];
  /** Things the analysis could not measure. */
  unknown: string[];
}

export interface RouteArgs {
  task_type: "risk_debate";
  tier_class: "text";
  complexity: "exec" | "apex";
  context_tokens: number;
  constitutional_flag: false;
  agent_id: "golden-kog";
  payload: {
    role: Role;
    system: string;
    prompt: string;
    max_tokens: number;
  };
}

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export interface DebateDeps {
  route(args: RouteArgs): Promise<RouteResult>;
  /** Extra problems from the caller's guard. An empty list means the text is fine. */
  check?(text: string): string[];
  /** Default 'shadow'. */
  mode?: DebateMode;
  log?(row: object): void;
  /** Per call timeout. Default 45000. */
  timeoutMs?: number;
}

export interface Debate {
  status: DebateStatus;
  shown: boolean;
  sound: string;
  fragile: string;
  reviewer: string;
  weight: string[];
  unknown: string[];
  tension?: string;
  models: { sound?: string; fragile?: string; reviewer?: string };
  usd: number;
  rejected: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NO_CASE_TEXT = "No case could be written from the measured facts.";
export const MAX_ADVOCATE_WORDS = 180;
export const MAX_REVIEWER_WORDS = 150;
export const DEFAULT_TIMEOUT_MS = 45000;

/** Words and phrases that no part may contain (whole word, case insensitive). */
export const REFUSED_WORDS: readonly string[] = [
  "bull",
  "bear",
  "bullish",
  "bearish",
  "upside",
  "downside target",
  "undervalued",
  "overvalued",
  "accumulate",
  "moon",
  "buy now",
  "sell now",
  "price target",
  "entry",
  "exit",
  "take profit",
  "not financial advice",
];

const ADVOCATE_MAX_TOKENS = 400;
const REVIEWER_MAX_TOKENS = 600;

// ---------------------------------------------------------------------------
// Rules every part must pass
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";
const REFUSED_WORDS_RE = new RegExp(
  `(?<!${WORD_CHAR})(?:${REFUSED_WORDS.map((w) => w.split(/\s+/).map(escapeRegExp).join("\\s+")).join("|")})(?!${WORD_CHAR})`,
  "giu",
);

// Long dashes (figure dash, en dash, em dash, horizontal bar, minus sign, two and three
// em dashes, small and fullwidth hyphen minus) and the double hyphen used as a dash.
const LONG_DASH_RE = /[\u2012-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]|--/u;

// Any numeric character that is not 0 to 9: Arabic Indic, fullwidth, superscript, fractions...
const NON_LATIN_DIGIT_RE = /(?![0-9])\p{N}/u;

const NUMBER_RE = /[0-9]+(?:[.,][0-9]+)*/g;

/** Numbers as they are written in a text: "1,234.50" is one number, "3, 4" is two. */
export function extractNumbers(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Check one part against the rules. Returns the list of problems, empty when the part passes.
 * - every number appears in the facts, written the same way
 * - no refused word
 * - Latin digits only and no long dash
 * - at most `maxWords` words
 * - `deps.check` returns nothing
 */
export function findProblems(
  text: string,
  factNumbers: ReadonlySet<string>,
  maxWords: number,
  check?: (text: string) => string[],
): string[] {
  const problems: string[] = [];

  if (text.trim() === "") problems.push("empty text");

  const seenNumbers = new Set<string>();
  for (const n of extractNumbers(text)) {
    if (!factNumbers.has(n) && !seenNumbers.has(n)) {
      seenNumbers.add(n);
      problems.push(`number ${n} is not in facts_text`);
    }
  }

  const seenWords = new Set<string>();
  for (const m of text.matchAll(REFUSED_WORDS_RE)) {
    const w = m[0].toLowerCase().replace(/\s+/g, " ");
    if (!seenWords.has(w)) {
      seenWords.add(w);
      problems.push(`refused word "${w}"`);
    }
  }

  if (LONG_DASH_RE.test(text)) problems.push("long dash");
  if (NON_LATIN_DIGIT_RE.test(text)) problems.push("non Latin digit");

  const words = countWords(text);
  if (words > maxWords) problems.push(`too many words (${words}, limit ${maxWords})`);

  if (check) {
    try {
      const extra = check(text);
      if (Array.isArray(extra)) {
        for (const p of extra) problems.push(`check: ${String(p)}`);
      }
    } catch (e) {
      problems.push(`check: guard threw (${errorMessage(e)})`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function rulesBlock(maxWords: number): string {
  return [
    "Rules for everything you write:",
    "1. Use only the measured facts you are given. Every number you write must appear in the facts exactly as it is written there. Do not compute, round, convert or invent numbers. Do not number list items.",
    `2. At most ${maxWords} words, plain prose, no headings, no lists.`,
    "3. Latin digits 0 to 9 only.",
    "4. Never use long dashes (em dash, en dash, minus sign) or double hyphens.",
    `5. Never use these words or phrases: ${REFUSED_WORDS.join(", ")}.`,
    "6. This is a risk review, never a trading view: no buy or sell view, no price target, no entry or exit, no advice.",
    "7. The risk level and points are context only. Do not restate or change them.",
  ].join("\n");
}

function advocateSystem(role: "sound" | "fragile"): string {
  const stance =
    role === "sound"
      ? "You argue that the token structure is sound: you make the strongest case from the measured facts that the structure holds up."
      : "You argue that the token structure is fragile: you make the strongest case from the measured facts that the structure is exposed.";
  return [
    "You are one advocate in a token structure risk debate.",
    stance,
    "Argue only from facts that are given. Name the facts you lean on. Do not argue the other side.",
    `If the facts do not support your case, answer exactly: ${NO_CASE_TEXT}`,
    rulesBlock(MAX_ADVOCATE_WORDS),
  ].join("\n\n");
}

const REVIEWER_SYSTEM = [
  "You are the reviewer in a token structure risk debate. Two advocates argued from the same measured facts, one for a sound structure and one for a fragile structure.",
  "Weigh the two cases against the facts. Say which claims the facts support and which they do not. Do not add facts of your own.",
  'Answer with JSON only, no other text: {"text": string, "weight": string[], "unknown": string[], "tension": string}.',
  '"text" is your weighing. "weight" lists the ids of the fired risk rules (only ids from the list you are given) that weigh most on the structure. "unknown" lists what the facts leave unknown. "tension" is one sentence naming the main disagreement between the advocates, and may be left out.',
  rulesBlock(MAX_REVIEWER_WORDS),
].join("\n\n");

function levelLine(input: DebateInput): string {
  return `Risk level: ${input.level}. Points: ${input.points}. (Context only, do not restate.)`;
}

function flagsLine(flagIds: string[]): string {
  return flagIds.length > 0 ? flagIds.join(", ") : "none";
}

function unknownBlock(unknown: string[]): string {
  return unknown.length > 0 ? unknown.map((u) => `- ${u}`).join("\n") : "none";
}

function advocatePrompt(input: DebateInput): string {
  return [
    levelLine(input),
    `Fired risk rule ids: ${flagsLine(input.flag_ids)}`,
    "Measured facts:",
    input.facts_text,
    "Not measured:",
    unknownBlock(input.unknown),
    "Write your case now.",
  ].join("\n");
}

function reviewerPrompt(input: DebateInput, sound: string, fragile: string): string {
  return [
    levelLine(input),
    `Fired risk rule ids: ${flagsLine(input.flag_ids)}`,
    "Measured facts:",
    input.facts_text,
    "Not measured:",
    unknownBlock(input.unknown),
    "Advocate for a sound structure:",
    sound,
    "Advocate for a fragile structure:",
    fragile,
    "Write your review now, as JSON only.",
  ].join("\n");
}

function estimateTokens(system: string, prompt: string): number {
  return Math.ceil((system.length + prompt.length) / 4);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

type Settled =
  | { kind: "ok"; content: string; model?: string; cost: number }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeResult(r: unknown): Settled {
  if (r === null || typeof r !== "object") return { kind: "error", message: "route returned no result" };
  const row = r as Partial<RouteResult>;
  if (typeof row.content !== "string") return { kind: "error", message: "route returned no content" };
  const cost = typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0 ? row.cost_usd : 0;
  const out: Settled = { kind: "ok", content: row.content, cost };
  if (typeof row.model === "string" && row.model !== "") out.model = row.model;
  return out;
}

/** Start the call right away (synchronously) and settle within `timeoutMs`. Never rejects. */
function callWithTimeout(route: DebateDeps["route"], args: RouteArgs, timeoutMs: number): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    let done = false;
    const finish = (s: Settled) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    try {
      Promise.resolve(route(args)).then(
        (r) => finish(normalizeResult(r)),
        (e) => finish({ kind: "error", message: errorMessage(e) }),
      );
    } catch (e) {
      finish({ kind: "error", message: errorMessage(e) });
    }
  });
}

function makeArgs(role: Role, system: string, prompt: string): RouteArgs {
  return {
    task_type: "risk_debate",
    tier_class: "text",
    complexity: role === "reviewer" ? "apex" : "exec",
    context_tokens: estimateTokens(system, prompt),
    constitutional_flag: false,
    agent_id: "golden-kog",
    payload: {
      role,
      system,
      prompt,
      max_tokens: role === "reviewer" ? REVIEWER_MAX_TOKENS : ADVOCATE_MAX_TOKENS,
    },
  };
}

// ---------------------------------------------------------------------------
// Reviewer JSON
// ---------------------------------------------------------------------------

interface ReviewerParts {
  text: string;
  weight: string[];
  unknown: string[];
  tension?: string;
}

function parseJsonLoose(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // A model may wrap the JSON in a code fence. Nothing else is tolerated.
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) return JSON.parse(fenced[1]);
    throw new Error("not JSON");
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "");
}

function parseReviewer(content: string): { ok: true; parts: ReviewerParts } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = parseJsonLoose(content);
  } catch {
    return { ok: false, reason: "reviewer: answer is not parseable JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "reviewer: JSON is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.text !== "string" || obj.text.trim() === "") {
    return { ok: false, reason: "reviewer: JSON has no text" };
  }
  const parts: ReviewerParts = {
    text: obj.text.trim(),
    weight: stringList(obj.weight),
    unknown: stringList(obj.unknown),
  };
  if (typeof obj.tension === "string" && obj.tension.trim() !== "") parts.tension = obj.tension.trim();
  return { ok: true, parts };
}

// ---------------------------------------------------------------------------
// debate()
// ---------------------------------------------------------------------------

function roundUsd(n: number): number {
  return Math.round(n * 1e12) / 1e12;
}

function normalizeMode(mode: unknown): DebateMode {
  return mode === "off" || mode === "on" || mode === "shadow" ? mode : "shadow";
}

function normalizeTimeout(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

function emptyDebate(status: DebateStatus): Debate {
  return {
    status,
    shown: false,
    sound: "",
    fragile: "",
    reviewer: "",
    weight: [],
    unknown: [],
    models: {},
    usd: 0,
    rejected: [],
  };
}

function safeLog(log: DebateDeps["log"], row: Debate): void {
  if (typeof log !== "function") return;
  try {
    log(row);
  } catch {
    // A failing logger must never break the risk analysis.
  }
}

/**
 * Run the debate. Never throws and never returns or changes a level or points.
 *
 * Flow: advocates `sound` and `fragile` in parallel, each part checked against the rules;
 * then the `reviewer` gets both advocate texts and the facts and answers JSON.
 */
export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode = normalizeMode(deps?.mode);
  if (mode === "off") return emptyDebate("off");

  const result = await run(input, deps);
  result.shown = mode === "on" && result.status === "ok";
  safeLog(deps?.log, result);
  return result;
}

async function run(rawInput: DebateInput, deps: DebateDeps): Promise<Debate> {
  const out = emptyDebate("rejected");

  if (!deps || typeof deps.route !== "function") {
    out.rejected.push("deps.route is not a function");
    return out;
  }

  const input: DebateInput = {
    facts_text: typeof rawInput?.facts_text === "string" ? rawInput.facts_text : "",
    level: String(rawInput?.level ?? ""),
    points: Number(rawInput?.points ?? 0),
    flag_ids: stringList(rawInput?.flag_ids),
    unknown: stringList(rawInput?.unknown),
  };
  const timeoutMs = normalizeTimeout(deps.timeoutMs);
  const factNumbers = new Set(extractNumbers(input.facts_text));
  const check = typeof deps.check === "function" ? deps.check.bind(deps) : undefined;

  let usd = 0;
  const account = (role: Role, s: Settled) => {
    if (s.kind === "ok") {
      usd += s.cost;
      if (s.model) out.models[role] = s.model;
    }
  };

  // Advocates: both calls start in the same tick and run in parallel.
  const advocateArgs = (role: "sound" | "fragile") => {
    const system = advocateSystem(role);
    return makeArgs(role, system, advocatePrompt(input));
  };
  const [soundCall, fragileCall] = await Promise.all([
    callWithTimeout(deps.route, advocateArgs("sound"), timeoutMs),
    callWithTimeout(deps.route, advocateArgs("fragile"), timeoutMs),
  ]);
  account("sound", soundCall);
  account("fragile", fragileCall);

  let timedOut = false;
  const advocateText = (role: "sound" | "fragile", s: Settled): string => {
    if (s.kind === "timeout") {
      timedOut = true;
      out.rejected.push(`${role}: call timed out after ${timeoutMs} ms`);
      return "";
    }
    if (s.kind === "error") {
      out.rejected.push(`${role}: call failed (${s.message})`);
      return NO_CASE_TEXT;
    }
    const text = s.content.trim();
    const problems = findProblems(text, factNumbers, MAX_ADVOCATE_WORDS, check);
    if (problems.length > 0) {
      for (const p of problems) out.rejected.push(`${role}: ${p}`);
      return NO_CASE_TEXT;
    }
    return text;
  };
  const sound = advocateText("sound", soundCall);
  const fragile = advocateText("fragile", fragileCall);

  if (timedOut) {
    out.status = "timeout";
    out.usd = roundUsd(usd);
    return out;
  }

  // Reviewer: gets both advocate texts (as kept after the rules) and the facts.
  const reviewerArgs = makeArgs("reviewer", REVIEWER_SYSTEM, reviewerPrompt(input, sound, fragile));
  const reviewerCall = await callWithTimeout(deps.route, reviewerArgs, timeoutMs);
  account("reviewer", reviewerCall);
  out.usd = roundUsd(usd);

  if (reviewerCall.kind === "timeout") {
    out.status = "timeout";
    out.rejected.push(`reviewer: call timed out after ${timeoutMs} ms`);
    return out;
  }
  if (reviewerCall.kind === "error") {
    out.rejected.push(`reviewer: call failed (${reviewerCall.message})`);
    return out;
  }

  const parsed = parseReviewer(reviewerCall.content);
  if (!parsed.ok) {
    out.rejected.push(parsed.reason);
    return out;
  }
  const { parts } = parsed;

  // deps.check sees each of the three parts once. The tension and unknown lines, which people
  // also see, go through the built in rules only.
  const reviewerProblems = findProblems(parts.text, factNumbers, MAX_REVIEWER_WORDS, check);
  if (parts.tension !== undefined) {
    for (const p of findProblems(parts.tension, factNumbers, MAX_REVIEWER_WORDS)) {
      reviewerProblems.push(`tension ${p}`);
    }
  }
  if (reviewerProblems.length > 0) {
    for (const p of reviewerProblems) out.rejected.push(`reviewer: ${p}`);
    return out;
  }

  // Unknown items are shown to people too: keep only the ones that pass the text hygiene rules.
  const unknown: string[] = [];
  for (const u of parts.unknown) {
    const hygiene = findProblems(u, factNumbers, Number.MAX_SAFE_INTEGER).filter(
      (p) => !p.startsWith("number "),
    );
    if (hygiene.length > 0) {
      for (const p of hygiene) out.rejected.push(`reviewer unknown: ${p}`);
    } else {
      unknown.push(u);
    }
  }

  const known = new Set(input.flag_ids);
  const weight: string[] = [];
  for (const id of parts.weight) {
    if (known.has(id) && !weight.includes(id)) weight.push(id);
  }

  out.status = "ok";
  out.sound = sound;
  out.fragile = fragile;
  out.reviewer = parts.text;
  out.weight = weight;
  out.unknown = unknown;
  if (parts.tension !== undefined) out.tension = parts.tension;
  return out;
}
