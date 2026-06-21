# KB1 Flash Tool - GitHub Setup & Deployment Guide

## Step 1: Create GitHub Repository

### Option A: Via GitHub Website (Easiest)

1. **Go to GitHub:** https://github.com/organizations/PocketMidi/repositories/new
2. **Fill in details:**
   - Repository name: `KB1-flash`
   - Description: `KB1 Desktop Firmware Flash Tool - USB updater with NVS preservation`
   - Visibility: **Public** (so GitHub Pages works free)
   - **DO NOT** initialize with README, .gitignore, or license (we already have these)
3. **Click "Create repository"**

### Option B: Via GitHub CLI (if you have `gh` installed)

```bash
gh repo create PocketMidi/KB1-flash --public --description "KB1 Desktop Firmware Flash Tool"
```

---

## Step 2: Initialize Git Locally

Open terminal in VS Code and run these commands:

```bash
# Navigate to kb1-flash folder
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-flash

# Initialize git repository
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit - KB1 Flash Tool v1.0.0"
```

---

## Step 3: Connect to GitHub & Push

After creating the repo on GitHub, you'll see instructions. Use these:

```bash
# Add GitHub as remote
git remote add origin https://github.com/PocketMidi/KB1-flash.git

# Push to GitHub
git branch -M main
git push -u origin main
```

---

## Step 4: Configure GitHub Pages Deployment

We'll use GitHub Actions to automatically build and deploy when you push changes.

### Create GitHub Actions Workflow

Create this file: `.github/workflows/deploy.yml`

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        
      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: '24'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build
        run: npm run build
        
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v4
        with:
          path: ./dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
```

**To create this file:**

```bash
# Still in kb1-flash folder
mkdir -p .github/workflows
# Then create the file using VS Code or command below
```

---

## Step 5: Enable GitHub Pages in Repository Settings

1. Go to your repo on GitHub: `https://github.com/PocketMidi/KB1-flash`
2. Click **Settings** tab
3. Click **Pages** in left sidebar
4. Under "Source":
   - Select: **GitHub Actions**
5. Click **Save**

---

## Step 6: Update Vite Config for GitHub Pages

We need to tell Vite the base URL for GitHub Pages.

Edit `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/KB1-flash/', // Add this line - must match repo name
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5174,
    open: true,
  },
});
```

---

## Step 7: Push Changes & Deploy

```bash
# Add the new workflow file
git add .github/workflows/deploy.yml

# Add updated vite.config.ts
git add vite.config.ts

# Commit
git commit -m "Add GitHub Pages deployment workflow"

# Push
git push
```

**GitHub Actions will automatically:**
1. Build your project
2. Deploy to GitHub Pages
3. Your site will be live at: `https://PocketMidi.github.io/KB1-flash/`

---

## Step 8: Verify Deployment

1. Go to your repo: `https://github.com/PocketMidi/KB1-flash`
2. Click **Actions** tab
3. Watch the deployment workflow run (takes ~1-2 minutes)
4. When complete, visit: `https://PocketMidi.github.io/KB1-flash/`

---

## Custom Domain (Optional)

If you want `kb1-flash.pocketmidi.com` instead:

### A. Add CNAME file

Create `public/CNAME` file:
```
kb1-flash.pocketmidi.com
```

### B. Configure DNS

Add DNS record at your domain provider:
```
Type: CNAME
Name: kb1-flash
Value: pocket-midi.github.io
```

### C. Update vite.config.ts

```typescript
base: '/', // Change back to root since custom domain
```

### D. Enable in GitHub Settings

1. Repo Settings → Pages
2. Custom domain: `kb1-flash.pocketmidi.com`
3. Check "Enforce HTTPS"

---

## Troubleshooting

### Build fails on GitHub Actions
- Check the Actions tab for error logs
- Make sure `package.json` has all dependencies
- Verify `npm run build` works locally

### Site shows 404
- Wait a few minutes after deployment
- Check GitHub Pages is enabled in Settings
- Verify workflow completed successfully
- Clear browser cache

### Site loads but blank page
- Check browser console for errors
- Verify `base` in vite.config.ts matches repo name
- Check if paths to assets are correct

### Web Serial API not working
- GitHub Pages uses HTTPS ✓ (required)
- Make sure using Chrome/Edge/Opera
- Mobile browsers won't work

---

## Future Updates

Whenever you make changes:

```bash
git add .
git commit -m "Description of changes"
git push
```

GitHub Actions will automatically rebuild and redeploy!

---

## Quick Reference

**Local dev:** `npm run dev` → http://localhost:5174  
**Production URL:** https://PocketMidi.github.io/KB1-flash/  
**Custom domain:** https://kb1-flash.pocketmidi.com (if configured)  

**Repo URL:** https://github.com/PocketMidi/KB1-flash  
**Settings:** https://github.com/PocketMidi/KB1-flash/settings/pages  
**Actions:** https://github.com/PocketMidi/KB1-flash/actions
