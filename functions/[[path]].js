import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { sha256, encryptJSON } from '../src/utils'
import { executePayment } from '../src/engine'
import { uploadImage } from '../src/modules/cloudinary'
import { checkShipping } from '../src/modules/shipping'

const app = new Hono()

// ===============================================
// 0. GLOBAL CONFIG & HELPERS
// ===============================================

// Middleware: Log Request
app.use('*', async (c, next) => {
    // eslint-disable-next-line no-console
    console.log(`[${c.req.method}] ${c.req.url}`);
    await next();
});

// Error Handler
app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${err.message}`, err.stack);
    return c.json({ success: false, message: 'Internal Server Error', debug: err.message }, 500);
});

// Helper: Baca cookie
function getCookieFromHeader(req, name) {
    const cookieHeader = req.header ? req.header('Cookie') : null;
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const c of cookies) {
        const [k, ...v] = c.split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

// Helper: Fetch Asset (Aman dari error 404/500 internal worker)
async function serveAsset(c, path) {
    try {
        const url = new URL(path, c.req.url);
        return await c.env.ASSETS.fetch(url);
    } catch (e) {
        return c.text('Asset Not Found', 404);
    }
}

// ===============================================
// 1. AUTH MIDDLEWARE (Hanya untuk /api/admin/*)
// ===============================================
app.use('/api/admin/*', async (c, next) => {
    const inputPass = c.req.header('Authorization');
    if(!inputPass) return c.json({error: 'Unauthorized'}, 401);

    try {
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const realHash = dbSetting ? dbSetting.value : '';
        const inputHash = await sha256(inputPass);
        
        if (inputHash !== realHash) return c.json({error: 'Password Salah'}, 401);
    } catch (e) {
        return c.json({error: 'Database Error'}, 500);
    }
    await next();
})

// ===============================================
// 2. EXPLICIT HTML ROUTES (PRIORITAS TINGGI)
// ===============================================

// A. Halaman Login (PENTING: Di-mapping ke /login.html di root)
app.get('/login', (c) => serveAsset(c, '/login.html'));
app.get('/login.html', (c) => serveAsset(c, '/login.html'));
app.get('/admin/login', (c) => serveAsset(c, '/login.html')); // Alias

// B. Halaman Admin (Protected Logic di Client-side via layout.js, tapi kita redirect root admin)
app.get('/admin', (c) => c.redirect('/admin/dashboard'));

// C. Admin Pages Mapping
app.get('/admin/dashboard', (c) => serveAsset(c, '/admin/dashboard.html'));
app.get('/admin/pages', (c) => serveAsset(c, '/admin/pages.html'));
app.get('/admin/editor', (c) => serveAsset(c, '/admin/editor.html'));
app.get('/admin/reports', (c) => serveAsset(c, '/admin/reports.html'));
app.get('/admin/analytics', (c) => serveAsset(c, '/admin/analytics.html'));
app.get('/admin/settings', (c) => serveAsset(c, '/admin/settings.html'));

// ===============================================
// 3. API ROUTES
// ===============================================

// Login Check
app.post('/api/login', async (c) => {
    try {
        const { password } = await c.req.json();
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const inputHash = await sha256(password);
        return c.json({ success: inputHash === dbSetting.value });
    } catch (e) {
        return c.json({ success: false, error: e.message }, 500);
    }
})

// Save Page
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

// Get Page Data
app.get('/api/admin/pages/:slug', async (c) => {
    const slug = c.req.param('slug');
    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
    if(page) page.product_config_json = JSON.parse(page.product_config_json || '{}');
    return c.json(page || {});
});

// Set Homepage
app.post('/api/admin/set-homepage', async (c) => {
    const { slug } = await c.req.json();
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('homepage_slug', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(slug).run();
    return c.json({ success: true });
});

// Dashboard Stats
app.get('/api/admin/analytics-data', async (c) => {
    try {
        const visitors = await c.env.DB.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='view'").first().catch(() => ({c:0}));
        const sales = await c.env.DB.prepare("SELECT SUM(amount) as s FROM transactions WHERE status='settlement'").first().catch(() => ({s:0}));
        return c.json({
            visitors: visitors.c || 0,
            revenue: sales.s || 0,
            conversion: visitors.c > 0 ? ((sales.s > 0 ? 1 : 0) / visitors.c * 100).toFixed(1) : 0
        });
    } catch (e) {
        return c.json({ visitors: 0, revenue: 0, conversion: 0 });
    }
});

// Credentials & Upload
app.post('/api/admin/credentials', async (c) => {
    const { provider, data } = await c.req.json();
    const { encrypted, iv } = await encryptJSON(data, c.env.APP_MASTER_KEY);
    await c.env.DB.prepare(
        `INSERT INTO credentials (provider_slug, encrypted_data, iv) VALUES (?, ?, ?)
         ON CONFLICT(provider_slug) DO UPDATE SET encrypted_data=excluded.encrypted_data, iv=excluded.iv`
    ).bind(provider, encrypted, iv).run();
    return c.json({ success: true });
});

app.post('/api/admin/upload-image', uploadImage);

// Public API
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

// ===============================================
// 4. PUBLIC & DYNAMIC ROUTES (LOW PRIORITY)
// ===============================================

// A. Homepage
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

// B. Dynamic Slug (Landing Pages)
app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    
    // PENTING: Jika slug mengandung titik (misal: main.js, style.css),
    // jangan anggap ini halaman, tapi langsung lempar ke Asset Fetcher.
    if (slug.includes('.')) {
        return c.env.ASSETS.fetch(c.req.raw);
    }

    try {
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
        if(!page) return c.text('404 Not Found', 404);

        // Track Visit
        c.env.DB.prepare("INSERT INTO analytics (page_id, event_type, referrer) VALUES (?, 'view', ?)").bind(page.id, c.req.header('Referer') || 'direct').run().catch(()=>{});
        
        return renderPage(c, page);
    } catch(e) {
        // Fallback jika DB error atau apapun, coba cari di aset static
        return c.env.ASSETS.fetch(c.req.raw);
    }
});

// Helper Render
function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const scriptInject = `<script>window.PAGE_ID=${page.id};window.PRODUCT_VARIANTS=${JSON.stringify(config.variants||[])};window.ORDER_BUMP=${JSON.stringify(config.order_bump||{active:false})};</script>`;
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${page.title}</title><script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script><script src="https://cdn.tailwindcss.com"></script><style>${page.css_content}</style>${scriptInject}</head><body>${page.html_content}</body></html>`);
}

// ===============================================
// 5. CATCH-ALL STATIC ASSETS (WAJIB ADA)
// ===============================================
// Menangani request CSS, JS, Image, dan file statis lainnya 
// yang tidak tertangkap oleh route di atas.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export const onRequest = handle(app)
