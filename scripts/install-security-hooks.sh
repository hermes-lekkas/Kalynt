#!/bin/bash
#
# Install security pre-commit hooks for Kalynt repository
# Run this script after cloning the repository
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HOOK_SOURCE="$REPO_ROOT/.github/hooks/pre-commit"

echo "🔒 Kalynt Security Hook Installer"
echo "================================="
echo ""

# Check if we're in a git repository (supports standard clones and git worktrees)
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "❌ Error: Not a git repository!"
    exit 1
fi

HOOK_DEST="$(git -C "$REPO_ROOT" rev-parse --git-path hooks/pre-commit)"
if [[ "$HOOK_DEST" != /* ]]; then
    HOOK_DEST="$REPO_ROOT/$HOOK_DEST"
fi

# Check if hook source exists
if [ ! -f "$HOOK_SOURCE" ]; then
    echo "❌ Error: Hook source not found at $HOOK_SOURCE"
    exit 1
fi

# Verify hook syntax before installing
if ! bash -n "$HOOK_SOURCE"; then
    echo "❌ Error: Hook source has invalid shell syntax!"
    exit 1
fi

# Check if hook already exists
if [ -f "$HOOK_DEST" ]; then
    echo "⚠️  A pre-commit hook already exists."
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
fi

# Copy and make executable
mkdir -p "$(dirname "$HOOK_DEST")"
cp "$HOOK_SOURCE" "$HOOK_DEST"
chmod +x "$HOOK_DEST"

echo "✅ Pre-commit hook installed successfully!"
echo ""

# Run a real self-test in an isolated temporary repository so we never mutate the working tree
echo "🧪 Running self-test..."
TEST_REPO="$(mktemp -d)"
cleanup() {
    rm -rf "$TEST_REPO"
}
trap cleanup EXIT

git -C "$TEST_REPO" init -q
git -C "$TEST_REPO" config user.email "hook-check@example.invalid"
git -C "$TEST_REPO" config user.name "Hook Check"
mkdir -p "$TEST_REPO/.git/hooks"
cp "$HOOK_DEST" "$TEST_REPO/.git/hooks/pre-commit"
chmod +x "$TEST_REPO/.git/hooks/pre-commit"

# 1. Staged secret must be blocked (filename avoids test/spec/fixture/example/sample skip rule)
printf 'api_key="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n' > "$TEST_REPO/credentials.env"
git -C "$TEST_REPO" add credentials.env
if git -C "$TEST_REPO" commit -m "Verify secret block" >/dev/null 2>&1; then
    echo "❌ Error: Hook self-test failed — staged secret was NOT blocked!"
    exit 1
fi
git -C "$TEST_REPO" rm -q --cached credentials.env
rm -f "$TEST_REPO/credentials.env"

# 2. Clean file must be allowed
printf 'export const ok = true\n' > "$TEST_REPO/clean.ts"
git -C "$TEST_REPO" add clean.ts
if ! git -C "$TEST_REPO" commit -m "Verify clean commit" >/dev/null 2>&1; then
    echo "❌ Error: Hook self-test failed — clean commit was unexpectedly blocked!"
    exit 1
fi
echo "✅ Hook is working correctly (blocks staged secrets and allows clean commits)"

echo ""
echo "📋 Next steps:"
echo "   1. Review SECURITY_HYGIENE.md for best practices"
echo "   2. Run: git check-ignore -v deploy_key .env"
echo "   3. Ensure your secrets are properly excluded"
echo ""
echo "🚨 IMPORTANT: If you have accidentally committed secrets:"
echo "   1. IMMEDIATELY revoke/rotate the compromised credentials"
echo "   2. Follow the cleanup steps in SECURITY_HYGIENE.md"
echo ""
echo "✨ Security hooks installed and ready!"
