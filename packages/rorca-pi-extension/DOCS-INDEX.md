# Rorca Pi Extension — Documentation Index

This file is the navigation hub for the Rorca Pi Extension documentation set.

Use it when you want to quickly understand:
- which doc to read first
- which doc is user-facing vs maintainer-facing
- which docs are internal pre-publication drafts
- where to go for screenshots, store copy, package metadata, or launch materials

---

## Quick start

If you only need one document, start here based on your role:

### I want to **use** the extension
Read:
- `packages/rorca-pi-extension/README.md`

### I want **bounded persistent autonomy**
Read:
- `packages/rorca-pi-extension/README.md` — Hermes persistent autonomy precursor
- `packages/rorca-pi-extension/skills/hermes-autonomous-supervisor/SKILL.md` — exact operating and safety contract

### I want to **maintain** or eventually **publish** the extension
Read:
- `packages/rorca-pi-extension/PUBLISHING.md`
- `packages/rorca-pi-extension/PACKAGE-METADATA-DRAFT.md`

### I want **store-style copy** or public-facing positioning
Read:
- `packages/rorca-pi-extension/STORE-LISTING.md`
- `packages/rorca-pi-extension/STORE-SUBMISSION-DRAFT.md`

### I want **launch / announcement** copy
Read:
- `packages/rorca-pi-extension/ANNOUNCEMENT.md`

### I want to plan **screenshots / visuals**
Read:
- `packages/rorca-pi-extension/SCREENSHOT-CAPTURE-CHECKLIST.md`
- `packages/rorca-pi-extension/SCREENSHOT-AND-MARKETING-ASSETS.md`

### I want release notes / change history
Read:
- `packages/rorca-pi-extension/CHANGELOG.md`

---

## Full document map

## 1. Core user documentation

### `README.md`
**Audience:** users, operators, developers using the extension day to day

**Purpose:**
The main usage guide for the extension.

**Covers:**
- what the extension is
- how it fits with Rorca, Pi, and MCP
- install steps
- environment variables
- session behavior
- persistent Hermes supervisor lifecycle, completion, fencing, and takeover
- full slash-command reference
- example workflows
- troubleshooting
- package layout

**Read this when:**
- you want to install it
- you want to use it
- you want to understand what commands exist

---

## 2. Maintainer / publication documentation

### `PUBLISHING.md`
**Audience:** maintainers, release owners, future publishers

**Purpose:**
High-level guidance for what needs to be true before the extension is made public.

**Covers:**
- readiness expectations
- release posture
- compatibility expectations
- support considerations
- public positioning
- validation checklist

**Read this when:**
- you’re thinking about publishing
- you want to define support expectations
- you want to understand what “public-ready” means operationally

### `PACKAGE-METADATA-DRAFT.md`
**Audience:** maintainers preparing package metadata

**Purpose:**
A detailed future-facing draft for `package.json` and publication-oriented package metadata.

**Covers:**
- recommended description
- keywords
- homepage/repository/bugs placeholders
- `files` guidance
- `engines` guidance
- peer dependency considerations
- a full example future `package.json`
- validation and release gates

**Read this when:**
- you want to make the package look publication-shaped
- you are preparing to remove `private: true`
- you want a future metadata template

---

## 3. Release documentation

### `CHANGELOG.md`
**Audience:** users, maintainers, release readers

**Purpose:**
Tracks notable changes by release.

**Covers:**
- release highlights
- added features
- changed behavior
- fixes
- validation summary
- known limitations
- upgrade notes

**Read this when:**
- you want to know what shipped
- you want to summarize a release
- you want to compare release behavior over time

---

## 4. Store / listing drafts

### `STORE-LISTING.md`
**Audience:** product/marketing/doc writers

**Purpose:**
A polished, customer-facing draft for what a public extension listing could say.

**Covers:**
- title/tagline
- short and long product framing
- key benefits
- command overview
- examples
- requirements
- FAQ
- install CTA

**Read this when:**
- you want public-facing copy fast
- you want something store-page shaped
- you want to explain the extension to a broad audience

