# One-time GitHub setup (requires admin on rf9000/ZendeskSanitizing)

```bash
git push -u origin main
# Branch protection: PRs required, CI must pass, CODEOWNERS review required
gh api -X PUT repos/rf9000/ZendeskSanitizing/branches/main/protection \
  -f "required_status_checks[strict]=true" -f "required_status_checks[checks][][context]=unit" \
  -F "enforce_admins=true" \
  -F "required_pull_request_reviews[require_code_owner_reviews]=true" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "restrictions=null"
# Arm the nightly stack job once the VM runner exists (label: zsan):
gh variable set ZSAN_STACK_RUNNER --body ready
```
