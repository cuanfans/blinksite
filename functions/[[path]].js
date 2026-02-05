import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { sha256, encryptJSON } from '../src/utils'
import { executePayment } from '../src/engine'
import { uploadImage } from '../src/modules/cloudinary'
import { checkShipping } from '../src/modules/shipping'

const app = new Hono()
const JWT_SECRET = 'RAHASIA_NEGARA_GANTI_DENGAN_ENV_VAR'

// ===============================================
// 0. GLOBAL CONFIG
// ===============================================
app.use('*', async (c, next) => {
    await next();
});

app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`, err.stack);
    return c.json({ success: false, message: 'Internal Server Error' }, 500);
});

async function serveAsset(c, path) {
    try {
        const url = new URL(path, c.req.url);
        return await c.env.ASSETS.fetch(url);
    } catch (e) {
        return c.text('Asset Not Found', 404);
    }
}

// ===============================================
// 1. MIDDLEWARE AUTH
// ===============================================
const requireAuth = async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/admin/login' || path === '/api/login' || path.includes('.')) {
        await next(); return;
    }
    const token = getCookie(c, 'auth_token');
    if (!token) {
        if (path.startsWith('/api/')) return c.json({ error: 'Unauthorized' }, 401);
        return c.redirect('/login');
    }
    try {
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        await verify(token, secret);
        await next();
    } catch (e) {
        deleteCookie(c, 'auth_token');
        return c.redirect('/login');
    }
};

app.use('/admin*', requireAuth);
app.use('/api/admin*', requireAuth);

// ===============================================
// 2. AUTH & ADMIN ROUTES
// ===============================================
app.post('/api/login', async (c) => {
    try {
        const { password } = await c.req.json();
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const realHash = dbSetting ? dbSetting.value : '';
        const inputHash = await sha256(password);

        if (inputHash !== realHash) return c.json({ success: false, message: 'Password Salah' }, 401);

        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const token = await sign({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 }, secret);
        setCookie(c, 'auth_token', token, { path: '/', secure: true, httpOnly: true, maxAge: 86400, sameSite: 'Lax' });
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});

app.get('/api/logout', (c) => { deleteCookie(c, 'auth_token'); return c.redirect('/login'); });

// Admin HTML Mapping
app.get('/login', (c) => serveAsset(c, '/login.html'));
app.get('/admin', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/dashboard', (c) => serveAsset(c, '/admin/dashboard.html'));
app.get('/admin/pages', (c) => serveAsset(c, '/admin/pages.html'));
app.get('/admin/editor', (c) => serveAsset(c, '/admin/editor.html'));
app.get('/admin/reports', (c) => serveAsset(c, '/admin/reports.html'));
app.get('/admin/analytics', (c) => serveAsset(c, '/admin/analytics.html'));
app.get('/admin/settings', (c) => serveAsset(c, '/admin/settings.html'));

// ===============================================
// 3. API DATA ROUTES (API ADMIN)
// ===============================================

// GET ALL PAGES
app.get('/api/admin/pages', async (c) => {
    try {
        const res = await c.env.DB.prepare("SELECT id, slug, title, product_type, created_at FROM pages ORDER BY created_at DESC").all();
        return c.json(res.results);
    } catch(e) { return c.json({ error: e.message }, 500); }
});

// SAVE PAGE
app.post('/api/admin/pages', async (c) => {
    const { slug, title, html, css, product_config, product_type } = await c.req.json();
    try {
        await c.env.DB.prepare(
            `INSERT INTO pages (slug, title, html_content, css_content, product_config_json, product_type) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET 
             title=excluded.title, html_content=excluded.html_content, css_content=excluded.css_content, product_config_json=excluded.product_config_json, product_type=excluded.product_type`
        ).bind(slug, title, html, css, JSON.stringify(product_config), product_type || 'physical').run();
        return c.json({ success: true });
    } catch(e) { return c.json({ error: e.message }, 500); }
});

// GET SINGLE PAGE
app.get('/api/admin/pages/:slug', async (c) => {
    const slug = c.req.param('slug');
    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
    if(page) page.product_config_json = JSON.parse(page.product_config_json || '{}');
    return c.json(page || {});
});

// --- FITUR HOMEPAGE (YANG HILANG DIKEMBALIKAN) ---

// 1. Set Homepage
app.post('/api/admin/set-homepage', async (c) => {
    try {
        const { slug } = await c.req.json();
        // Insert atau Update setting homepage
        await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('homepage_slug', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(slug).run();
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: e.message }, 500);
    }
});

// 2. Get Current Homepage (Untuk UI)
app.get('/api/admin/homepage-slug', async (c) => {
    try {
        const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
        return c.json({ slug: s ? s.value : null });
    } catch(e) { return c.json({ slug: null }); }
});

// SAVE CREDENTIALS
app.post('/api/admin/credentials', async (c) => {
    const { provider, data } = await c.req.json();
    const { encrypted, iv } = await encryptJSON(data, c.env.APP_MASTER_KEY || JWT_SECRET);
    await c.env.DB.prepare(
        `INSERT INTO credentials (provider_slug, encrypted_data, iv) VALUES (?, ?, ?)
         ON CONFLICT(provider_slug) DO UPDATE SET encrypted_data=excluded.encrypted_data, iv=excluded.iv`
    ).bind(provider, encrypted, iv).run();
    return c.json({ success: true });
});

app.post('/api/admin/upload-image', uploadImage);
app.post('/api/shipping/check', checkShipping);

// ===============================================
// 4. PUBLIC & RENDER ROUTES
// ===============================================
app.get('/', async (c) => {
    try {
        const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
        if (s && s.value) {
            const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(s.value).first();
            if (page) return renderPage(c, page);
        }
    } catch (e) {}
    return serveAsset(c, '/index.html');
});

app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (slug.includes('.')) return c.env.ASSETS.fetch(c.req.raw);

    try {
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
        if(!page) return c.text('404 Not Found', 404);
        
        // Track View
        c.env.DB.prepare("INSERT INTO analytics (page_id, event_type, referrer) VALUES (?, 'view', ?)").bind(page.id, c.req.header('Referer') || 'direct').run().catch(()=>{});
        
        return renderPage(c, page);
    } catch(e) { return c.env.ASSETS.fetch(c.req.raw); }
});

// ===============================================
// 5. PAGE RENDERER ENGINE
// ===============================================
function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const settings = config.settings || {}; 
    const url = c.req.url;

    let headScripts = '';
    
    // Facebook Pixel
    if (settings.fb_pixel_id) {
        headScripts += `
        <script>
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', '${settings.fb_pixel_id}');
        fbq('track', 'PageView');
        </script>
        <noscript><img height="1" width="1" style="display:none"
        src="https://www.facebook.com/tr?id=${settings.fb_pixel_id}&ev=PageView&noscript=1"
        /></noscript>`;
    }

    // TikTok Pixel
    if (settings.tiktok_pixel_id) {
        headScripts += `
        <script>
        !function (w, d, t) {
          w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];
          ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],
          ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
          for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
          ttq.instance=function(t){for(var e=ttq.methods[i],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},
          ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";
          ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};
          var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;
          var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};
          ttq.load('${settings.tiktok_pixel_id}');
          ttq.page();
        }(window, document, 'ttq');
        </script>`;
    }

    if (settings.custom_head) {
        headScripts += settings.custom_head;
    }

    const appScript = `
    <script>
        window.PAGE_ID = ${page.id};
        window.PRODUCT_TYPE = "${page.product_type || 'physical'}";
        window.PRODUCT_VARIANTS = ${JSON.stringify(config.variants || [])};
        window.ORDER_BUMP = ${JSON.stringify(config.order_bump || {active:false})};
        window.SHIPPING_CONFIG = ${JSON.stringify(config.shipping || {weight: 1000})};
        
        document.addEventListener('DOMContentLoaded', () => {
            const checkoutContainer = document.querySelector('[data-gjs-type="checkout-widget"]');
            if(checkoutContainer) {
                console.log('Checkout Widget Detected');
                // Di sini nanti logika load form checkout
            }
        });
    </script>`;

    // Meta Data
    const metaTitle = settings.seo_title || page.title;
    const metaDesc = settings.seo_description || '';
    const ogTitle = settings.og_title || metaTitle;
    const ogDesc = settings.og_description || metaDesc;
    const ogImage = settings.og_image || '';

    return c.html(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        
        <title>${metaTitle}</title>
        <meta name="description" content="${metaDesc}">
        ${settings.favicon ? `<link rel="icon" href="${settings.favicon}">` : ''}

        <meta property="og:type" content="website" />
        <meta property="og:url" content="${url}" />
        <meta property="og:title" content="${ogTitle}" />
        <meta property="og:description" content="${ogDesc}" />
        ${ogImage ? `<meta property="og:image" content="${ogImage}" />` : ''}

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${ogTitle}" />
        <meta name="twitter:description" content="${ogDesc}" />
        ${ogImage ? `<meta name="twitter:image" content="${ogImage}" />` : ''}

        <script src="https://cdn.tailwindcss.com"></script>
        <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
        <style>
            ${page.css_content}
            [x-cloak] { display: none !important; }
        </style>

        ${headScripts}
    </head>
    <body class="antialiased">
        ${page.html_content}
        ${appScript}
        ${settings.custom_footer || ''}
    </body>
    </html>`);
}

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export const onRequest = handle(app);
