# Jarvis Deck

Webinar slides as one self-contained file: `index.html`. Published to GitHub Pages by
`.github/workflows/deck.yml` on every change under `deck/`.

Not part of the product: excluded from ESLint (`eslint.config.js`), Prettier (`.prettierignore`),
typecheck and tests. Edit the HTML directly, or re-export it from the Claude artifact and overwrite
`index.html`.
