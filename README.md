# site-og-check

Reusable GitHub Action that validates a website's **Open Graph / social-card**
(WhatsApp / iMessage / LinkedIn / Slack link preview) so a shared URL never
renders as a bare link.

## What it checks
- `og:title`, `og:description`, `og:type` present
- `og:image` present, **reachable (HTTP 200)**, absolute `https://`, and **real
  pixel dimensions ≥ 200×200** (warns below 600×315)
- `twitter:card == summary_large_image` and `twitter:image` present
- the tags are in `<head>` and written the way **WhatsApp** reads them:
  `<meta property="og:image" content="https://...">` with quoted values.
  HTML minifiers that drop the quotes (`<meta content=https://... property=og:image>`)
  pass Facebook's debugger, but WhatsApp shows the link with no image
- `og:image` fetched with the WhatsApp user agent (a bot rule or WAF that blocks
  it fails), served as an image, JPEG/PNG (SVG fails, WebP/GIF warn), **under
  600 KB** (warns above 300 KB), and matching `og:image:width`/`height` if declared

Run the tests with `node test/run.cjs`.

### Built output
```bash
node validate-og.cjs --dir ./public --site https://example.com          # homepage
node validate-og.cjs --dir ./public --site https://example.com --all --quiet
```
`--site` lets images on your own domain be checked as files in the build, with no network.

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
