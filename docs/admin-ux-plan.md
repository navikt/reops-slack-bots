# Admin UX checkpoint

## Scope

- Aksel DataGrid (installed package exposes it through `@navikt/ds-react/PREVIEW`).
  Official MCP docs confirm `detailsPanel.getContent` adds the left-side expand
  control; use sorting, filtering, stable IDs, readable empty/loading states.
- Main diagnostics rows show thread preview/link, age, channel name, human
  assignee/actor, manual action and cooldown. Raw IDs and ISO timestamps live in
  expandable details with CopyButton controls.
- Never pretend stored manual actions are live Slack status. Check actual thread
  status on demand, with a checked-at time and explicit unavailable state.
- Admin unsuppress/reassign/release uses the existing shared reminder manager,
  authenticated as the caller. Protect stale edits and assignment roster limits.
- One debounced, abortable picker searches people and groups per audience list.
  Group options say “group”; selecting adds immediately. Show groups first;
  render Individuals only when someone is configured.
- Updated layout: one aligned DataGrid per audience with groups first; Type is
  shown only when individuals exist. Add/search stays below the grid. Removal
  buttons show a leading trash icon and the word Remove.
- Diagnostics moved to `/admin/diagnostics`, not nested inside expansion cards.
  Search/filter bottoms align; actions use a sticky far-right Actions menu.
  A content column grows through public controlled-width props to absorb spare
  width instead of leaving a visible trailing filler cell. No Aksel CSS overrides.
- Contextual warnings/errors use documented LocalAlert composition, including
  the unrestricted-bootstrap-admin warning. English Provider surrounds client UI.
- Preserve all existing settings, bot switch, test controls, bootstrap warnings,
  membership expansion and removals. No dependency upgrade or DB migration needed.

## Verification

- Backend identity/source/status fallbacks and mutation validation tests.
- Reminder unsuppression and stale-edit tests.
- Type-check, full tests, production build from scratchpad.
- Browser visual/keyboard/accessibility check with mocked APIs (no real Slack
  messages or production data changes).
- Browser checks passed with mocked data: mixed people/group search, autosave
  focus, remove labels, conditional Type column, unsuppress/reassign requests,
  aligned names/filter inputs, real narrow-screen horizontal scrolling, sticky
  actions, and spare-width right alignment. Axe found no WCAG A/AA violations
  on settings or populated diagnostics.
- Captured and inspected the user's actual localhost:9092 settings/diagnostics
  before and after alignment changes, without issuing mutation requests. Actual
  diagnostics were empty, so populated interactions were tested with mocks.
- Final verification: type-check, production build and 65 unit tests pass; the
  opt-in Postgres suite was skipped without its dedicated test URL. Its concrete
  unsuppress coverage was extended but not rerun against Postgres in this pass.
- Production-build HTTP smoke checks confirm unauthenticated admin/diagnostics
  warnings render and thread-action requests receive 401 Problem Details.
- Playwright also verified keyboard menu focus restoration, zero axe WCAG A/AA
  violations, spare-width alignment at both normal and 2400px viewports, and
  pinned actions during actual horizontal scrolling at 390px. Temporary test
  servers were stopped; the user's 9092 server was left running. No mutation
  requests were issued to the user's local app.
