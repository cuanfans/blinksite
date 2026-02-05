// public/js/layout.js

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
            localStorage.removeItem('admin_pass');
            window.location.href = '/';
        },

        init() {
            this.applyTheme();
            // Auth Check Sederhana
            if(!localStorage.getItem('admin_pass') && !window.location.pathname.includes('login')) {
                window.location.href = '/';
            }
        }
    });
});

// Komponen Sidebar & Layout Injeksi
class AdminLayout extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
        <div x-data class="flex h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 transition-colors duration-300">
            
            <aside :class="$store.layout.sidebarOpen ? 'w-64' : 'w-20'" class="bg-white dark:bg-gray-800 border-r dark:border-gray-700 flex flex-col transition-all duration-300 fixed h-full z-20 shadow-lg">
                <div class="h-16 flex items-center justify-center border-b dark:border-gray-700">
                    <span x-show="$store.layout.sidebarOpen" class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">LandingPro</span>
                    <span x-show="!$store.layout.sidebarOpen" class="text-xl font-bold">LP</span>
                </div>

                <nav class="flex-1 px-4 py-6 space-y-2">
                    ${this.navLink('/admin/dashboard', 'Dashboard', 'squares-four')}
                    ${this.navLink('/admin/pages', 'Pages Management', 'files')}
                    ${this.navLink('/admin/reports', 'Reports (Sales)', 'chart-line-up')}
                    ${this.navLink('/admin/analytics', 'Analytics (Pixel)', 'eye')}
                    ${this.navLink('/admin/settings', 'Settings', 'gear')}
                </nav>

                <div class="p-4 border-t dark:border-gray-700">
                    <button @click="$store.layout.logout()" class="flex items-center gap-3 text-red-500 hover:bg-red-50 dark:hover:bg-gray-700 w-full p-2 rounded transition">
                        <i class="ph ph-sign-out text-xl"></i>
                        <span x-show="$store.layout.sidebarOpen">Logout</span>
                    </button>
                </div>
            </aside>

            <div :class="$store.layout.sidebarOpen ? 'ml-64' : 'ml-20'" class="flex-1 flex flex-col transition-all duration-300 w-full">
                
                <header class="h-16 bg-white dark:bg-gray-800 border-b dark:border-gray-700 flex justify-between items-center px-6 sticky top-0 z-10 shadow-sm">
                    <div class="flex items-center gap-4">
                        <button @click="$store.layout.sidebarOpen = !$store.layout.sidebarOpen" class="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                            <i class="ph ph-list text-2xl"></i>
                        </button>
                        <h1 class="font-bold text-lg" x-text="$store.layout.pageTitle"></h1>
                    </div>

                    <div class="flex items-center gap-4">
                        <button @click="$store.layout.toggleTheme()" class="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 border dark:border-gray-600">
                            <i x-show="!$store.layout.darkMode" class="ph ph-moon text-xl"></i>
                            <i x-show="$store.layout.darkMode" class="ph ph-sun text-xl text-yellow-400"></i>
                        </button>
                        
                        <div class="flex items-center gap-2">
                            <div class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold">A</div>
                            <span class="text-sm font-medium">Admin</span>
                        </div>
                    </div>
                </header>

                <main class="flex-1 overflow-y-auto p-6">
                    ${this.innerHTML} 
                </main>
            </div>
        </div>
        `;
    }

    navLink(href, label, icon) {
        const active = window.location.pathname.startsWith(href);
        const activeClass = active ? 'bg-blue-50 text-blue-600 dark:bg-gray-700 dark:text-blue-400 font-bold' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700';
        return `
        <a href="${href}" class="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${activeClass}">
            <i class="ph ph-${icon} text-xl"></i>
            <span x-show="$store.layout.sidebarOpen">${label}</span>
        </a>`;
    }
}
customElements.define('admin-layout', AdminLayout);
