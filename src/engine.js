import { decryptJSON } from './utils';

export async function executePayment(c, providerSlug, amount) {
    // 1. Ambil Template Resep API
    const template = await c.env.DB.prepare("SELECT * FROM payment_templates WHERE slug = ?").bind(providerSlug).first();
    if (!template) throw new Error(`Template pembayaran '${providerSlug}' tidak ditemukan.`);

    // 2. Ambil Kredensial User dari DB
    const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = ?").bind(providerSlug).first();
    if (!credRow) throw new Error(`Konfigurasi kredensial untuk '${providerSlug}' belum diatur.`);

    // 3. Dekripsi Kredensial
    const creds = await decryptJSON(credRow.encrypted_data, credRow.iv, c.env.APP_MASTER_KEY);
    if (!creds) throw new Error("Gagal mendekripsi kredensial API.");

    // 4. Siapkan Context Variable (Isian untuk Template)
    const context = {
        order_id: `TRX-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        amount: parseInt(amount),
        ...creds, // server_key, client_key, dll masuk ke sini
        auth_token: creds.server_key ? btoa(creds.server_key + ':') : '' // Helper khusus Midtrans
    };

    // 5. Fungsi Hydrate (Ganti {{var}} dengan data asli)
    const replaceVars = (str) => str.replace(/{{(.*?)}}/g, (_, key) => context[key.trim()] || '');

    // Hydrate Headers
    const headersRaw = JSON.parse(template.headers_json);
    const headers = {};
    for (const k in headersRaw) headers[k] = replaceVars(headersRaw[k]);

    // Hydrate Body
    let bodyString = replaceVars(template.body_json);

    // 6. Eksekusi FETCH ke API Gateway
    console.log(`[PaymentEngine] Sending to ${template.api_endpoint}`);
    
    const res = await fetch(template.api_endpoint, {
        method: template.method,
        headers: headers,
        body: bodyString
    });

    const json = await res.json();

    // 7. Normalisasi Response (Agar Frontend seragam)
    if (providerSlug === 'midtrans') {
        return {
            success: true,
            type: 'popup', // Sinyal ke frontend buat buka Snap.js
            token: json.token, 
            redirect_url: json.redirect_url
        };
    }
    
    // Default response (Redirect atau Raw)
    return { success: true, type: 'raw', data: json };
}
