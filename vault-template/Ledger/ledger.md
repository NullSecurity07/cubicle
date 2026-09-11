---
currency: USD
opened: "2026-09-12T00:00:00.000Z"
---
# Ledger

Every movement of money, one row per entry, oldest first.

**Append only.** Nothing ever edits a row that is already here — a mistake is corrected with a second row
that cancels it out, so the history stays true. `capital` is money you put in; `revenue` is money coming in;
`cost` is money going out. `mode: mock` means a simulation, and it never counts as cash.

| at | kind | amount | mode | who | why | ref |
|---|---|---|---|---|---|---|
