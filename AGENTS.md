# AGENTS.md

This public repository is generated output, not a canonical editing surface.

- Never add private drafts, hidden notes, prompts, raw transcripts, API keys, tokens, credentials, or `.env` files.
- Do not publish sample, seed, demo, or meta-only records as real activity.
- Preserve the manifest contract and locale-separated output structure.
- Changes should be produced by the future studio publisher and validated before push.
- Do not add website components, authoring tools, or backend code here.
- Treat `schemas/` and `dist/feed-validate.cjs` as the canonical public boundary. Do not duplicate or weaken the contract in consumers.
- Run `npm test` and `npm run feed:validate` after contract or generated-output changes.
- Keep omitted evidence omitted. Never supply empty, synthetic, inferred, or epoch-dated values to satisfy a consumer.
- Preserve stable IDs, `translationKey`, `canonicalSlug`, and `aliases`; slug changes require an alias.
- Activity means reading sessions, distinct papers touched, minutes, completed passes, revisits, implementations, and deep sessions. Do not relabel these dimensions.
- Weekly review and graph records use their native schema and eligibility state. Do not derive them in the website.
- Assets are content-addressed and declared in `assets/index.json`; do not commit untracked asset paths.
