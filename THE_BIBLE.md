
---

## 10. Earned-autonomy mechanism (design note — intended for Milestone 5)

The concrete gate behind "autonomy is earned" (§0, §2.5). Not built; records the design so
it isn't lost.

**How it works:** each autonomy-capable action type is gated per function. While gated,
marionette proposes the action and records what it *would* do, but asks Bentley first.
Bentley approves or rejects. A decision counts as **correct** only when BOTH: (a) Bentley
approved it, and (b) the outcome was the desired one / it worked.

**Outcome is resolved after the fact** (not known at approval time): self-detected where the
action type allows a check (draft exists in Gmail, event on calendar), Bentley-marked
otherwise.

**Rides entirely on `audit_log`** — proposal row written with `outcome=null`, backfilled on
resolution. No new table (guardrail §9.4). Accuracy counts only resolved rows.

**Unlock / re-lock:** once a function's rolling accuracy clears the threshold over a minimum
sample, it unlocks to auto. If accuracy later drops below threshold on continued shadow
evaluation, it re-locks. Earned, not earned-once-kept-forever.

**Placement:** decision logic lives in marionette (it's reasoning about whether to act), not
api.

**Open knobs (Bentley's call, settle at M5):**
- threshold % and rolling window size
- minimum sample before unlock is eligible
- per-risk-tier bars — high-blast-radius actions (e.g. send email) graduate to
  "auto-draft, you send," never full auto-send
- null-outcome timeout rule (what happens to proposals whose outcome is never resolved)
