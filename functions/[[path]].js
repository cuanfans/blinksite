import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { sha256, encryptJSON } from '../src/utils'
import { executePayment } from '../src/engine'
import { uploadImage } from '../src/modules/cloudinary'
import { checkShipping } from '../src/modules/shipping'

const app = new Hono()

// ===============================================
// 1. MIDDLEWARE & AUTH
// ===============================================
app.use('/api/admin/*', async (c, next) => {
    const inputPass = c.req.header('Authorization');
    if(!inputPass) return c.json({error: 'Unauthorized'}, 401);

    // Ambil password hash dari DB
    const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
    const realHash = dbSetting ? dbSetting.value : '';
    const inputHash = await sha256(inputPass);
    
    if (inputHash !== realHash) return c.json({error: 'Password Salah'}, 401);
    await next();
})

// ===============================================
// 2. ADMIN API ROUTES (Protected)
// ===============================================

// Login Check
app.post('/api/login', async (c) => {
    const { password } = await c.req.json();
    const dbSetting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
    const inputHash = await sha256(password);
    return c.json({ success: inputHash === dbSetting.value });
})

// Ganti Password
app.post('/api/admin/change-password', async (c) => {
    const { new_password } = await c.req.json();
    const newHash = await sha256(new_password);
    await c.env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").bind(newHash).run();
    return c.json({ success: true });
})

// Save Credential (Enkripsi Config Payment/Cloudinary)
app.post('/api/admin/credentials', async (c) => {
    const { provider, data } = await c.req.json(); // data: JSON Object key asli
    const { encrypted, iv } = await encryptJSON(data, c.env.APP_MASTER_KEY);
    
    await c.env.DB.prepare(
        `INSERT INTO credentials (provider_slug, encrypted_data, iv) VALUES (?, ?, ?)
         ON CONFLICT(provider_slug) DO UPDATE SET encrypted_data=excluded.encrypted_data, iv=excluded.iv`
    ).bind(provider, encrypted, iv).run();
    
    return c.json({ success: true });
});

// Save Page (Simpan HTML, CSS, Config Produk)
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

// Get Page Data (Untuk di-load di Editor)
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

// Get Homepage Setting
app.get('/api/admin/get-homepage', async (c) => {
    const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
    return c.json({ slug: s ? s.value : '' });
});

