## ADDED Requirements

### Requirement: Daemon CLI supports a no-open start for the shell

The daemon CLI SHALL support starting the daemon WITHOUT launching the OS browser (a `--no-open` flag on `mosga ui`), so the desktop shell can spawn the daemon and load the UI in its own webview instead of opening a browser tab. The default `mosga ui` behavior (open the browser) SHALL be unchanged, and the daemon SHALL remain bound to loopback only in both modes.

#### Scenario: No-open start does not open a browser

- **WHEN** the daemon is started with the no-open flag
- **THEN** it binds loopback and serves as usual but does not launch the OS browser

#### Scenario: Default start still opens the browser

- **WHEN** `mosga ui` is run without the no-open flag
- **THEN** it starts the daemon and opens the browser at `/ui` as before
