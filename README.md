# UFF Verify on Cloudflare (free, always on)
United Futbol Federation: black & white site + Discord/Roblox verification.

1. Open wrangler.toml and fill DISCORD_ID, GUILD_ID, VERIFIED_ROLE_ID.
2. In this folder run:
     npm install
     npx wrangler login
     npx wrangler secret put DISCORD_SECRET
     npx wrangler secret put DISCORD_BOT_TOKEN
     npx wrangler secret put SESSION_SECRET     (any long random string)
     npx wrangler secret put ADMIN_KEY          (any password, used once for the panel)
     npx wrangler deploy
3. Wrangler prints your site URL (https://uff-verify.YOURNAME.workers.dev).
   Add  <URL>/auth/discord/callback  to Redirects in the Discord developer portal (OAuth2).
4. Post the panel: open  <URL>/admin/panel?channel=CHANNEL_ID&key=ADMIN_KEY  once.

Graphics: the hero, gallery and banners are gray placeholder squares. Replace the IMG array at the top of the script in public/index.html with your own image paths.
Club logos: not included (gray monogram squares are shown). To add them put PNGs in public/logos/<league>/<club-slug>.png (leagues: pl, laliga, seriea, bund; e.g. fc-barcelona.png) and set HAVE_LOGOS=true in public/index.html.
