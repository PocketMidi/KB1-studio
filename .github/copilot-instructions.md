# KB1 Studio Development Guidelines

## Skills (load before working on relevant areas)

<skills>
<skill>
<name>kb1-studio-core</name>
<description>Complete architecture reference for KB1 Studio: project structure, tech stack (Vite+TS, vanilla JS), all global state variables, ImportedFile interface, slot duration lock/unlock system, normalization, project file format (.kb1i), session persistence (IDB), toolbar HTML/CSS structure, zoom systems (piano roll + waveform), About modals, sidebar patterns, PTI export facts, and common implementation patterns. Use for any feature work, bug fixing, or new functionality.</description>
<file>/Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio/.github/skills/kb1-studio-core/SKILL.md</file>
</skill>
<skill>
<name>kb1-studio-pti-export</name>
<description>PTI file format details, slice encoding, audio rendering, and the @polyend/tracker-lib blob-interception workaround. Use when modifying export logic.</description>
<file>/Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio/.github/skills/kb1-studio-pti-export/SKILL.md</file>
</skill>
<skill>
<name>kb1-studio-libraries</name>
<description>Details on @polyend/tracker-lib and other dependencies. Use when updating or debugging library integration.</description>
<file>/Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio/.github/skills/kb1-studio-libraries/SKILL.md</file>
</skill>
</skills>

## Critical Rules

- **Type-check after every edit**: `node_modules/typescript/bin/tsc --noEmit`
- **Never use Vue/React** — this is vanilla TS/JS only
- **CSS variables for all colors** — no hardcoded hex in components
- **Sentence case** for all toolbar labels (no `text-transform: uppercase`)
- **No emojis** in UI — use Unicode symbols or inline SVG
- **Persist everything** the user can set — check the "common patterns" section of kb1-studio-core skill before adding new state
- **Both zoom windows** use identical wheel behavior: plain = zoom (centered on cursor), Shift = pan

## Dev Server

```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio
npm run dev   # → http://localhost:5174/KB1-flash/
```
