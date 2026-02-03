import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        // Disable HMR overlay to prevent potential issues with large data/state updates crashing the client-server connection
        hmr: {
            overlay: false
        },
        // Ensure we bind to all interfaces if needed, but default is usually fine.
        // fs: {
        //   // Allow serving files from one level up to the project root
        //   allow: ['..']
        // }
    },
    // Optimize deps might be needed if using heavy libraries, but for now we keep it simple
});
