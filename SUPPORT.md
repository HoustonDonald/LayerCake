# Support

LayerCake is free, and maintained by one person in their spare time. Support is best effort: every
issue is read, but there are no set response times.

## Getting help

- **A bug:** open an issue with the **Bug report** form. It asks for what you did, what happened,
  and three versions: LayerCake (on `LayerCake.exe`: Properties, **Details** tab, Product version;
  or the commit, if you run from source), Windows (run `winver`) and Claude Code
  (`claude --version`).
- **An idea or a question:** open a plain issue. Ideas are welcome, but may be declined to keep
  LayerCake small.
- **A security problem:** never in a public issue. See [SECURITY.md](SECURITY.md).

Check [If something goes wrong](README.md#if-something-goes-wrong) and the
[reference](docs/reference.md) first; the reference states every known limit.

## What is supported

- The latest release. A bug in an older one is fixed in the next release, not in the old one.
- Windows 11. Windows 10 should work but is not tested, and other systems are not supported.
- A current Claude Code. LayerCake reads Claude Code's own files, and some of their formats are
  internal to Claude Code and change without notice, so a new Claude Code release can break part of
  LayerCake until it catches up. Bugs on these setups come first.

## Contributing

Pull requests are welcome, with one step first: **open an issue describing the change, and agree
it there before writing code.** That saves you writing something that would be declined, for
instance because it adds a dependency, reaches the network, or widens what LayerCake can write.

Before you send the pull request, run `npm run smoke` and say what you checked by hand in the
browser or the exe; [CLAUDE.md](CLAUDE.md) explains why that matters here. Contributions are
accepted under the [MIT License](LICENSE).
