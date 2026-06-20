import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileApiPlugin } from './plugins/fileApiPlugin'
import { aiPlugin } from './plugins/aiPlugin'

const projectRoot = path.resolve(__dirname, '..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  return {
    plugins: [
      react(),
      tailwindcss(),
      fileApiPlugin(projectRoot),
      aiPlugin(projectRoot, env),
    ],
    server: {
      port: 5180,
      open: true,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@/components': path.resolve(__dirname, 'src/components'),
        '@/lib': path.resolve(__dirname, 'src/lib'),
        '@/hooks': path.resolve(__dirname, 'src/hooks'),
        '@/data': path.resolve(__dirname, 'src/data'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (
              id.includes('node_modules/shiki') ||
              id.includes('node_modules/@shikijs')
            ) {
              return 'shiki'
            }
            if (id.includes('node_modules/mermaid')) {
              return 'mermaid'
            }
            if (
              id.includes('node_modules/reactflow') ||
              id.includes('node_modules/@reactflow')
            ) {
              return 'reactflow'
            }
            if (
              id.includes('node_modules/react') ||
              id.includes('node_modules/react-dom')
            ) {
              return 'vendor'
            }
          },
        },
      },
    },
  }
})
