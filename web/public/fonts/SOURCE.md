# Fonts

Self-hosted so the app makes no third-party requests. Both fonts are licensed under the SIL Open Font
License 1.1 (`OFL-Inter.txt`, `OFL-JetBrainsMono.txt`).

| Files                                                                      | Source                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `inter-{latin,latin-ext,cyrillic,cyrillic-ext}-wght-normal.woff2`          | npm `@fontsource-variable/inter@5.3.0`, `files/`          |
| `jetbrains-mono-{latin,latin-ext,cyrillic,cyrillic-ext}-wght-normal.woff2` | npm `@fontsource-variable/jetbrains-mono@5.3.0`, `files/` |

The packages are only the source of the files; they are not dependencies of `@jarvis/web`. The
`@font-face` rules live in `web/src/styles/fonts.css` (copied from the packages' `wght.css`, paths
rewritten to `/fonts/`).
