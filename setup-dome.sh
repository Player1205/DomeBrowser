#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  Dome Browser — Project Setup Script
#  Run this from the directory where you want dome-browser/ created.
#  Usage:  chmod +x setup-dome.sh && ./setup-dome.sh
# ─────────────────────────────────────────────────────────────────

set -e

PROJECT="dome-browser"
echo ""
echo "  ⬡  Setting up Dome Browser..."
echo ""

# 1. Create directory tree
mkdir -p "$PROJECT/src/main"
mkdir -p "$PROJECT/src/renderer/components"
mkdir -p "$PROJECT/src/renderer/styles"

echo "  ✓  Directory structure created"

# 2. Copy all source files from the zip into place
# (The zip already contains the correct folder layout —
#  just extract it with: unzip dome-browser-v1.zip)

# 3. Install dependencies
cd "$PROJECT"
echo "  →  Installing Electron (this may take a minute)..."
npm install
echo "  ✓  Dependencies installed"

echo ""
echo "  ─────────────────────────────────────"
echo "  Dome is ready. To launch:"
echo ""
echo "    cd $PROJECT"
echo "    npm start"
echo ""
echo "  For hot-reload dev mode:"
echo "    npm run dev"
echo "  ─────────────────────────────────────"
echo ""
