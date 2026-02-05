import { decryptJSON, sha1 } from '../utils';

export const uploadImage = async (c) => {
    try {
        // 1. Ambil Config Cloudinary dari DB
        const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = 'cloudinary'").first();
        if (!credRow) return c.json({ success: false, message: "Cloudinary belum dikonfigurasi di settings." }, 500);

        const config = await decryptJSON(credRow.encrypted_data, credRow.iv, c.env.APP_MASTER_KEY);
        if (!config || !config.cloud_name || !config.api_key) {
            return c.json({ success: false, message: "Kredensial Cloudinary rusak/salah." }, 400);
        }

        const { cloud_name, api_key, api_secret } = config;

        // 2. TERIMA DATA SEBAGAI JSON (BASE64 STRATEGY)
        // GrapesJS Custom Uploader akan mengirim JSON body: { image: "data:image/...", filename: "..." }
        const { image, filename } = await c.req.json();

        if (!image) {
            return c.json({ success: false, message: "Image data (Base64) missing" }, 400);
        }

        // 3. Buat Signature Cloudinary
        // Kita gunakan timestamp dan public_id (filename tanpa ekstensi) untuk secure upload
        const publicId = filename ? filename.split('.').slice(0, -1).join('.') : `img-${Date.now()}`;
        const timestamp = Math.round(new Date().getTime() / 1000).toString();
        
        // Parameter yang di-sign harus urut abjad!
        const paramsToSign = `format=webp&public_id=${publicId}&timestamp=${timestamp}${api_secret}`;
        const signature = await sha1(paramsToSign);

        // 4. Kirim ke Cloudinary
        const formData = new FormData();
        formData.append('file', image); // Cloudinary otomatis mendeteksi string Base64
        formData.append('api_key', api_key);
        formData.append('timestamp', timestamp);
        formData.append('public_id', publicId);
        formData.append('format', 'webp'); // Konversi otomatis ke WebP agar ringan
        formData.append('signature', signature);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`, {
            method: 'POST', 
            body: formData
        });
        
        const json = await res.json();

        if (json.secure_url) {
            // Format return khusus agar GrapesJS Asset Manager mengerti
            // GrapesJS mengharapkan: { data: [ { src: 'url' } ] }
            return c.json({ 
                data: [{ 
                    src: json.secure_url, 
                    type: 'image',
                    height: json.height,
                    width: json.width
                }] 
            });
        } else {
            throw new Error(json.error?.message || "Cloudinary Upload Failed");
        }

    } catch (e) {
        console.error("Upload Error:", e);
        return c.json({ success: false, message: "Upload Error: " + e.message }, 500);
    }
};
