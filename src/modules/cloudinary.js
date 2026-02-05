import { decryptJSON, sha1 } from '../utils';

export const uploadImage = async (c) => {
    try {
        // Ambil Config Cloudinary dari DB (Terenkripsi)
        const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = 'cloudinary'").first();
        if (!credRow) return c.json({ success: false, message: "Cloudinary belum dikonfigurasi di settings." }, 500);

        const config = await decryptJSON(credRow.encrypted_data, credRow.iv, c.env.APP_MASTER_KEY);
        const { cloud_name, api_key, api_secret } = config;

        // Ambil Data Gambar Base64
        const { image, filename } = await c.req.json();
        if (!image) return c.json({ success: false, message: "Image data missing" }, 400);

        // Buat Signature
        const timestamp = Math.round(new Date().getTime() / 1000).toString();
        const paramsToSign = `format=webp&public_id=${filename}&timestamp=${timestamp}${api_secret}`;
        const signature = await sha1(paramsToSign);

        // Upload ke Cloudinary
        const formData = new FormData();
        formData.append('file', image);
        formData.append('api_key', api_key);
        formData.append('timestamp', timestamp);
        formData.append('public_id', filename);
        formData.append('format', 'webp');
        formData.append('signature', signature);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`, {
            method: 'POST', body: formData
        });
        const json = await res.json();

        if (json.secure_url) {
            return c.json({ success: true, url: json.secure_url });
        } else {
            throw new Error(json.error?.message || "Cloudinary Upload Failed");
        }
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
};
