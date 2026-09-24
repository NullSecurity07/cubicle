# Graph Report - shop  (2026-09-24)

## Corpus Check
- 2 files · ~22 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5 nodes · 7 edges · 2 communities (0 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- a
- x.ts

## God Nodes (most connected - your core abstractions)
1. `a()` - 4 edges
2. `b()` - 2 edges
3. `main()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `a()`  [EXTRACTED]
  src/y.ts → src/x.ts

## Import Cycles
- None detected.

## Communities (2 total, 2 thin omitted)

## Knowledge Gaps
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `a()` connect `a` to `x.ts`?**
  _High betweenness centrality (0.333) - this node is a cross-community bridge._