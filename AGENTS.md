# Agent instructions

## E2E testing

Before changing the tool contract, request normalization, TUI form, result presentation, remote data sources, packaging, or supported Pi runtime:

1. Read `docs/e2e-test-requirements.md` completely before editing or testing.
2. Run `npm run typecheck` and `npm test` before declaring the work complete.
3. Validate user-visible behavior through the real Pi CLI PTY. Valid JSON or correct tool-call arguments alone are not sufficient evidence.
4. For remote data-source changes, run `npm run mock:api` and execute the documented search, pagination, and tree-selection scenario.
5. For releases, test the exact npm artifact by setting `PI_ACCEPTANCE_PACKAGE_SOURCE` to the version being released.

Do not weaken, skip, or replace the documented E2E requirements without explicit user approval. Keep detailed scenarios in `docs/e2e-test-requirements.md` rather than duplicating them here.
