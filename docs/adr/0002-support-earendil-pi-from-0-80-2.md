# Support @earendil-works/pi-coding-agent 0.82

Historical decision: superseded for the current support range by the Pi 1.4.0 dependency upgrade (Issue #43). See package.json and README.md.

This decision supersedes the earlier 0.80 line. The extension supports `@earendil-works/pi-coding-agent@^0.82.1`, meaning versions from 0.82.1 up to but not including 0.83.0. Development, typechecking, and real PTY acceptance use exact 0.82.1 so the public `prepareArguments`, sequential execution, session journal, model registry, and isolated `createAgentSession` boundaries are verified against the same runtime as Dano.
