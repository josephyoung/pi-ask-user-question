# E2E test requirements

Changes to the tool contract, normalization, TUI form, result presentation, remote data sources, packaging, or supported Pi runtime must satisfy these requirements before release.

## Execution boundary

An E2E result is valid only when it:

- launches the real `pi` executable in an interactive PTY;
- installs the extension into isolated Pi and project state, from either a Git snapshot or the exact npm artifact being released;
- drives the rendered TUI with real keyboard input instead of calling form methods directly;
- asserts the visible defaults and labels, the canonical tool-result IDs, Agent continuation, and process exit code `0`;
- fails on an uncaught render/input error, a missing interaction step, an incorrect result, a timeout, or an unexpected Pi exit;
- runs without depending on the developer's global Pi extensions or project context files.

Unit tests and JSON-schema checks are required but do not replace these E2E assertions.

## Core scenario matrix

The real Pi acceptance suite must cover all of the following scenarios.

1. **Structured grouped defaults**
   - Render object options whose IDs include both numbers and strings.
   - Accept defaults supplied as labels, canonical IDs, typed keys such as `string:0`, and JSON-stringified multiple defaults.
   - Show labels in the TUI and result card while returning canonical IDs in the tool result.

2. **Multiple choice**
   - Render every configured default as selected.
   - Toggle with `Space`, submit with `Enter` or `Ctrl+S`, and do not accidentally toggle a selection when submitting.
   - Preserve selection order and return the selected canonical IDs.

3. **Date input**
   - Render the configured `dateFormat` and default.
   - Reject an invalid format/default combination before opening the TUI.
   - Return the final user-entered date string unchanged.

4. **Optional select and tree select**
   - Render hierarchy only for `treeSelect`.
   - Allow an optional recommendation to be cleared and omit the cleared field from grouped results.
   - Return a selected child ID rather than its label or parent object.

5. **Atomic grouped form**
   - Render text, textarea, single choice, multiple choice, and date questions in one form.
   - Preserve answers while navigating with `Tab` and `Shift+Tab`.
   - Validate all required fields and submit exactly one answer object.

6. **Cancellation and Agent abort**
   - Treat `Esc` as cancellation and `Ctrl+C` or an aborted Agent signal as an abort.
   - Never report `undefined` as a successful answer when abort and custom-UI settlement race.
   - Release pending form state so the next Agent turn can open a fresh question.

## Remote pagination mock API

Run the repository mock API before the manual remote-data-source scenario:

```sh
npm run mock:api
```

The server must listen on `http://127.0.0.1:3000` and provide:

- `GET /health` returning HTTP `200` with `{ "status": "ok" }`;
- `GET /api/projects?q=&page=&limit=`;
- project records with `id`, `name`, optional `children`, and `description`;
- a response shaped as `payload.rows` and `payload.total`;
- deterministic search and pagination suitable for repeated local runs.

Use this `ask_user_question` data source configuration:

```json
{
  "question": "选择远程项目",
  "inputType": "treeSelect",
  "default": "project-1",
  "dataSource": {
    "type": "api",
    "endpoint": "/api/projects",
    "method": "GET",
    "searchParam": "q",
    "pageParam": "page",
    "pageSizeParam": "limit",
    "pageSize": 2,
    "resultPath": "payload.rows",
    "totalPath": "payload.total",
    "idField": "id",
    "labelField": "name",
    "childrenField": "children",
    "extraFields": ["description"]
  },
  "dataSourceBaseUrl": "http://127.0.0.1:3000"
}
```

The remote E2E must verify:

1. The initial request uses `page=1&limit=2`, displays the first two projects and their descriptions, and reports `2 of 5` options loaded.
2. Pressing `n` requests `page=2&limit=2`, appends the next two projects without duplicates, and preserves the known total.
3. Pressing `s`, entering `报表`, and submitting the search resets pagination to page 1 and returns only the matching project tree.
4. Tree children render beneath their parent; selecting `数据报表` returns `project-2-report`.
5. The final result card uses the human-readable label, the tool result uses the canonical ID, and Pi continues without exiting.

## Release gate

Before publishing:

```sh
npm run typecheck
npm test
```

For an npm release, rerun the relevant real Pi scenario with `PI_ACCEPTANCE_PACKAGE_SOURCE` set to the exact package version. A release is not verified merely because the model generated valid JSON; the installed artifact must render, accept input, submit the expected result, continue the Agent, and exit cleanly.
