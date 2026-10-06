// Cloudflare Worker: serves the site AND handles Discord + Roblox verification.
// No server to keep alive, no sleeping, free tier is enough.
//
// Variables (wrangler.toml [vars]):  DISCORD_ID, GUILD_ID, VERIFIED_ROLE_ID
// Secrets (wrangler secret put ...): DISCORD_SECRET, DISCORD_BOT_TOKEN, SESSION_SECRET, ADMIN_KEY

const enc = new TextEncoder();
const dec = new TextDecoder();
const UA = 'DiscordBot (https://workers.dev, 1.0)';

// ---------- signed cookie session (stateless) ----------
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function seal(secret, obj) {
  const p = b64u(enc.encode(JSON.stringify(obj)));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p)));
  return `${p}.${sig}`;
}
async function unseal(secret, token) {
  try {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return {};
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(s), enc.encode(p));
    return ok ? JSON.parse(dec.decode(unb64u(p))) : {};
  } catch { return {}; }
}
const getCookie = (req, name) =>
  (req.headers.get('Cookie') || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];

const form = (o) => new URLSearchParams(o).toString();
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- helpers ----------
async function robloxThumbs(id) {
  const g = async (t, size) => {
    try {
      const r = await (await fetch(`https://thumbnails.roblox.com/v1/users/${t}?userIds=${id}&size=${size}&format=Png&isCircular=false`)).json();
      return r?.data?.[0]?.imageUrl || null;
    } catch { return null; }
  };
  const [head, bust] = await Promise.all([g('avatar-headshot', '150x150'), g('avatar-bust', '420x420')]);
  return { head, bust };
}

async function giveDiscordPerks(env, discordId, robloxName) {
  if (!env.DISCORD_BOT_TOKEN || !env.GUILD_ID) return;
  const h = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': UA };
  const base = `https://discord.com/api/v10/guilds/${env.GUILD_ID}/members/${discordId}`;
  await fetch(base, { method: 'PATCH', headers: h, body: JSON.stringify({ nick: robloxName }) }).catch(() => {});
  if (env.VERIFIED_ROLE_ID)
    await fetch(`${base}/roles/${env.VERIFIED_ROLE_ID}`, { method: 'PUT', headers: h }).catch(() => {});
}


// ---------- worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const secure = origin.startsWith('https');
    const sess = await unseal(env.SESSION_SECRET, getCookie(request, 'uff'));
    let dirty = false;
    let clear = false;

    const finish = async (res) => {
      if (!dirty && !clear) return res;
      const value = clear ? '' : await seal(env.SESSION_SECRET, sess);
      const attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 2592000}${secure ? '; Secure' : ''}`;
      const headers = new Headers(res.headers);
      headers.append('Set-Cookie', `uff=${value}; ${attrs}`);
      return new Response(res.body, { status: res.status, headers });
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const redirect = (to) => new Response(null, { status: 302, headers: { Location: to } });
    const route = async () => {
      const { pathname: p } = url;
      const m = request.method;

      // ----- data for the frontend -----
      if (p === '/api/me') {
        const { discord = null, roblox = null } = sess;
        const th = roblox ? await robloxThumbs(roblox.id) : {};
        return json({
          discord: discord && { n: discord.n, h: discord.h, a: discord.a },
          roblox: roblox && roblox.name,
          robloxAvatar: th.head || null,
          robloxBody: th.bust || null,
          robloxMode: 'code',
        });
      }

      if (p === '/auth/logout') { clear = true; return redirect('/'); }

      // ----- Discord OAuth -----
      if (p === '/auth/discord') {
        sess.dstate = randHex(16); dirty = true;
        return redirect('https://discord.com/oauth2/authorize?' + form({
          client_id: env.DISCORD_ID, response_type: 'code', scope: 'identify',
          redirect_uri: `${origin}/auth/discord/callback`, state: sess.dstate, prompt: 'none',
        }));
      }
      if (p === '/auth/discord/callback') {
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.get('state') !== sess.dstate) return new Response('Bad state, go back and try again', { status: 400 });
        const t = await (await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: form({
            client_id: env.DISCORD_ID, client_secret: env.DISCORD_SECRET, grant_type: 'authorization_code',
            code, redirect_uri: `${origin}/auth/discord/callback`,
          }),
        })).json();
        if (!t.access_token) return new Response('Discord login failed', { status: 502 });
        const u = await (await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bearer ${t.access_token}`, 'User-Agent': UA },
        })).json();
        const a = u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
        sess.discord = { id: u.id, n: u.global_name || u.username, h: u.username, a };
        delete sess.dstate; dirty = true;
        return redirect('/me');
      }

      // ----- Roblox: code in profile "About" (no Roblox app needed) -----
      if (p === '/auth/roblox-code/start' && m === 'POST') {
        if (!sess.discord) return json({ error: 'Log in with Discord first' }, 401);
        const body = await request.json().catch(() => ({}));
        const username = String(body.username || '').trim();
        if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return json({ error: 'Invalid Roblox username' }, 400);
        const r = await (await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
        })).json();
        const u = r?.data?.[0];
        if (!u) return json({ error: 'Roblox user not found' }, 404);
        const code = 'UFF-' + randHex(4).toUpperCase();
        sess.rpending = { id: String(u.id), name: u.name, code, exp: Date.now() + 10 * 60 * 1000 }; dirty = true;
        return json({ code, name: u.name });
      }
      if (p === '/auth/roblox-code/check' && m === 'POST') {
        const pend = sess.rpending;
        if (!sess.discord || !pend || Date.now() > pend.exp) return json({ error: 'Code expired, start again' }, 400);
        const prof = await (await fetch(`https://users.roblox.com/v1/users/${pend.id}`)).json();
        if (!String(prof.description || '').includes(pend.code))
          return json({ error: 'Code not found in your profile About section yet' }, 400);
        sess.roblox = { id: pend.id, name: pend.name };
        delete sess.rpending; dirty = true;
        await giveDiscordPerks(env, sess.discord.id, pend.name);
        return json({ ok: true });
      }

      // ----- one-time: post the verification panel into a channel -----
      // open: https://YOUR-SITE/admin/panel?channel=CHANNEL_ID&key=ADMIN_KEY
      if (p === '/admin/panel') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('Forbidden', { status: 403 });
        const channel = url.searchParams.get('channel');
        if (!/^\d+$/.test(channel || '')) return new Response('Add ?channel=CHANNEL_ID', { status: 400 });
        const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({
            embeds: [{
              title: 'Verification',
              description: 'Link your accounts to get your role and nickname.\n\n**1.** Verify with Discord\n**2.** Verify with Roblox\n\nEverything happens on our website and takes about 30 seconds. We never see your passwords.',
              color: 0xffffff,
            }],
            components: [{
              type: 1,
              components: [
                { type: 2, style: 5, label: 'Verify with Discord', url: `${origin}/auth/discord` },
                { type: 2, style: 5, label: 'Verify with Roblox', url: `${origin}/me?connect=roblox` },
              ],
            }],
          }),
        });
        return new Response(res.ok ? 'Panel posted.' : `Discord error ${res.status}: ${await res.text()}`, { status: res.ok ? 200 : 502 });
      }

      // ----- the site itself -----
      if (p === '/me') return env.ASSETS.fetch(new Request(new URL('/', request.url)));
      return env.ASSETS.fetch(request);
    };

    try { return await finish(await route()); }
    catch (e) { console.error(e); return new Response('Server error', { status: 500 }); }
  },
};
