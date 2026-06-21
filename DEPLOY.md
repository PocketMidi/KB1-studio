# 🚀 Quick Start - Deploy KB1 Flash Tool to GitHub

**Complete beginner-friendly guide!**

---

## ⚡ Super Quick Method (Automated Script)

Just run this in your terminal (in VS Code):

```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-flash
./setup-github.sh
```

The script will guide you through everything! 

**Before running the script:**
1. Make sure the repo exists: https://github.com/PocketMidi/KB1-flash
2. If not, go to https://github.com/organizations/PocketMidi/repositories/new
3. Name: `KB1-flash`
4. Make it **Public**
5. **Don't** check any boxes (README, .gitignore, license)
6. Click "Create repository"

Then run the script and it will push to your PocketMidi repo!

---

## 📝 Manual Method (If you prefer step-by-step)

### Step 1: Create GitHub Repository

1. Open https://github.com/new
2. Fill in:
   - Repository name: **KB1-flash**
   - Description: **KB1 Desktop Firmware Flash Tool**
   - Visibility: **Public**
   - **DO NOT** check: Add README, .gitignore, or license
3. Click **"Create repository"**

### Step 2: Open Terminal in VS Code

1. In VS Code, click **Terminal** → **New Terminal**
2. Run:
   ```bash
   cd kb1-flash
   ```

### Step 3: Initialize Git

```bash
git init
git add .
git commit -m "Initial commit - KB1 Flash Tool v1.0.0"
```

### Step 4: Connect to GitHub

For the PocketMidi organization:

```bash
git remote add origin https://github.com/PocketMidi/KB1-flash.git
git branch -M main
git push -u origin main
```

### Step 5: Enable GitHub Pages

1. Go to your repo: `https://github.com/PocketMidi/KB1-flash`
2. Click **Settings** tab (top menu)
3. Click **Pages** in left sidebar
4. Under "Build and deployment":
   - Source: Select **GitHub Actions**
5. No need to click Save (it auto-saves)

### Step 6: Wait for Deployment

1. Go to **Actions** tab in your repo
2. You'll see "Deploy to GitHub Pages" running
3. Wait ~1-2 minutes for it to complete
4. Green checkmark = success!

### Step 7: Visit Your Site!

Your site will be live at:
```
https://PocketMidi.github.io/KB1-flash/
```

---

## 🎯 Making Updates Later

Whenever you change the code:

```bash
git add .
git commit -m "Description of what you changed"
git push
```

GitHub will automatically rebuild and redeploy!

---

## ✅ Verification Checklist

- [ ] Repository created on GitHub (https://github.com/PocketMidi/KB1-flash)
- [ ] Code pushed successfully
- [ ] GitHub Pages enabled (Settings → Pages → GitHub Actions)
- [ ] Workflow completed (Actions tab shows green checkmark)
- [ ] Site loads at `https://PocketMidi.github.io/KB1-flash/`
- [ ] Can see the Flash Firmware interface
- [ ] Serial Monitor tab works

---

## ❓ Need Help?

**If push fails:**
```bash
# Check your current remote URL
git remote -v

# Should show: https://github.com/PocketMidi/KB1-flash.git
# If different, fix it:
git remote set-url origin https://github.com/PocketMidi/KB1-flash.git
git push -u origin main
```

**If deployment fails:**
- Check Actions tab for error messages
- Make sure GitHub Pages is set to "GitHub Actions" mode
- Try pushing again: `git push`

**If site shows 404:**
- Wait a few minutes (first deploy can take up to 10 minutes)
- Clear browser cache
- Check Actions tab shows green checkmark

---

## 📚 More Details

See **GITHUB_SETUP.md** for advanced configuration (custom domains, troubleshooting, etc.)

---

**Ready to go? Run the script or follow manual steps above!** 🎉
