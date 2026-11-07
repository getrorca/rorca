# Rorca Pi Extension — Package Metadata Draft

> Status: **Internal draft only**
>
> This file is a publication-prep reference for turning the current in-repo extension package into a more public-package-shaped artifact later.
>
> It does **not** mean the package should be published now.

---

## 1. Current package state

Current package file:
- `packages/rorca-pi-extension/package.json`

Current notable fields:
- `name: "@rorca/pi-extension"`
- `version: "0.1.0"`
- `private: true`
- `type: "module"`
- `license: "Apache-2.0"`
- `peerDependencies: { "@mariozechner/pi-coding-agent": "*" }`
- `pi.extensions: ["./extensions"]`

This is appropriate for in-repo use, but not yet ideal for public distribution.

---

## 2. Recommended future public-facing metadata

Below is a suggested future shape for `package.json` once/if you choose to publish.

## Suggested metadata values

### name
`@rorca/pi-extension`

Good as-is unless you want a flatter public package name.

### version
`0.1.0`

Good for the first publishable release draft.

### description
Recommended:

```json
"description": "Pi-native extension for Rorca: forge specs, trigger Pi-backed runs, watch progress live, and bridge Rorca MCP tools into Pi."
```

Alternate shorter version:

```json
"description": "Operate Rorca directly from inside Pi."
```

### keywords
Recommended:

```json
"keywords": [
  "pi-package",
  "pi-extension",
  "rorca",
  "orchestration",
  "spec-generation",
  "mcp",
  "developer-tools",
  "ai-workflow",
  "slash-commands",
  "run-monitoring"
]
```

### homepage
Placeholder recommendation:

```json
"homepage": "https://<your-domain>/pi-extension"
```

If docs live in the main repo instead:

```json
"homepage": "https://github.com/<org>/<repo>/tree/main/packages/rorca-pi-extension"
```

### repository
Recommended shape:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/<org>/<repo>.git",
  "directory": "packages/rorca-pi-extension"
}
```

### bugs
Recommended shape:

```json
"bugs": {
  "url": "https://github.com/<org>/<repo>/issues"
}
```

### author
Recommended placeholder:

```json
"author": "Rorca"
```

or:

```json
"author": "Rorca Team"
```

### license
Keep aligned with your actual legal intent.

Current:

```json
"license": "Apache-2.0"
```

If that remains the intended public license posture, keep it.

### private
Only change when you truly want to publish:

```json
"private": false
```

Do **not** change this until publication is intentional.

---

## 3. Recommended additional package.json fields

### files
Strongly recommended for cleaner package output:

```json
"files": [
  "extensions",
  "README.md",
  "CHANGELOG.md",
  "LICENSE"
]
```

If you also want to ship maintainer-oriented docs, you could include:

```json
"files": [
  "extensions",
  "README.md",
  "CHANGELOG.md",
  "PUBLISHING.md"
]
```

But for a public package, `PUBLISHING.md` is often not necessary in the final published tarball.

### engines
Recommended if you want to communicate minimum Node expectations:

```json
"engines": {
  "node": ">=20"
}
```

### peerDependencies
Current peer dependency is intentionally broad:

```json
"peerDependencies": {
  "@mariozechner/pi-coding-agent": "*"
}
```

For a more stable public posture, consider pinning a reasonable range once compatibility is clearer.

Example:

```json
"peerDependencies": {
  "@mariozechner/pi-coding-agent": ">=0.67.0"
}
```

Only do this if you are confident about tested compatibility.

### publishConfig
Optional, if publishing to npm-like infrastructure:

```json
"publishConfig": {
  "access": "public"
}
```

Use only if actually publishing publicly.

---

## 4. Suggested future package.json draft

This is a draft example only.

```json
{
  "name": "@rorca/pi-extension",
  "version": "0.1.0",
  "description": "Pi-native extension for Rorca: forge specs, trigger Pi-backed runs, watch progress live, and bridge Rorca MCP tools into Pi.",
  "private": false,
  "type": "module",
  "license": "Apache-2.0",
  "author": "Rorca",
  "homepage": "https://github.com/<org>/<repo>/tree/main/packages/rorca-pi-extension",
  "repository": {
    "type": "git",
    "url": "https://github.com/<org>/<repo>.git",
    "directory": "packages/rorca-pi-extension"
  },
  "bugs": {
    "url": "https://github.com/<org>/<repo>/issues"
  },
  "keywords": [
    "pi-package",
    "pi-extension",
    "rorca",
    "orchestration",
    "spec-generation",
    "mcp",
    "developer-tools",
    "ai-workflow",
    "slash-commands",
    "run-monitoring"
  ],
  "engines": {
    "node": ">=20"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.67.0"
  },
  "files": [
    "extensions",
    "README.md",
    "CHANGELOG.md"
  ],
  "pi": {
    "extensions": [
      "./extensions"
    ]
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

---

## 5. README and package alignment checklist

Before changing `package.json`, make sure the package docs match:

- `README.md` command list is current
- install command is correct
- requirements are clear
- MCP token behavior is documented
- environment variable names are documented
- model selection behavior is documented
- troubleshooting section reflects reality

If the package description says “bridge MCP tools,” the README should explain:
- MCP is optional
- slash commands are REST-first
- the bridge depends on backend MCP health

---

## 6. Compatibility statement draft

If publishing later, include a compatibility note in the README or release notes.

Suggested draft wording:

> Compatibility targets:
> - Pi: tested with modern Pi versions supporting extensions and HTTP MCP bridging
> - Rorca backend: tested against the backend version that exposes Pi trigger controls and HTTP MCP initialize/tools/list/tools/call support

If you want stronger precision later, replace this with exact version ranges.

---

## 7. Packaging validation checklist

Before any publish-like action:

```bash
cd packages/rorca-pi-extension
npm pack --dry-run
```

Check that the tarball would contain only what you want.

Also run:

```bash
npm run test:pi-extension
npm run typecheck
npm run build
cd backend && npx tsc --noEmit
```

And perform a live smoke test:

```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts -p "/rorca-help"
```

---

## 8. Suggested release gates before flipping `private: false`

Do not make the package public until you can answer “yes” to all of these:

- Is the command surface stable enough?
- Is the backend compatibility story clear?
- Are the docs good enough for first-time users?
- Do we know how support/issues will be handled?
- Is the license/public posture intentional?
- Are screenshots/positioning ready enough that public users will understand what this is?

---

## 9. Recommended minimal publicization path

If you later want to publish gradually, a low-risk order would be:

1. keep package private
2. finish docs and screenshots
3. lock down package metadata draft
4. validate a clean install story on a fresh machine/session
5. decide support URLs and compatibility statement
6. remove `private: true`
7. publish intentionally

---

## 10. Final reminder

This file is meant to help future-you move quickly when publication becomes real.

It is deliberately detailed so you do not have to re-decide basic metadata, positioning, and validation shape later.
