import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { sha256, encryptJSON } from '../src/utils'
import { executePayment } from '../src/engine'
import { uploadImage } from '../src/modules/cloudinary'
import { checkShipping } from '../src/modules/shipping'

const app = new Hono()

// ===============================================
// 0. GLOBAL ERROR LOGGING & HELPERS
// ===============================================

// Middleware: Log setiap request masuk
app.use('*', async (c, next) => {
    console.log(`[REQ] ${c.req.method} ${c.req.url}`);
    await next();
});

// Global Error Handler (Menangkap Error 500 yang tidak terduga)
app.onError((err, c) => {
    console.error(`[FATAL ERROR] ${c.req.method} ${c.req.url}`);
    console.error(err.stack || err); // Tampilkan Stack Trace lengkap
    return c.json({ 
        success: false, 
        message: 'Internal Server Error', 
        debug_error: err.message 
    }, 500);
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

// Helper: Fetch Asset dengan Error Logging
async function safeAssetFetch(c, assetPath) {
    try {
        const target = assetPath ? new URL(assetPath, c.req.url) : c.req.raw;
        return await c.env.ASSETS.fetch(target);
    } catch (e) {
        console.error(`[ASSET ERROR] Gagal fetch: ${assetPath || c.req.url}`, e);
        return c.text('Asset Not Found', 404);
    }
}

// ===============================================
// 1. AUTH & SECURITY
// ===============================================

// Middleware Auth untuk Halaman Admin HTML
app.use(['/admin', '/admin/*'], async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    
    // Whitelist halaman login
    if (pathname === '/admin/login' || pathname === '/admin/login.html') {
        await next();
        return;
    }

    // Cek Auth (Header atau Cookie)
    const inputPass = c.req.header('Authorization') || getCookieFromHeader(c.req, 'admin_pass');
    
    if (!inputPass) {
        console.warn(`[AUTH FAIL] Akses tanpa password ke ${pathname}`);
        return c.redirect('/admin/login.html');
    }

    // Cek ke DB
    try {
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const realHash = dbSetting ? dbSetting.value : '';
        const inputHash = await sha256(inputPass);

        if (inputHash !== realHash) {
            console.warn(`[AUTH FAIL] Password salah dari IP: ${c.req.header('CF-Connecting-IP')}`);
            return c.redirect('/admin/login.html');
        }
    } catch (e) {
        console.error("[DB ERROR] Gagal cek password di DB", e);
        return c.text("Database Error saat Auth", 500);
    }

    await next();
});

// ===============================================
// 2. STATIC ASSETS & HTML ROUTES
// ===============================================

// Asset Statis (JS/CSS/Img)
app.get('/js/*', async (c) => await safeAssetFetch(c, null));
app.get('/css/*', async (c) => await safeAssetFetch(c, null));
app.get('/images/*', async (c) => await safeAssetFetch(c, null));
app.get('/favicon.ico', async (c) => {
    try { return await c.env.ASSETS.fetch(new URL('/favicon.ico', c.req.url)); }
    catch(e) { return c.text('', 204); }
});

// Admin Routes (Explicit Mapping)
app.get('/admin', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/login', async (c) => await safeAssetFetch(c, '/admin/login.html'));
app.get('/admin/login.html', async (c) => await safeAssetFetch(c, '/admin/login.html'));
app.get('/admin/dashboard', async (c) => await safeAssetFetch(c, '/admin/dashboard.html'));
app.get('/admin/pages', async (c) => await safeAssetFetch(c, '/admin/pages.html'));
app.get('/admin/editor', async (c) => await safeAssetFetch(c, '/admin/editor.html'));
app.get('/admin/reports', async (c) => await safeAssetFetch(c, '/admin/reports.html'));
app.get('/admin/analytics', async (c) => await safeAssetFetch(c, '/admin/analytics.html'));
app.get('/admin/settings', async (c) => await safeAssetFetch(c, '/admin/settings.html'));

// ===============================================
// 3. API AUTH MIDDLEWARE
// ===============================================
app.use('/api/admin/*', async (c, next) => {
    const inputPass = c.req.header('Authorization');
    if(!inputPass) return c.json({error: 'Unauthorized - Header Missing'}, 401);

    try {
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const inputHash = await sha256(inputPass);
        if (inputHash !== (dbSetting?.value || '')) return c.json({error: 'Password Salah'}, 401);
    } catch (e) {
        console.error("[API AUTH ERROR]", e);
        return c.json({error: 'Database Error'}, 500);
    }
    await next();
})

// ===============================================
// 4. API ROUTES (DENGAN LOGGING LENGKAP)
// ===============================================

// Login Check
app.post('/api/login', async (c) => {
    try {
        const { password } = await c.req.json();
        const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
        const inputHash = await sha256(password);
        return c.json({ success: inputHash === dbSetting.value });
    } catch (e) {
        console.error("[LOGIN API ERROR]", e);
        return c.json({ success: false, error: e.message }, 500);
    }
})

// Save Page
app.post('/api/admin/pages', async (c) => {
    try {
        const body = await c.req.json();
        console.log("[SAVE PAGE] Saving slug:", body.slug); // Log aktivitas

        await c.env.DB.prepare(
            `INSERT INTO pages (slug, title, html_content, css_content, product_config_json, product_type) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET 
             title=excluded.title, html_content=excluded.html_content, css_content=excluded.css_content, product_config_json=excluded.product_config_json, product_type=excluded.product_type`
        ).bind(body.slug, body.title, body.html, body.css, JSON.stringify(body.product_config), body.product_type || 'physical').run();
        
        return c.json({ success: true });
    } catch(e) { 
        console.error("[SAVE PAGE ERROR]", e);
        return c.json({ error: e.message }, 500); 
    }
});

// Get Page Data
app.get('/api/admin/pages/:slug', async (c) => {
    try {
        const slug = c.req.param('slug');
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
        if(page) page.product_config_json = JSON.parse(page.product_config_json || '{}');
        return c.json(page || {});
    } catch (e) {
        console.error("[GET PAGE ERROR]", e);
        return c.json({}, 500);
    }
});

// Set Homepage
app.post('/api/admin/set-homepage', async (c) => {
    try {
        const { slug } = await c.req.json();
        await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('homepage_slug', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(slug).run();
        return c.json({ success: true });
    } catch (e) {
        console.error("[SET HOMEPAGE ERROR]", e);
        return c.json({ error: e.message }, 500);
    }
});

// API Dashboard Stats
app.get('/api/admin/analytics-data', async (c) => {
    try {
        const visitors = await c.env.DB.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type='view'").first().catch(e => {
            console.error("Visitor DB Error:", e); return {c:0};
        });
        const sales = await c.env.DB.prepare("SELECT SUM(amount) as s FROM transactions WHERE status='settlement'").first().catch(e => {
            console.error("Sales DB Error:", e); return {s:0};
        });
        
        return c.json({
            visitors: visitors.c || 0,
            revenue: sales.s || 0,
            conversion: visitors.c > 0 ? ((sales.s > 0 ? 1 : 0) / visitors.c * 100).toFixed(1) : 0
        });
    } catch (e) {
        console.error("[ANALYTICS ERROR]", e);
        return c.json({ visitors: 0, revenue: 0, conversion: 0 });
    }
});

// Save Credential
app.post('/api/admin/credentials', async (c) => {
    try {
        const { provider, data } = await c.req.json();
        const { encrypted, iv } = await encryptJSON(data, c.env.APP_MASTER_KEY);
        await c.env.DB.prepare(
            `INSERT INTO credentials (provider_slug, encrypted_data, iv) VALUES (?, ?, ?)
             ON CONFLICT(provider_slug) DO UPDATE SET encrypted_data=excluded.encrypted_data, iv=excluded.iv`
        ).bind(provider, encrypted, iv).run();
        return c.json({ success: true });
    } catch (e) {
        console.error("[SAVE CREDENTIALS ERROR]", e);
        return c.json({ error: e.message }, 500);
    }
});

app.post('/api/admin/upload-image', async (c) => {
    try {
        return await uploadImage(c);
    } catch (e) {
        console.error("[UPLOAD IMAGE ERROR]", e);
        return c.json({ success: false, message: e.message }, 500);
    }
});

// ===============================================
// 5. PUBLIC API ROUTES
// ===============================================

app.post('/api/shipping/check', async (c) => {
    try { return await checkShipping(c); }
    catch(e) { console.error("Shipping Error", e); return c.json({error:e.message}, 500); }
});

app.post('/api/check-coupon', async (c) => {
    try {
        const { page_id, code } = await c.req.json();
        const page = await c.env.DB.prepare("SELECT product_config_json FROM pages WHERE id=?").bind(page_id).first();
        if (!page) return c.json({ success: false, message: "Halaman tidak ditemukan" });

        const config = JSON.parse(page.product_config_json || '{}');
        const valid = (config.coupons || []).find(cp => cp.code === code.toUpperCase());
        
        if(valid) return c.json({ success: true, type: valid.type, value: valid.value, message: "Kupon OK" });
        return c.json({ success: false, message: "Kode Invalid" });
    } catch (e) {
        console.error("[COUPON ERROR]", e);
        return c.json({ success: false, message: "Server Error" }, 500);
    }
});

// CHECKOUT LOGIC
app.post('/api/checkout', async (c) => {
    try {
        const body = await c.req.json();
        const { page_id, provider, variant_id, coupon_code, with_bump, customer } = body;
        
        console.log(`[CHECKOUT START] Page: ${page_id}, Provider: ${provider}, Cust: ${customer?.name}`);

        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(page_id).first();
        if(!page) throw new Error("Halaman tidak ditemukan di DB");
        
        const config = JSON.parse(page.product_config_json || '{}');
        const selectedVariant = (config.variants || []).find(v => v.id == variant_id);
        if(!selectedVariant) throw new Error("Varian Produk tidak valid");
        
        let finalPrice = selectedVariant.price;
        
        // Hitung Bump
        if (with_bump && config.order_bump?.active) {
            finalPrice += parseFloat(config.order_bump.price);
        }

        // Hitung Kupon
        if (coupon_code) {
            const cp = (config.coupons || []).find(c => c.code === coupon_code.toUpperCase());
            if (cp) {
                if (cp.type === 'percent') {
                    finalPrice -= Math.round(finalPrice * cp.value / 100);
                } else {
                    finalPrice -= parseFloat(cp.value);
                }
            }
        }
        if(finalPrice < 0) finalPrice = 0;

        const orderId = `TRX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const customerData = JSON.stringify({ 
            ...customer, 
            item: selectedVariant.name, 
            coupon: coupon_code,
            bump: with_bump ? 'Yes' : 'No' 
        });

        // Simpan Transaksi
        await c.env.DB.prepare(
            `INSERT INTO transactions (page_id, order_id, provider, amount, status, customer_info) VALUES (?, ?, ?, ?, 'pending', ?)`
        ).bind(page_id, orderId, provider, finalPrice, customerData).run();

        // Eksekusi Payment Gateway
        const result = await executePayment(c, provider, finalPrice, orderId);
        return c.json(result);

    } catch(e) { 
        console.error("[CHECKOUT FATAL ERROR]", e);
        return c.json({ success: false, message: e.message || "Gagal memproses checkout" }, 500); 
    }
});

// ===============================================
// 6. PUBLIC HTML SERVING
// ===============================================

app.get('/', async (c) => {
    try {
        // Cek Homepage Setting
        const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
        if (s && s.value) {
            const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(s.value).first();
            if (page) return renderPage(c, page);
        }
    } catch (e) {
        console.error("[HOMEPAGE ERROR]", e);
    }
    // Default fallback
    return await safeAssetFetch(c, '/index.html');
})

app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (slug.includes('.')) return await safeAssetFetch(c, null);

    try {
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
        if(!page) {
            console.warn(`[404] Page slug not found: ${slug}`);
            return c.text('404 Not Found', 404);
        }

        // Track Visit (Fire & Forget)
        c.env.DB.prepare("INSERT INTO analytics (page_id, event_type, referrer) VALUES (?, 'view', ?)").bind(page.id, c.req.header('Referer') || 'direct').run().catch(err => console.error("Analytics Error", err));
        
        return renderPage(c, page);
    } catch (e) {
        console.error(`[RENDER ERROR] Slug: ${slug}`, e);
        return c.text('Error Rendering Page', 500);
    }
});

function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const scriptInject = `<script>window.PAGE_ID=${page.id};window.PRODUCT_VARIANTS=${JSON.stringify(config.variants||[])};window.ORDER_BUMP=${JSON.stringify(config.order_bump||{active:false})};</script>`;
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${page.title}</title><script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script><script src="https://cdn.tailwindcss.com"></script><style>${page.css_content}</style>${scriptInject}</head><body>${page.html_content}</body></html>`);
}

export const onRequest = handle(app)
