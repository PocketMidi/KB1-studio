# KB1 Studio Deployment

KB1 Studio is the active desktop web app for KB1 firmware tools and instrument building.

## Quick Deploy

```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio
npm install
npm run build
```

Deploy the generated `dist/` folder to your static host (GitHub Pages, Netlify, Cloudflare Pages, etc.).

## GitHub Pages

1. Push this repo to `https://github.com/PocketMidi/KB1-studio`.
2. In GitHub repo settings, enable Pages with source set to GitHub Actions.
3. Confirm `vite.config.ts` base path is `/kb1-studio/`.
4. Run the deployment workflow and verify site availability at `https://pocketmidi.github.io/KB1-studio/`.

## Verification Checklist

- [ ] Build succeeds locally (`npm run build`)
- [ ] GitHub Actions deploy passes
- [ ] Main app loads at `/kb1-studio/`
- [ ] Flash tab loads firmware list from `public/firmware/releases.json`
- [ ] Serial monitor opens and receives output

## Migration Note

The legacy `KB1-flash` app has been retired. Its GitHub Pages site now redirects to KB1 Studio.
