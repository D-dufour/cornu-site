# Publish Cornu on Yourhosting

The public website is prepared for **https://cornu.ai/**. All four pages and
three films open without a password. No Node.js, PHP, database or WordPress
installation is needed on the server.

## Upload the website

1. Open **Mijn Yourhosting**, enter the **Plesk Hostingmanager**, and select
   the website for `cornu.ai`.
2. Open **Bestanden / Files** and the domain's document root (normally
   `httpdocs`; check Hosting Settings if your account uses another folder).
3. Back up any existing website before replacing it. Move any provider
   placeholder `index.php` or `index.htm` out of the document root so it does
   not take priority over this site's `index.html`.
4. Upload `release/cornu-yourhosting.zip` and extract its contents **directly
   into the document root**. The resulting layout must be:

   ```text
   httpdocs/
     index.html
     products/index.html
     careers/index.html
     simulation/index.html
     simulation/assets/...
     media/shot1.mp4
     media/shot2.mp4
     media/shot3.mp4
     robots.txt
     sitemap.xml
     .nojekyll
   ```

   Do not place these inside an extra `docs` or `cornu-yourhosting` folder.
   You can alternatively upload the contents of the local `docs` folder via
   FTP. The `.nojekyll` file is harmless and only used by GitHub Pages.
5. Remove the uploaded ZIP from the server after extraction. Keep the local
   ZIP for future use. Authoring files, build scripts and `node_modules` stay
   on your computer.

Yourhosting documents [uploads through Plesk and FTP](https://yourhosting.freshdesk.com/support/solutions/articles/80000821326-je-website-of-bestanden-bij-yourhosting-uploaden-via-ftp).
Plesk documents [the default httpdocs directory](https://docs.plesk.com/nl-NL/obsidian/customer-guide/snel-aan-de-slag-met-plesk/uw-eerste-website-opzetten/1-uw-site-aanmaken/bestanden-uploaden.70312/).

## Domain and HTTPS

Point `cornu.ai` at the server details provided in your Yourhosting account.
Use the actual account-specific DNS values; they are not included in this
package. Preserve existing email records when changing website DNS.

Activate a certificate for `cornu.ai` (and `www.cornu.ai` if you use it), then
enable the HTTP-to-HTTPS redirect in Plesk. Set `cornu.ai` as the preferred
domain so `www` redirects to it. Yourhosting offers
[free Let's Encrypt SSL through Plesk](https://www.yourhosting.nl/webhosting/ssl-certificaat/).
The website's canonical links and sitemap use `https://cornu.ai/`.

## Check the live website

Open a private browser window and check:

- `https://cornu.ai/`, `/products/`, `/careers/` and `/simulation/` open directly.
- The three homepage films and the product film play, including on a phone.
- The product page's contact link lands at the homepage contact section.
- `https://cornu.ai/robots.txt` allows crawling and links to `/sitemap.xml`.
- HTTP redirects to HTTPS and there is no certificate warning.

The contact and application forms prepare email drafts and provide a copy
fallback. Visitors must send the email themselves. The website does not
send or store submissions. Configure and test **hello@cornu.ai** and
**careers@cornu.ai** with your email provider before accepting enquiries.
No MX records were returned by the local DNS lookup on 17 September 2026;
mailbox delivery has not been verified.

## Publish later edits

Edit the authoring files in `source/`. From this project folder run:

```powershell
node build.js
$env:PW_CHANNEL='msedge'
npm test
```

Then rebuild the upload ZIP:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\package-yourhosting.ps1
```

Upload and extract the new package into the same document root. Node.js is
only needed on your computer to build changes. If the main domain changes,
set `CORNU_SITE_URL` before building so canonical URLs and the sitemap match.
