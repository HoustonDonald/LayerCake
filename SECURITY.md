# Security policy

LayerCake reads and edits Claude Code configuration, which can hold commands Claude Code runs and
files that hold sign-in tokens, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report it privately, not in a public issue: on this repository's **Security** tab, choose
**Report a vulnerability**. Include what you did, what happened, and the LayerCake version (the
release name, or the commit if you run from source).

LayerCake is maintained by one person, so replies come as soon as possible rather than to a set
time. Once a fix is released, the report can be published with credit to you, if you want it.

## What counts

LayerCake's design rests on a few promises, described in
[Network posture](docs/reference.md#network-posture) and
[Write posture](docs/reference.md#write-posture). Anything that breaks one is in scope, for example:

- a web page, or anything other than LayerCake's own window, reading or changing your files through it;
- a credential file (`.credentials.json`, `credentials.json`, `.env`, `.env.local`) being opened or
  shown;
- a configuration file being replaced or removed without a snapshot first;
- LayerCake making a network request, or spending Claude usage without being asked.

Out of scope: a program already running as you, which can change these files without LayerCake.

## Supported versions

Only the latest release is supported.
