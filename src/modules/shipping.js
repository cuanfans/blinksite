export const checkShipping = async (c) => {
    // Di sini nanti bisa integrasi RajaOngkir dengan pola yang sama seperti Payment Engine
    // (Simpan API Key di DB, Fetch ke API RajaOngkir)
    
    const { district } = await c.req.json();
    
    // Mock Logic Sederhana
    const mockPrice = 15000; // Flat rate contoh
    
    return c.json({ 
        success: true, 
        price: mockPrice, 
        courier: "JNE REG", 
        estimate: "2-3 Hari" 
    });
};
