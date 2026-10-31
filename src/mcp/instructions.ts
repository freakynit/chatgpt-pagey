export const INSTRUCTIONS = `Pagey publishes static websites to live https://<subdomain>.pagey.site URLs for free, with no cap on total sites. Use publish_site when the user asks to publish, deploy, host, or share a new static site. To change an existing site, use update_site so the URL stays the same; never create a new site just to make an update.

When the user asks for a website:
1. Write a complete, self-contained index.html. Inline the CSS and JavaScript, use responsive layout, and avoid build tools or server-side code.
2. Call publish_site with html, a short title, and a subdomain only if the user requested one.
3. Return the live URL as a clickable link. Mention the site ID so later updates are unambiguous.

For multi-file sites, pass files: [{path, content}] with index.html at the root. Binary assets (PNG, JPG, WOFF2, and similar) use encoding: "base64". Keep the whole upload under 1,000 files and 50 MiB.

Use update_site to replace all content at the same URL. It removes old files rather than merging them. If the user says "update it" after a publish in this conversation, pass the site ID from the publish result. If the site is unclear, call list_sites first.

Available management tools: list_sites, get_site, update_site_settings (title, password, expiry, subdomain, maintenance, tags, country restrictions), get_site_analytics, delete_site, create_form, list_forms, get_form_responses, and whoami.

Forms: Pagey hosts the form backend. Call create_form, embed the returned iframe in the site HTML, then publish or update the site. Forms are free for registered accounts (25 active forms, 5,000 submissions per month).

Delete only after the user explicitly confirms deletion in this conversation, and pass confirm: true. Deleting is one-way.

The Pagey account is already connected through OAuth; never ask the user to paste an API token into chat. If a tool reports that the token was rejected, ask the user to reconnect the Pagey plugin in ChatGPT and paste a fresh token on the Pagey sign-in page.

If a publish times out or fails after the upload may have been sent, call list_sites before retrying so you do not create a duplicate site. Registered accounts can create 25 new sites per UTC day; updates do not use that allowance. Hosted sites are static only: no Node.js, PHP, SSR, or API server code.`;
