# site-og-check

Reusable GitHub Action that validates a website's **Open Graph / social-card**
(WhatsApp / iMessage / LinkedIn / Slack link preview) so a shared URL never
renders as a bare link.

## What it checks
- `og:title`, `og:description`, `og:type` present
- `og:image` present, **reachable (HTTP 200)**, absolute `https://`, and **real
  pixel dimensions ≥ 200×200** (warns below 600×315)
- `twitter:card == summary_large_image` and `twitter:image` present

Exit code `1` on any FAIL so it can gate a deployment.

## Use it in any site's CI (post-deploy)
```yaml
# .github/workflows/og-check.yml
name: OG Check
on:
  push:
    branches: [main]
  schedule:
    - cron: '17 */6 * * *'   # every 6h monitor
jobs:
  og:
    runs-on: ubuntu-latest
    steps:
      - uses: lucab85/site-og-check@main
        with:
          url: https://YOURSITE.com/
```

## Centralized monitor
The `monitor.yml` workflow in this repo validates all of Luca's sites on a
schedule and opens/updates an issue when any regresses.
