@AGENTS.md

## graphify

When `graphify-out/graph.json` exists, use Graphify for code navigation.

Rules:
- Start codebase questions with `graphify query "<question>"`. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused questions.
- Use `graphify-out/wiki/index.md` for broad navigation when it exists. Read `graphify-out/GRAPH_REPORT.md` when the focused commands do not answer the question.
- After code changes, run `PYTHONHASHSEED=0 graphify update .` for a local AST refresh. Documentation edits do not require semantic re-extraction.
