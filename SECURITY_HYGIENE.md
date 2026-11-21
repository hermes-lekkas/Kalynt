# Security Hygiene Guide

This guide outlines practical credential-hygiene standards for everyone contributing to Kalynt.

---

## Never Commit Secrets

Never stage or commit any of the following files or values:

- **Private keys & certificates:** `deploy_key`, `deploy_key.pub`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, or anything under `.ssh/`.
- **Local environment files:** `.env`, `.env.local`, `*.env.*.local`, or local config overrides containing credentials.
- **Credentials & tokens:** Cloud AI API keys (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Z.ai), GitHub PATs (`ghp_*`, `github_pat_*`), TURN server credentials, signing certificates, or room passwords.
- **Personal profiles or logs:** Local Electron `userData` profiles, exported keychains, or QA artifacts containing live tokens.

---

## Pre-Commit Verification

Before committing, verify your staged diff:

```bash
# 1. Confirm no key, certificate, or env files are staged
git diff --cached --name-only | grep -E '\.(pem|key|p12|pfx)$|(^|/)\.env|deploy_key' || echo "OK: no secret files staged"

# 2. Scan staged additions for accidental tokens or hardcoded secrets
git diff --cached | grep -iE '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|github_pat_|AIza[0-9A-Za-z_-]{35})' || echo "OK: no token patterns found"

# 3. Verify ignore rules are active
git check-ignore -v .env deploy_key
```

### Local Pre-Commit Hook (Optional)

If `.github/hooks/pre-commit` is present in your checkout, install it locally:

```bash
cp .github/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

---

## Approved Secret Storage

| Context | Recommended Mechanism |
| --- | --- |
| **Desktop runtime** | Electron `safeStorage` backed by the OS keychain (Windows DPAPI, macOS Keychain, Linux Secret Service). |
| **Local development** | Untracked `.env` file documented via placeholder-only `.env.example`. |
| **CI/CD workflows** | Repository **Settings → Secrets and variables → Actions** (never echoed to logs). |
| **Automated tests** | Synthetic, non-functional placeholder strings and loopback-only mock HTTP servers (`127.0.0.1`). |

---

## Remediating an Accidental Exposure

If a real credential is ever committed or pushed, **assume it is compromised immediately**:

1. **Within 5 minutes — Revoke & rotate:** Revoke the exposed key/token at the provider and issue a replacement. Deleting a commit does not undo exposure in forks, clones, caches, or CI logs.
2. **If not yet pushed:** Amend or reset the local commit before pushing:
   ```bash
   git reset HEAD~1
   # Remove the secret from the file or untrack it, then commit cleanly
   ```
3. **If already pushed:** Coordinate with maintainers before rewriting history with `git filter-repo` (preferred over `git filter-branch`) and rotate every exposed credential:
   ```bash
   git filter-repo --path <secret-file> --invert-paths
   git push --force-with-lease origin <branch>
   ```
4. **Before every release:** Run `npm audit`, inspect `CHANGELOG.md` and documentation examples for accidental real credentials, and confirm release artifacts contain no local profile files.

---

## References

- [SECURITY.md](./SECURITY.md) — Kalynt security architecture and vulnerability disclosure policy
- [GitHub Docs: Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
