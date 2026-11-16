# Reckon spec — index

**Reckon: Reality keeps score.** Reckon makes small, concrete predictions about your near future, checks every one of them against reality, and shows you exactly how trustworthy each kind of prediction is.

This folder is the full product and engineering specification, exported from the living spec doc (Oct 5, 2026) and split for easier reading. Read it in this order:

| File | Covers | Read when |
| --- | --- | --- |
| [01-product.md](01-product.md) | Vision, goals, principles, daily loop, engagement, minimal-input policy | First, to understand what you are building and why |
| [02-architecture.md](02-architecture.md) | Stack, layering, patterns, domain model, schema, API, engineering standards | Before touching code |
| [03-forecasting.md](03-forecasting.md) | Data sources, question engine, forecasters, resolution and jobs, scoring, news pipeline | Before Phase 1 and every later phase |
| [04-design.md](04-design.md) | Visual direction, tokens, screens, PWA, accessibility | Before any UI work |
| [05-operations.md](05-operations.md) | Security, privacy, operations, cost and credit budgets | Before deploying |
| [06-roadmap.md](06-roadmap.md) | Phased plan with tasks and acceptance criteria, risks, open decisions, glossary | To pick the next task |

Decisions that deviate from or refine the spec are recorded in [../adr](../adr). When the spec and an ADR disagree, the newer ADR wins.
