import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backendPort = process.env.WINDBOT_ARENA_PORT || 3000;

export default defineConfig({
    plugins: [vue()],
    root: 'client',
    build: {
        emptyOutDir: true,
        outDir: '../dist',
    },
    server: {
        host: '127.0.0.1',
        port: 5173,
        proxy: {
            '/api': `http://127.0.0.1:${backendPort}`,
        },
    },
});
