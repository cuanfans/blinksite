import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { sha256, encryptJSON } from '../src/utils'
import { executePayment } from '../src/engine'
import { uploadImage } from '../src/modules/cloudinary'
import { checkShipping } from '../src/modules/shipping'

const app = new Hono()
const JWT_SECRET = 'BantarCaringin1234567890BantarCaringin1234567890BantarCaringin1234567890' // Ganti dengan c.env.APP_SECRET di production

// ===============================================
// 0. GLOBAL CONFIG & LOGGING
// ===============================================

// Middleware: Log Request (Paling Atas)
app.use('*', async (c, next) => {
    console.log(`[${c.req.method}] ${c.req.url}`);
    await next();
});

// Error Handler
app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`);
    console.error(err.stack);
    return c.json({ success: false, message: 'Internal Server Error', debug: err.message }, 500);
});

// Helper: Serve Asset
async function serveAsset(c, path) {
    try {
        const url = new URL(path, c.req.url);
        return await c.env.ASSETS.fetch(url);
    } catch (e) {
        return c.text('Asset Not Found', 404);
    }
}

// ===============================================
// 1. AUTH MIDDLEWARE LOGIC
// ===============================================

// Kita definisikan fungsi middleware secara terpisah agar bisa dipakai berulang
const requireAuth = async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // 1. Whitelist: Biarkan halaman login dan file asset (titik) lewat
    if (path === '/admin/login' || path === '/api/login' || path.includes('.')) {
        await next();
        return;
    }

    // 2. Ambil Cookie
    const token = getCookie(c, 'auth_token');

    // 3. Jika tidak ada token -> TENDANG
    if (!token) {
        if (path.startsWith('/api/')) {
            return c.json({ error: 'Unauthorized: No Token' }, 401);
        }
        return c.redirect('/login');
    }

    // 4. Verifikasi Token JWT
    try {
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const payload = await verify(token, secret);
        c.set('jwtPayload', payload); // Simpan info user di context
        await next();
    } catch (e) {
        // Token tidak valid/expired
        deleteCookie(c, 'auth_token');
        if (path.startsWith('/api/')) {
            return c.json({ error: 'Unauthorized: Invalid Token' }, 401);
        }
        return c.redirect('/login');
    }
};

// TERAPKAN MIDDLEWARE KE RUTE SPESIFIK (JANGAN PAKAI ARRAY DI SINI)
app.use('/admin*', requireAuth);
app.use('/api/admin*', requireAuth);

// ===============================================
// 2. AUTH ROUTES (LOGIN & LOGOUT)
// ===============================================

app.post('/api/login', async (c) => {
    try {
        const { password } = await c.req.json();
        
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const realHash = dbSetting ? dbSetting.value : '';
        const inputHash = await sha256(password);

        if (inputHash !== realHash) {
            return c.json({ success: false, message: 'Password Salah' }, 401);
        }

        // Buat Token
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const token = await sign({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 }, secret);

        // Set Cookie HttpOnly
        setCookie(c, 'auth_token', token, {
            path: '/',
            secure: true,
            httpOnly: true,
            maxAge: 86400,
            sameSite: 'Lax',
        });

        return c.json({ success: true });
    } catch (e) {
        console.error(e);
        return c.json({ success: false, error: e.message }, 500);
    }
});

app.get('/api/logout', (c) => {
    deleteCookie(c, 'auth_token');
    return c.redirect('/login');
});

// ===============================================
// 3. HTML ROUTES (Static & Admin)
// ===============================================

// Login Page
app.get('/login', (c) => serveAsset(c, '/login.html'));
app.get('/login.html', (c) => serveAsset(c, '/login.html'));
app.get('/admin/login', (c) => c.redirect('/login'));

// Admin Pages (Protected by requireAuth)
app.get('/admin', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/dashboard', (c) => serveAsset(c, '/admin/dashboard.html'));
app.get('/admin/pages', (c) => serveAsset(c, '/admin/pages.html'));
app.get('/admin/editor', (c) => serveAsset(c, '/admin/editor.html'));
app.get('/admin/reports', (c) => serveAsset(c, '/admin/reports.html'));
app.get('/admin/analytics', (c) => serveAsset(c, '/admin/analytics.html'));
app.get('/admin/settings', (c) => serveAsset(c, '/admin/settings.html'));

// Homepage
app.get('/', async (c) => {
    try {
        const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
        if (s && s.value) {
            const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(s.value).first();
            if (page) return renderPage(c, page);
        }
    } catch (e) {}
    return serveAsset(c, '/index.html');
})

// Dynamic Landing Pages
app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (slug.includes('.')) return c.env.ASSETS.fetch(c.req.raw);

    try {
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
        if(!page) return c.text('404 Not Found', 404);
        
        c.env.DB.prepare("INSERT INTO analytics (page_id, event_type, referrer) VALUES (?, 'view', ?)").bind(page.id, c.req.header('Referer') || 'direct').run().catch(()=>{});
        
        return renderPage(c, page);
    } catch(e) {
        return c.env.ASSETS.fetch(c.req.raw);
    }
});

// ===============================================
// 4. API ROUTES (Protected & Public)
// ===============================================

// --- Protected APIs ---
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
// API Get All Pages (Untuk List di Admin)
app.get('/api/admin/pages', async (c) => {
    try {
        // Ambil data penting saja (id, title, slug, type) agar ringan
        const result = await c.env.DB.prepare("SELECT id, slug, title, product_type, created_at FROM pages ORDER BY created_at DESC").all();
        return c.json(result.results);
    } catch(e) {
        return c.json({ error: e.message }, 500);
    }
});

app.get('/api/admin/pages/:slug', async (c) => {
    const slug = c.req.param('slug');
    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
    if(page) page.product_config_json = JSON.parse(page.product_config_json || '{}');
    return c.json(page || {});
});

app.post('/api/admin/set-homepage', async (c) => {
    const { slug } = await c.req.json();
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('homepage_slug', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(slug).run();
    return c.json({ success: true });
});

app.get('/api/admin/analytics-data', async (c) => {
    try {
        const visitors = await c.env.DB.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='view'").first().catch(() => ({c:0}));
        const sales = await c.env.DB.prepare("SELECT SUM(amount) as s FROM transactions WHERE status='settlement'").first().catch(() => ({s:0}));
        return c.json({
            visitors: visitors.c || 0,
            revenue: sales.s || 0,
            conversion: visitors.c > 0 ? ((sales.s > 0 ? 1 : 0) / visitors.c * 100).toFixed(1) : 0
        });
    } catch (e) { return c.json({ visitors: 0, revenue: 0, conversion: 0 }); }
});

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

// --- Public APIs ---
app.post('/api/shipping/check', checkShipping);
app.post('/api/check-coupon', async (c) => {
    const { page_id, code } = await c.req.json();
    const page = await c.env.DB.prepare("SELECT product_config_json FROM pages WHERE id=?").bind(page_id).first();
    const config = JSON.parse(page.product_config_json || '{}');
    const valid = (config.coupons || []).find(cp => cp.code === code.toUpperCase());
    if(valid) return c.json({ success: true, type: valid.type, value: valid.value, message: "Kupon OK" });
    return c.json({ success: false, message: "Kode Invalid" });
});

app.post('/api/checkout', async (c) => {
    try {
        const { page_id, provider, variant_id, coupon_code, with_bump, customer } = await c.req.json();
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(page_id).first();
        if(!page) throw new Error("Halaman 404");
        
        const config = JSON.parse(page.product_config_json || '{}');
        const selectedVariant = (config.variants || []).find(v => v.id == variant_id);
        if(!selectedVariant) throw new Error("Varian 404");
        
        let finalPrice = selectedVariant.price;
        if (with_bump && config.order_bump?.active) finalPrice += config.order_bump.price;
        if (coupon_code) {
            const cp = (config.coupons || []).find(c => c.code === coupon_code.toUpperCase());
            if (cp) finalPrice -= (cp.type === 'percent' ? Math.round(finalPrice * cp.value / 100) : cp.value);
        }
        if(finalPrice < 0) finalPrice = 0;

        const orderId = `TRX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const customerData = JSON.stringify({ ...customer, item: selectedVariant.name, coupon: coupon_code });

        await c.env.DB.prepare(
            `INSERT INTO transactions (page_id, order_id, provider, amount, status, customer_info) VALUES (?, ?, ?, ?, 'pending', ?)`
        ).bind(page_id, orderId, provider, finalPrice, customerData).run();

        const result = await executePayment(c, provider, finalPrice, orderId);
        return c.json(result);
    } catch(e) { return c.json({ success: false, message: e.message }, 500); }
});

// Helper Render
function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const scriptInject = `<script>window.PAGE_ID=${page.id};window.PRODUCT_VARIANTS=${JSON.stringify(config.variants||[])};window.ORDER_BUMP=${JSON.stringify(config.order_bump||{active:false})};</script>`;
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${page.title}</title><script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script><script src="https://cdn.tailwindcss.com"></script><style>${page.css_content}</style>${scriptInject}</head><body>${page.html_content}</body></html>`);
}

// Fallback Asset
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export const onRequest = handle(app)
