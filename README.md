# golden-kog-risk-debate

A small TypeScript module that adds a two sided structure debate to a token risk analysis. Two advocates argue from measured facts, one for a sound structure and one for a fragile structure, then a reviewer weighs them.

It is a risk tool, never a trading tool: no buy or sell view, no price target, no entry or exit, no advice. The debate never returns or changes a risk level or points. It is meant to be wired into Golden Kog, the Solana and Base token risk agent.

- No runtime dependency. Node 22. One file: `src/debate.ts`.
- Only erasable TypeScript syntax, so it runs as is with `node --experimental-strip-types`.

```ts
import { debate } from "./src/debate.ts";

const result = await debate(input, { route, mode: "shadow", log });
```

## Interface

`debate(input, deps) -> Promise<Debate>`

`input`: `{ facts_text, level, points, flag_ids, unknown }`

- `facts_text`: the block of measured facts, one fact per line, every number already computed.
- `level`, `points`: context for the prompts only. They are never returned or changed.
- `flag_ids`: ids of the risk rules that fired.
- `unknown`: what could not be measured.

`deps`: `{ route, check?, mode?, log?, timeoutMs? }`

- `route(args) -> Promise<{ content, model?, cost_usd? }>` is the model router. `args` is `{ task_type: "risk_debate", tier_class: "text", complexity, context_tokens, constitutional_flag: false, agent_id: "golden-kog", payload: { role, system, prompt, max_tokens } }`.
- `check?(text) -> string[]` is the caller's own guard. It returns extra problems, an empty list means fine. It is called once for each of the sound text, the fragile text and the reviewer text.
- `mode?`: `off`, `shadow` (default) or `on`.
- `log?(row)` receives the finished `Debate`.
- `timeoutMs?` is the limit for each call, default 45000.

## Call flow

```
input ──► mode "off"? ──yes──► { status: "off" }, no call, no log
             │ no
             ▼
   ┌─────────────────────────────┐   in parallel, complexity "exec"
   │ route(role "sound")         │
   │ route(role "fragile")       │
   └─────────────────────────────┘
             │ each text is checked against the rules (below)
             │ a failing text becomes "No case could be written from the measured facts."
             │ and its reasons go in `rejected`
             │ a call over timeoutMs ──► status "timeout" (the reviewer is not called)
             ▼
   route(role "reviewer")            complexity "apex"
   gets: both advocate texts (as kept) and facts_text, answers JSON
   { text, weight: string[], unknown: string[], tension?: string }
             │ call over timeoutMs ──► status "timeout"
             │ unparseable JSON, or text that fails the rules ──► status "rejected", empty texts
             ▼
   weight keeps only ids present in flag_ids
             ▼
   Debate { status: "ok", ... }
             ▼
   mode "shadow": log(Debate), return it with shown: false
   mode "on":     log(Debate), return it with shown: true
```

`debate()` never throws. A route that throws is treated like a failed part: an advocate is replaced, a reviewer failure gives status `rejected`.

### Modes

| mode | route calls | `log` | `shown` |
| --- | --- | --- | --- |
| `off` | none | not called | `false` |
| `shadow` | 3 | called with the Debate | `false` |
| `on` | 3 | called with the Debate | `true` when `status` is `ok` |

### Debate

```
status    "ok" | "rejected" | "timeout" | "off"
shown     boolean
sound     string          advocate for a sound structure, or the "No case" sentence
fragile   string          advocate for a fragile structure, or the "No case" sentence
reviewer  string          the reviewer's weighing
weight    string[]        fired rule ids the reviewer weighs most, only ids from flag_ids
unknown   string[]        what the reviewer says the facts leave open
tension   string?         left out when the reviewer gives none
models    { sound?, fragile?, reviewer? }
usd       number          sum of cost_usd of the calls, refused texts included
rejected  string[]        every reason a part was refused
```

When the status is `rejected`, `timeout` or `off`, the three texts are empty.

## Rules every part must pass

Each advocate text and the reviewer text must pass all of these. The reviewer's tension line passes the built in rules too.

1. Every number in it appears in `facts_text`, written the same way. `1,234.50` is one number. `48200` does not match `48,200`, `62.50` does not match `62.5`.
2. None of these words or phrases, whole word, any case: `bull`, `bear`, `bullish`, `bearish`, `upside`, `downside target`, `undervalued`, `overvalued`, `accumulate`, `moon`, `buy now`, `sell now`, `price target`, `entry`, `exit`, `take profit`, `not financial advice`.
3. `deps.check(text)` returns nothing.
4. At most 180 words for an advocate and 150 for the reviewer.
5. Latin digits only, and no long dash (en dash, em dash, minus sign, double hyphen).

A failing advocate is replaced by exactly `No case could be written from the measured facts.` and its reasons are kept in `rejected`, for example `sound: number 71.2 is not in facts_text` or `fragile: refused word "bullish"`. A failing or unparseable reviewer gives status `rejected` with empty texts.

## Example

Facts:

```text
Top 10 holders own 62.5 percent of supply.
Liquidity pool holds 48,200 USD.
Liquidity lock ends in 90 days.
Deployer wallet holds 4.1 percent of supply.
Mint authority is revoked.
```

With `level: "MEDIUM"`, `points: 37`, `flag_ids: ["top_holders", "lp_lock", "deployer_share"]`, `mode: "on"`, and a reviewer that also names a rule id that did not fire (`made_up_rule`, dropped from `weight`), `debate()` returns:

```json
{
  "status": "ok",
  "shown": true,
  "sound": "Mint authority is revoked, so no new supply can be created. The liquidity pool holds 48,200 USD and the lock runs for another 90 days, so the pool cannot be pulled in the near term. The deployer wallet holds only 4.1 percent of supply.",
  "fragile": "The top 10 holders own 62.5 percent of supply, so a small group can move the market on its own. Once the lock ends in 90 days the pool of 48,200 USD is no longer held in place, and the deployer wallet still holds 4.1 percent of supply.",
  "reviewer": "Both cases rest on measured facts. The revoked mint and the 90 day lock support the sound case. The 62.5 percent held by 10 wallets supports the fragile case, and the lock only delays that concern. Holder history is not measured, so how long these wallets have held is open.",
  "weight": ["top_holders", "lp_lock"],
  "unknown": ["holder history"],
  "models": { "sound": "exec-model", "fragile": "exec-model", "reviewer": "apex-model" },
  "usd": 0.0136,
  "rejected": [],
  "tension": "A locked pool against concentrated ownership."
}
```

## Tests

```bash
npm test
```

`test/debate.test.ts` has tests named after the acceptance items they prove, `A1` to `A7`, and runs without network. `npm run typecheck` runs `tsc` on `src` when TypeScript is installed.

## Credit

The debate pattern is adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) (TauricResearch, Apache 2.0), without its trader or portfolio manager. Only the two sided advocate and reviewer idea is used, and it is pointed at token structure risk instead of trading decisions.

## License

MIT, see `LICENSE`.