### `STORE-SUBMISSION-DRAFT.md`
**Audience:** maintainers and product writers preparing for a future listing

**Purpose:**
A more structured pre-submission pack for eventual store publication.

**Covers:**
- listing identity
- short/medium/long descriptions
- categories and keywords
- target audience
- value propositions
- support placeholders
- submission warnings and checks

**Read this when:**
- you are moving from “interesting draft” to “submission prep”
- you want all listing metadata in one place

**Important:**
This is still an internal prep doc, not a declaration that the extension is being submitted now.

---

## 5. Launch / announcement drafts

### `ANNOUNCEMENT.md`
**Audience:** launch writers, docs writers, community comms

**Purpose:**
Provides both short and long launch-style copy.

**Covers:**
- short launch post
- fuller announcement / landing-page style narrative
- positioning
- what the extension is and isn’t
- install + get-started framing

**Read this when:**
- you want announcement copy
- you want a landing-page narrative
- you need polished launch wording quickly

---

## 6. Screenshots / marketing asset planning

### `SCREENSHOT-CAPTURE-CHECKLIST.md`
**Audience:** whoever will capture final visuals later

**Purpose:**
A practical execution checklist for collecting clean screenshots.

**Covers:**
- screenshot order
- exact commands to run
- what each screenshot should show
- what to hide/avoid
- privacy cleanup
- terminal sizing/style
- alt text drafts
- post-capture polish steps

**Read this when:**
- you are actually preparing screenshot assets
- you want a repeatable capture flow
- you want screenshots that feel clean and trustworthy

### `SCREENSHOT-AND-MARKETING-ASSETS.md`
**Audience:** product/marketing/doc writers

**Purpose:**
The more strategic asset-planning companion to the capture checklist.

**Covers:**
- screenshot strategy
- titles and captions
- visual sequencing
- hero/subhero options
- feature grid copy
- social snippets
- FAQ blocks

**Read this when:**
- you want to shape the story the visuals tell
- you want screenshot captions and surrounding marketing copy

---

## Suggested reading paths

## Path A — I just want to use the extension
1. `README.md`
2. optionally `CHANGELOG.md`

## Path B — I want to explain the extension internally
1. `README.md`
2. `ANNOUNCEMENT.md`
3. `STORE-LISTING.md`

## Path C — I want to prepare it for eventual public release
1. `PUBLISHING.md`
2. `PACKAGE-METADATA-DRAFT.md`
3. `STORE-SUBMISSION-DRAFT.md`
4. `CHANGELOG.md`

## Path D — I want to prepare visuals and launch assets
1. `SCREENSHOT-CAPTURE-CHECKLIST.md`
2. `SCREENSHOT-AND-MARKETING-ASSETS.md`
3. `ANNOUNCEMENT.md`
4. `STORE-LISTING.md`

---

## Recommended publication-prep order

When/if you decide to move toward real publication later, a sensible order is:

1. validate product/runtime behavior
2. keep `README.md` current
3. finalize release notes in `CHANGELOG.md`
4. finalize package metadata from `PACKAGE-METADATA-DRAFT.md`
5. capture screenshots using `SCREENSHOT-CAPTURE-CHECKLIST.md`
6. refine public copy from `STORE-LISTING.md` and `ANNOUNCEMENT.md`
7. use `STORE-SUBMISSION-DRAFT.md` to fill any real listing form
8. only then consider changing package publication settings

---

## Important note

Several of these files are intentionally **drafts for future publication**.

That means:
- they are written to a high standard
- they are useful now
- but they should not be mistaken for an immediate commitment to publish the extension

The extension can remain private and in-repo while still benefiting from publication-quality documentation.

---

## Final summary

If you remember nothing else:
- **Use** `README.md`
- **Maintain** with `PUBLISHING.md`
- **Prepare package metadata** with `PACKAGE-METADATA-DRAFT.md`
- **Plan store copy** with `STORE-SUBMISSION-DRAFT.md`
- **Capture visuals** with `SCREENSHOT-CAPTURE-CHECKLIST.md`
- **Launch messaging** lives in `ANNOUNCEMENT.md`
