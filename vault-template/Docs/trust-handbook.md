---
generated: false
---
# What gets reviewed before it leaves

Nothing leaves this company without two offices having read the exact thing that is leaving. Not a summary of
it: the tool, the arguments and the body text, verbatim.

## What counts as leaving

`config/tools.yaml` decides, with one flag per tool. Today: sending an email, posting publicly, submitting a
form in the browser, creating a payment link, and deploying to **live**. A preview or a canary deploy is an
internal step and is not reviewed, and neither is a rollback — it republishes bytes that a live deploy already
passed, and an incident recovery that waits for two review jobs is an incident that lasts longer.

A mock adapter changes nothing. Whether the company has an API key is an accident of your setup, never a reason
to skip a review.

## Who reviews it

The compliance office (`office:compliance.review`) asks the five questions that make an outbound action
defensible: is the claim true, did the recipient agree to hear from us, does it obey the constitution's banned
channels and tactics, is there a way out, and would you be content to see this in public with your name on it.

The security office (`office:security.review`) asks what data, credentials and permissions the action exposes,
and whether the destination is the one we meant.

Both are named by **office**, not by person: re-staff a seat in `Memory/constitution.md` and the review moves
with it. Nobody reviews their own send; if there is genuinely nobody else, no review happens and the call stays
refused. That is deliberate. A gate whose purpose is to stop things fails closed.

## What a verdict does

Two passes and the action runs. One return and it never does — the proposal closes unsent with the findings, and
the author files a fresh call once they have fixed what was named. That holds even if you had already approved
it: the approval was given to a draft the company's own compliance office has since faulted, and sending it
anyway would make the review decorative. Your route is the fresh proposal, or an `approvals:` entry in
`Memory/owner_preferences.md`.

While the reviews are out, nothing is spent and nothing is marked as sent, so a verdict that arrives ten minutes
later still sends.
