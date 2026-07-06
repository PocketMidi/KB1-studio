# KB1 Studio GitHub Setup

Use this guide for the active Studio repo only.

## Repository

- Repo: `https://github.com/PocketMidi/KB1-studio`
- Production URL: `https://pocketmidi.github.io/KB1-studio/`
- Pages settings: `https://github.com/PocketMidi/KB1-studio/settings/pages`
- Actions: `https://github.com/PocketMidi/KB1-studio/actions`

## First-Time Setup

```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio
git init
git add .
git commit -m "Initial commit - KB1 Studio"
git remote add origin https://github.com/PocketMidi/KB1-studio.git
git branch -M main
git push -u origin main
```

## GitHub Pages

1. Open repo settings and go to Pages.
2. Set source to GitHub Actions.
3. Ensure `vite.config.ts` uses `base: '/kb1-studio/'`.
4. Push to `main` and confirm deploy workflow succeeds.

## Verify

1. Open `https://pocketmidi.github.io/KB1-studio/`.
2. Confirm both Instrument Builder and Flash tabs load.
3. Confirm firmware list loads from `public/firmware/releases.json`.

## Migration Note

`KB1-flash` is now deprecated and redirect-only. Do not publish new firmware UX changes there.
