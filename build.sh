#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "============================================="
echo "   LANLink Production Build System"
echo "============================================="

# 1. Clean previous build artifacts
echo "🧹 Cleaning previous build artifacts..."
rm -rf dist

# 2. Verify dependencies
echo "📦 Verifying dependencies..."
npm install

# 3. Syntax validation check
echo "🔍 Running code syntax verification..."
node -c src/main.js
node -c src/preload.js

# 4. Build for macOS (Universal: x64 + arm64)
echo "🍏 Building for macOS (dmg, zip)..."
npx electron-builder --mac --x64 --arm64

# 5. Build for Windows (x64, arm64)
echo "🪟 Building for Windows (nsis installer, zip)..."
npx electron-builder --win --x64 --arm64

echo "============================================="
echo "🎉 Build finished successfully!"
echo "Artifacts are stored in the 'dist' directory."
echo "============================================="
