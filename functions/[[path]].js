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

// Save Page (Simpan JSON Produk, Varian, Bump)
app.post('/api/admin/pages', async (c) => {
    const { slug, title, html, css, product_config } = await c.req.json();
    try {
        await c.env.DB.prepare(
            `INSERT INTO pages (slug, title, html_content, css_content, product_config_json) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET 
             title=excluded.title, html_content=excluded.html_content, css_content=excluded.css_content, product_config_json=excluded.product_config_json`
        ).bind(slug, title, html, css, JSON.stringify(product_config)).run();
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
        const page = await c.env.DB.prepare("SELECT product_config_json FROM pages WHERE id=?").bind(page_id).first();
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

        // 5. Eksekusi ke Payment Engine
        const result = await executePayment(c, provider, finalPrice);
        
        return c.json(result);

    } catch(e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});


// ===============================================
// 4. RENDERER (Landing Page & Admin)
// ===============================================

// Placeholder Admin Route (Frontend Admin menyusul di file terpisah)
// FIX: Melayani file statis admin.html yang ada di folder public
app.get('/admin', async (c) => {
  return await c.env.ASSETS.fetch(new URL('/admin.html', c.req.url))
})

// Redirect halaman utama ke admin
app.get('/', (c) => c.redirect('/admin'))

// Render Landing Page
app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(slug).first();
    
    if(!page) return c.text('404 Not Found', 404);

    const config = JSON.parse(page.product_config_json || '{}');
    
    // Inject Global Variables untuk AlpineJS
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
});

export const onRequest = handle(app);
