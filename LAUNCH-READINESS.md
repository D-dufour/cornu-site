# Public hosting readiness - 17 September 2026

The local website is prepared for https://cornu.ai on Yourhosting.
The upload package is release/cornu-yourhosting.zip (about 12 MB).
It contains 21 static files and requires no server-side Node.js process.

## Completed

- Removed the password screen and encryption from all four pages.
- Replaced encrypted video payloads with three ordinary MP4 files.
- Removed preview-password storage and browser decryption code.
- Enabled search indexing and generated canonical URLs and sitemap.xml.
- Preserved phone layouts, film controls and the interactive simulation.
- Preserved incoming contact links after the opening animation.
- Made marketing text accessible with JavaScript disabled, with direct
  email links in place of interactive forms.
- Added a repeatable Windows packaging script and Yourhosting setup guide.

## Verification

- All 15 browser checks passed in Microsoft Edge/Chromium against a local
  static server, with no saved password or authentication setup.
- Checks include public page access, crawlable HTML, SEO metadata, sitemap,
  navigation, contact deep links, mobile simulation controls, form validation,
  keyboard access, responsive widths from 320 to 1440 pixels, and MP4 loading,
  playback, pause behaviour and recovery from a failed request.
- All 21 ZIP entries match the generated website by SHA-256 and use forward
  slash paths for extraction on Linux hosting.
- All eight simulation regressions passed, covering six scenarios, stopping
  before a blocked bridge and resetting simulation state.
- git diff --check passed.
- These are local checks; the Yourhosting deployment is not yet live.

## Account setup still needed

Upload and extract the ZIP into the domain's document root, configure DNS
using the values from the Yourhosting account, activate HTTPS, and redirect
www to the preferred cornu.ai address. Follow YOURHOSTING-SETUP.md.

The contact and careers forms prepare email drafts; visitors send them in
their own email app or use the copy fallback. There is no backend submission
or CV storage. Configure and test hello@cornu.ai and careers@cornu.ai before
accepting public enquiries. A local MX lookup on 17 September 2026 returned
no MX records; mailbox delivery has not been verified and no email was sent.

No hosting account, DNS records or existing live deployment was changed.
