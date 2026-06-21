#!/bin/bash
# KB1 Flash Tool - GitHub Repository Setup Script
# Repository: https://github.com/PocketMidi/KB1-flash

REPO_URL="https://github.com/PocketMidi/KB1-flash.git"
GITHUB_USER="PocketMidi"

echo "🚀 KB1 Flash Tool - GitHub Setup"
echo "================================"
echo "Repository: $REPO_URL"
echo ""

# Check if git is initialized
if [ ! -d .git ]; then
    echo "📝 Step 1: Initializing Git repository..."
    git init
    echo "✅ Git initialized"
    echo ""
else
    echo "✅ Git already initialized"
    echo ""
fi

# Check if files are committed
if [ -z "$(git log 2>/dev/null)" ]; then
    echo "📝 Step 2: Creating initial commit..."
    git add .
    git commit -m "Initial commit - KB1 Flash Tool v1.0.0"
    echo "✅ Initial commit created"
    echo ""
else
    echo "✅ Repository already has commits"
    
    # Check if there are uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        echo "⚠️  You have uncommitted changes"
        read -p "Commit changes now? (y/n): " COMMIT_NOW
        if [ "$COMMIT_NOW" = "y" ]; then
            git add .
            read -p "Commit message (or press Enter for 'Update KB1 Flash Tool'): " COMMIT_MSG
            COMMIT_MSG=${COMMIT_MSG:-"Update KB1 Flash Tool"}
            git commit -m "$COMMIT_MSG"
            echo "✅ Changes committed"
        fi
    fi
    echo ""
fi

# Ask for confirmation before pushing
echo "📝 Step 3: Connect to GitHub"
echo ""
echo "Make sure you've created the repository on GitHub:"
echo "   👉 https://github.com/PocketMidi/KB1-flash"
echo ""
echo "If not created yet:"
echo "   1. Go to: https://github.com/new"
echo "   2. Name: KB1-flash"
echo "   3. Owner: PocketMidi"
echo "   4. Visibility: Public"
echo "   5. DO NOT initialize with README/license"
echo "   6. Click 'Create repository'"
echo ""
read -p "Repository created on GitHub? Press Enter to continue..."
echo ""

echo "📝 Step 4: Adding remote and pushing to GitHub..."
echo ""

# Check if remote already exists
if git remote | grep -q "origin"; then
    CURRENT_URL=$(git remote get-url origin)
    if [ "$CURRENT_URL" != "$REPO_URL" ]; then
        echo "⚠️  Remote 'origin' exists with different URL: $CURRENT_URL"
        echo "   Updating to: $REPO_URL"
        git remote set-url origin "$REPO_URL"
    else
        echo "✅ Remote 'origin' already set correctly"
    fi
else
    echo "Adding remote 'origin'..."
    git remote add origin "$REPO_URL"
fi

# Set main branch
git branch -M main

# Push to GitHub
echo ""
echo "Pushing to GitHub..."
if git push -u origin main; then
    echo ""
    echo "✅ Code pushed to GitHub successfully!"
    echo ""
else
    echo ""
    echo "⚠️  Push failed. This might be because:"
    echo "   1. Repository doesn't exist on GitHub yet"
    echo "   2. You need to authenticate (check credentials)"
    echo "   3. Branch protection rules are enabled"
    echo ""
    read -p "Try force push? (y/n): " FORCE_PUSH
    if [ "$FORCE_PUSH" = "y" ]; then
        git push -u origin main --force
    else
        echo "Manual push: git push -u origin main"
        exit 1
    fi
fi

echo "🎉 Setup Complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Next Steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1️⃣  Enable GitHub Pages:"
echo "   https://github.com/PocketMidi/KB1-flash/settings/pages"
echo ""
echo "   Under 'Build and deployment':"
echo "   - Source: Select 'GitHub Actions'"
echo "   - This auto-saves, no Save button needed"
echo ""
echo "2️⃣  Watch deployment:"
echo "   https://github.com/PocketMidi/KB1-flash/actions"
echo ""
echo "   Wait ~1-2 minutes for green checkmark ✓"
echo ""
echo "3️⃣  Visit your live site:"
echo "   🌐 https://PocketMidi.github.io/KB1-flash/"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📖 See GITHUB_SETUP.md for custom domain setup"
echo "📖 See DEPLOY.md for manual deployment steps"
echo ""