// API: Analytics Stats (Mockup/Real Data)
app.get('/api/admin/analytics-data', async (c) => {
    try {
        // Ambil data real jika tabel analytics & transactions sudah terisi
        // Jika tabel belum ada, gunakan fallback 0 agar tidak error 500
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

// Upload Image (Cloudinary Module)
app.post('/api/admin/upload-image', uploadImage);


// ===============================================
// 3. PUBLIC API ROUTES (Widget Interactions)
// ===============================================

// Cek Ongkir Module
app.post('/api/shipping/check', checkShipping);

// Cek Kupon (Interaktif)
app.post('/api/check-coupon', async (c) => {
    const { page_id, code } = await c.req.json();
    
    const page = await c.env.DB.prepare("SELECT product_config_json FROM pages WHERE id=?").bind(page_id).first();
    const config = JSON.parse(page.product_config_json || '{}');
    const coupons = config.coupons || [];

    const valid = coupons.find(cp => cp.code === code.toUpperCase());
    
    if(valid) {
        return c.json({ success: true, type: valid.type, value: valid.value, message: "Kupon Diterapkan!" });
    } else {
        return c.json({ success: false, message: "Kode Tidak Valid" });
    }
});

// CHECKOUT (The Core Transaction Logic)
app.post('/api/checkout', async (c) => {
    try {
        const { page_id, provider, variant_id, coupon_code, with_bump, customer } = await c.req.json();

        // 1. Ambil Config Halaman dari DB (Security Source)
        const page = await c.env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(page_id).first();
        if(!page) throw new Error("Halaman tidak ditemukan");
        
        const config = JSON.parse(page.product_config_json || '{}');

        // 2. Tentukan Harga Dasar (Varian)
        const selectedVariant = (config.variants || []).find(v => v.id == variant_id);
        if(!selectedVariant) throw new Error("Varian produk tidak valid");
        
        let finalPrice = selectedVariant.price;

        // 3. Tambah Order Bump (Jika dicentang)
        if (with_bump && config.order_bump && config.order_bump.active) {
            finalPrice += config.order_bump.price;
        }

        // 4. Kurangi Diskon Kupon
        if (coupon_code) {
            const validCoupon = (config.coupons || []).find(cp => cp.code === coupon_code.toUpperCase());
            if (validCoupon) {
                if (validCoupon.type === 'percent') {
                    finalPrice -= Math.round(finalPrice * validCoupon.value / 100);
                } else if (validCoupon.type === 'fixed') {
                    finalPrice -= validCoupon.value;
                }
            }
        }
        
        if(finalPrice < 0) finalPrice = 0;

        // 5. Simpan Transaksi (Pending)
        const orderId = `TRX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const customerData = JSON.stringify({
            ...customer,
            item: selectedVariant.name + (with_bump ? " + Bump" : ""),
            coupon: coupon_code
        });

        // Insert ke tabel transactions (pastikan tabel ini ada di schema.sql)
        await c.env.DB.prepare(
            `INSERT INTO transactions (page_id, order_id, provider, amount, status, customer_info) 
             VALUES (?, ?, ?, ?, 'pending', ?)`
        ).bind(page_id, orderId, provider, finalPrice, customerData).run();

        // 6. Eksekusi ke Payment Engine
        // (Engine perlu dimodifikasi sedikit agar menerima customOrderId jika ingin sinkron)
        // Disini kita asumsikan executePayment sudah support atau generate ID baru (tidak fatal)
        const result = await executePayment(c, provider, finalPrice, orderId);
        
        return c.json(result);

    } catch(e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});


// ===============================================
// 4. ADMIN ROUTES MAPPER (HTML Serving)
// ===============================================

// Melayani file HTML statis dari folder public/admin/
app.get('/admin', (c) => c.redirect('/admin/dashboard')); // Redirect root admin ke dashboard
app.get('/admin/dashboard', (c) => c.env.ASSETS.fetch(new URL('/admin/dashboard.html', c.req.url)));
app.get('/admin/pages', (c) => c.env.ASSETS.fetch(new URL('/admin/pages.html', c.req.url)));
app.get('/admin/editor', (c) => c.env.ASSETS.fetch(new URL('/admin/editor.html', c.req.url))); 
app.get('/admin/reports', (c) => c.env.ASSETS.fetch(new URL('/admin/reports.html', c.req.url)));
app.get('/admin/analytics', (c) => c.env.ASSETS.fetch(new URL('/admin/analytics.html', c.req.url)));
app.get('/admin/settings', (c) => c.env.ASSETS.fetch(new URL('/admin/settings.html', c.req.url)));

// ===============================================
// FIX: STATIC ASSETS ROUTING (PENTING!)
// ===============================================

// Biarkan Cloudflare mengambil file JS, CSS, atau Gambar dari folder public
app.get('/js/*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/css/*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/images/*', (c) => c.env.ASSETS.fetch(c.req.raw));
// ===============================================
// 5. PUBLIC ROUTER & RENDERER
// ===============================================

// Logic Homepage (Root URL)
app.get('/', async (c) => {
    try {
        // 1. Cek apakah Admin sudah set Homepage di Database
        const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first();
        
        // 2. Jika ada settingan slug, coba ambil halaman tersebut
        if (s && s.value) {
            const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug = ?").bind(s.value).first();
            
            // 3. Jika halaman ketemu, Render Halamannya
            if (page) return renderPage(c, page);
        }
    } catch (e) {
        console.log('DB Error or No Homepage set');
    }

    // 4. FALLBACK WAJIB: Tampilkan index.html (Halaman Landing SaaS)
    return c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
})

// Logic Dynamic Pages (slug)
app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    
    // Abaikan request aset statis (js, css, png) agar tidak query DB
    if (slug.includes('.')) return c.env.ASSETS.fetch(c.req.raw);

    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
    
    if(!page) return c.text('404 Not Found', 404);

    // Track View (Analytics Simple)
    // Jalankan async tanpa await agar tidak memperlambat loading
    c.env.DB.prepare("INSERT INTO analytics (page_id, event_type, referrer) VALUES (?, 'view', ?)")
        .bind(page.id, c.req.header('Referer') || 'direct').run().catch(()=>{});

    return renderPage(c, page);
});

// ==========================================
// HELPER RENDER
// ==========================================
function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const scriptInject = `
        <script>
            window.PAGE_ID = ${page.id};
            window.PRODUCT_VARIANTS = ${JSON.stringify(config.variants || [])};
            window.ORDER_BUMP = ${JSON.stringify(config.order_bump || {active:false})};
        </script>
    `;

    return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${page.title}</title>
            <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>${page.css_content}</style>
            ${scriptInject}
        </head>
        <body>
            ${page.html_content}
        </body>
        </html>
    `);
}

export const onRequest = handle(app)
