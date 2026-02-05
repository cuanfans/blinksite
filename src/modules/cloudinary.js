import { decryptJSON, sha1 } from '../utils';

export const uploadImage = async (c) => {
    try {
        // 1. Ambil Config Cloudinary
        const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = 'cloudinary'").first();
        if (!credRow) return c.json({ success: false, message: "API Cloudinary belum disetting di menu Settings." }, 400);

        // 2. Dekripsi
        const config = await decryptJSON(credRow.encrypted_data, credRow.iv, c.env.APP_MASTER_KEY);
        if (!config || !config.cloud_name || !config.api_key) {
            return c.json({ success: false, message: "Kredensial Cloudinary rusak/salah. Silakan simpan ulang di Settings." }, 400);
        }

        const { cloud_name, api_key, api_secret } = config;

        // 3. Ambil File
        const body = await c.req.parseBody();
        const file = body['file']; // Key dari GrapesJS

        if (!file || !(file instanceof File)) {
            return c.json({ success: false, message: "File tidak ditemukan" }, 400);
        }

        // 4. Upload Logic
        const timestamp = Math.round(new Date().getTime() / 1000).toString();
        // Gunakan 'unsigned' upload jika signature ribet, tapi di sini kita coba signed
        const paramsToSign = `timestamp=${timestamp}${api_secret}`;
        const signature = await sha1(paramsToSign);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('api_key', api_key);
        formData.append('timestamp', timestamp);
        formData.append('signature', signature);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`, {
            method: 'POST', body: formData
        });
        
        const json = await res.json();

        if (json.secure_url) {
            // Format Response Khusus GrapesJS Asset Manager
            return c.json({ 
                data: [{ src: json.secure_url, type: 'image' }] 
            });
        } else {
            throw new Error(json.error?.message || "Upload Failed");
        }

    } catch (e) {
        console.error("Upload Error:", e);
        return c.json({ success: false, message: e.message }, 500);
    }
};
