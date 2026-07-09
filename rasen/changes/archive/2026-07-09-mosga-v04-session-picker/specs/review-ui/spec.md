# review-ui Delta

## MODIFIED Requirements

### Requirement: Whitelist project and session picker

The `@mosga/ui` package SHALL provide a React 18 + Vite + Tailwind interface whose entry flow is a tree-navigation picker: a left source→project tree and a right session card grid (per the `ui-session-queue` capability). The project tree SHALL default to `recommended` (public-git-remote) projects, with an explicit "show all projects" control to reveal the rest, surfacing the design doc's whitelist defense to the user.

#### Scenario: Recommended projects shown by default

- **WHEN** the picker loads a source's projects into the tree
- **THEN** only `recommended` projects are shown until the user opts into showing all

#### Scenario: Selecting a session starts a review

- **WHEN** the user selects one or more session cards and confirms the start-review action
- **THEN** the UI creates a review per selected session via the daemon and transitions to the journey once the scans return
