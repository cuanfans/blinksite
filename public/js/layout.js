document.addEventListener('alpine:init', () => {
    Alpine.store('layout', {
        darkMode: localStorage.getItem('theme') === 'dark',
        sidebarOpen: true,
        pageTitle: document.title,
        
        toggleTheme() {
            this.darkMode = !this.darkMode;
            localStorage.setItem('theme', this.darkMode ? 'dark' : 'light');
            this.applyTheme();
        },

        applyTheme() {
            if (this.darkMode) document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');
        },

        logout() {
            if(confirm('Keluar dari Admin?')) {
                localStorage.removeItem('admin_pass');
                window.location.href = '/';
            }
        },

        init() {
            this.applyTheme();
        }
    });
});

class AdminLayout extends HTMLElement {
    connectedCallback() {
        // 1. AMBIL ELEMEN ASLI (Bukan Text HTML)
        // Kita pindahkan elemen anak ke dalam memori sementara (Fragment)
        // Ini menjamin konten tidak hilang saat layout dirender.
        const contentFragment = document.createDocumentFragment();
        while (this.firstChild) {
            contentFragment.appendChild(this.firstChild);
        }

        // 2. RENDER KERANGKA LAYOUT (Sidebar & Header)
        this.className = 'block h-full'; 
        
        // Helper link aktif
        const path = window.location.pathname;
        const isActive = (p) => path.includes(p) ? 'bg-blue-600 text-white shadow-md' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700';

        this.innerHTML = `
        <div x-data class="flex h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-sans overflow-hidden">
            
            <aside :class="$store.layout.sidebarOpen ? 'w-64 translate-x-0' : 'w-20 translate-x-0'" 
                class="bg-white dark:bg-gray-800 border-r dark:border-gray-700 flex flex-col transition-all duration-300 fixed md:relative z-30 h-full shadow-xl">
                
                <div class="h-16 flex items-center justify-center border-b dark:border-gray-700 shrink-0">
                    <span x-show="$store.layout.sidebarOpen" class="text-xl font-extrabold text-blue-600">LandingPro</span>
                    <span x-show="!$store.layout.sidebarOpen" class="text-xl font-bold text-blue-600">LP</span>
                </div>

                <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
                    <a href="/admin/dashboard" class="${isActive('dashboard')} flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group">
                        <i class="ph ph-squares-four text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium whitespace-nowrap">Dashboard</span>
                    </a>
                    <a href="/admin/pages" class="${isActive('pages')} flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group">
                        <i class="ph ph-files text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium whitespace-nowrap">Halaman</span>
                    </a>
                    <a href="/admin/reports" class="${isActive('reports')} flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group">
                        <i class="ph ph-chart-line-up text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium whitespace-nowrap">Laporan</span>
                    </a>
                    <a href="/admin/analytics" class="${isActive('analytics')} flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group">
                        <i class="ph ph-eye text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium whitespace-nowrap">Analytics</span>
                    </a>
                    <a href="/admin/settings" class="${isActive('settings')} flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group">
                        <i class="ph ph-gear text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium whitespace-nowrap">Settings</span>
                    </a>
                </nav>

                <div class="p-4 border-t dark:border-gray-700 shrink-0">
                    <button @click="$store.layout.logout()" class="flex items-center gap-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 w-full p-2 rounded transition justify-center md:justify-start">
                        <i class="ph ph-sign-out text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen" class="font-medium">Keluar</span>
                    </button>
                </div>
            </aside>

            <div class="flex-1 flex flex-col h-full overflow-hidden relative w-full">
                
                <header class="h-16 bg-white dark:bg-gray-800 border-b dark:border-gray-700 flex justify-between items-center px-6 shadow-sm z-20 shrink-0">
                    <div class="flex items-center gap-4">
                        <button @click="$store.layout.sidebarOpen = !$store.layout.sidebarOpen" class="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                            <i class="ph ph-list text-2xl"></i>
                        </button>
                        <h1 class="font-bold text-lg truncate" x-text="$store.layout.pageTitle"></h1>
                    </div>

                    <div class="flex items-center gap-3">
                        <a href="/admin/editor" class="hidden md:flex items-center gap-2 text-xs font-bold bg-blue-600 text-white px-4 py-2 rounded-full hover:bg-blue-700 transition shadow">
                            <i class="ph ph-plus"></i> Editor
                        </a>
                        <button @click="$store.layout.toggleTheme()" class="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 border dark:border-gray-600">
                            <i x-show="!$store.layout.darkMode" class="ph ph-moon text-xl"></i>
                            <i x-show="$store.layout.darkMode" class="ph ph-sun text-xl text-yellow-400"></i>
                        </button>
                    </div>
                </header>

                <main id="main-content-slot" class="flex-1 overflow-y-auto p-6 scroll-smooth">
                    </main>
            </div>
        </div>
        `;

        // 3. MASUKKAN KEMBALI KONTEN ASLI KE DALAM SLOT
        // Ini kuncinya: kita appendChild fragment yang tadi kita simpan
        this.querySelector('#main-content-slot').appendChild(contentFragment);
    }
}
customElements.define('admin-layout', AdminLayout);
