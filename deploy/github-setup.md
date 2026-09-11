# One-time GitHub setup (requires admin on rf9000/ZendeskSanitizing)

```bash
git push -u origin main
# Branch protection: PRs required, CI must pass, CODEOWNERS review required
# app_id is intentionally omitted from each check — GitHub defaults it to "any app".
gh api -X PUT repos/rf9000/ZendeskSanitizing/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "unit" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "require_code_owner_reviews": true, "required_approving_review_count": 1 },
  "restrictions": null
}
EOF
# Arm the nightly stack job once the VM runner exists (label: zsan):
gh variable set ZSAN_STACK_RUNNER --body ready
```
