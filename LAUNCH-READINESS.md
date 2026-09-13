# Launch readiness review - 13 September 2026

The private preview passes the website checks below. Public launch is still
pending verified email delivery and the deliberate switch out of preview mode.

## Fixed in this review

- Contact enquiries now use a labelled, validated form with an explicit email
  draft handoff, a copy button and a selectable-text fallback. No message is
  reported as sent by the website.
- The simulation entry page now requires the same preview password as the
  marketing pages. Its supporting JavaScript and CSS remain public assets.
- Added keyboard skip links, corrected the homepage main/footer landmarks,
  removed a duplicate product link, and updated the simulation teaser wording.
- Optimised the three oversized portraits for their displayed sizes. The
  encrypted homepage is approximately 1.2 MB, down from approximately 6.4 MB.
  The original photos remain available locally. Layout and scroll durations
  are unchanged.

## Verification

- 13 browser checks passed: page links, careers role selection, application
  validation and copy fallback, enquiry validation and copy fallback, film
  playback and failure recovery, independent film controls, keyboard access,
  unique IDs, password gates and simulation startup/controls.
- Responsive browser viewports: 320x568, 390x844, 768x1024, 1024x768,
  1440x1000 and 844x390. Visual review of desktop and phone layouts.
- Eight simulation regression checks passed, including all six scenarios,
  stopping before a blocked bridge and resetting state between runs. These
  verify the demonstration simulation; they are not real-world product validation.
- npm audit: zero reported dependency vulnerabilities.
- HTTPS is enforced on the configured GitHub Pages site.
- Browser automation used Microsoft Edge/Chromium. Physical-device and
  Safari/Firefox certification are not implied by these checks.

## Required before public enquiries and applications

Both forms prepare emails; the visitor must send the draft in their email
application, or copy the text into a message. There is no backend submission
service and no application/CV storage on this site.

On 13 September 2026, the local DNS lookup and Google's public DNS resolver
returned no MX records for cornu.ai. This does not establish whether a specific
mailbox can receive mail, but delivery to hello@cornu.ai and careers@cornu.ai
has not been verified. Confirm working, monitored mailboxes and perform a real
send/receive check before accepting public leads or applications. No email was
sent during this review.

## Public release settings

The current site remains password-protected and excluded from search indexing,
as requested. The configured URL is https://d-dufour.github.io/cornu-site/;
GitHub Pages has no custom domain configured.

An actual public release must deliberately remove the preview gates, publish
indexable page content and update robots/indexing metadata. If cornu.ai is the
intended website address, configure and verify that domain and HTTPS as part
of that release. None of those public-release switches were made in this review.
