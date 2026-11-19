# Security Hygiene Guide for Kalynt Contributors

## 🚨 CRITICAL: Never Commit Secrets

This document outlines security best practices for the Kalynt project to prevent accidental exposure of sensitive credentials.

---

## ❌ NEVER Commit These Files

### Private Keys & Certificates
- `deploy_key` / `deploy_key.pub` - SSH deployment keys
- `*.pem` - PEM certificate files
- `*.key` - Private key files
- `id_rsa` / `id_rsa.pub` - SSH RSA keys
- `id_ed25519` / `id_ed25519.pub` - SSH Ed25519 keys
- Any files in `.ssh/` directory

### Environment & Configuration
- `.env` - Environment files with secrets
- `.env.local` - Local environment overrides
- `*.env.*.local` - Any local environment files
- Configuration files containing API keys, tokens, or passwords

### Secrets & Tokens
- API keys (OpenAI, GitHub, AWS, etc.)
- Database connection strings with credentials
- JWT signing keys
- Encryption keys
- OAuth client secrets

---

## ✅ Pre-Commit Checklist

Before every commit, verify:

1. **No keys in staging area:**
   ```bash
   git diff --cached --name-only | grep -E "(key|pem|env)" || echo "✅ No suspicious files"
   ```

2. **Check for secrets in code:**
   ```bash
   git diff --cached | grep -iE "(api_key|secret|password|token)" || echo "✅ No hardcoded secrets"
   ```

3. **Files are properly ignored:**
   ```bash
   git check-ignore -v deploy_key .env
   ```

---

## 🔧 Setup Secret Detection

### Install Pre-Commit Hook

```bash
# Copy the pre-commit hook to your local .git directory
cp .github/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Test the hook
echo "test-api-key-12345678901234567890123456789012" > /tmp/test.txt
git add /tmp/test.txt
git commit -m "test"  # Should block the commit
rm /tmp/test.txt
```

### GitHub Secret Scanning

The repository has GitHub secret scanning enabled. If a secret is accidentally pushed:

1. **IMMEDIATELY** revoke/rotate the compromised credential
2. Remove the secret from git history (see below)
3. Contact the maintainers

---

## 🧹 Removing Secrets from History

If a secret was accidentally committed:

### Option 1: For unpushed commits (simplest)
```bash
# Amend the last commit
git reset HEAD~1
# Remove the secret file, then recommit
git add .
git commit -m "new commit message"
```

### Option 2: For pushed commits (complex)
```bash
# Use git-filter-repo (preferred) or filter-branch
# WARNING: This rewrites history - coordinate with team

git filter-repo --path deploy_key --invert-paths
git push --force-with-lease origin main
```

### Option 3: For simple file removal
```bash
git rm --cached deploy_key
git commit -m "Remove accidentally committed key"
echo "deploy_key" >> .gitignore
git add .gitignore
git commit -m "Add key to gitignore"
```

**⚠️ IMPORTANT:** Even after removal from git, the secret may exist in:
- GitHub's backup systems (contact GitHub support)
- CI/CD logs
- Team members' local clones
- Forks of the repository

**ALWAYS rotate/revoke the compromised credential!**

---

## 📋 Secure Storage Alternatives

Instead of committing secrets, use:

### 1. Environment Variables
```bash
# .env.example (safe to commit)
OPENAI_API_KEY=your_api_key_here
GITHUB_TOKEN=your_token_here
```

### 2. System Keyring (Desktop)
- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service API / kwallet

### 3. GitHub Secrets (CI/CD)
Store in repository Settings → Secrets and variables → Actions

---

## 🔍 Regular Security Audits

### Weekly Checks
```bash
# Scan for potential secrets in repo
git log --all --full-history -- .env deploy_key *.pem 2>/dev/null || echo "✅ No secret files in history"

# Check for high-entropy strings
git grep -n "sk-[a-zA-Z0-9]\{20,\}" || echo "✅ No API keys found"
```

### Before Releases
1. Run `npm audit` or equivalent
2. Check `CHANGELOG.md` for any credential mentions
3. Verify no secrets in documentation examples

---

## 🆘 Incident Response

If a secret is exposed:

1. **Within 5 minutes:**
   - Revoke the credential at the provider (GitHub, AWS, etc.)
   - Document what was exposed

2. **Within 30 minutes:**
   - Remove from git history if pushed
   - Notify affected team members

3. **Within 24 hours:**
   - Generate new credentials
   - Update all deployments
   - Review access logs for unauthorized usage

---

## 📚 Additional Resources

- [GitHub Docs: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [Git-Secrets by AWS Labs](https://github.com/awslabs/git-secrets)
- [Talisman by ThoughtWorks](https://github.com/thoughtworks/talisman)

---

**Questions?** Contact the security team or open a private security advisory.