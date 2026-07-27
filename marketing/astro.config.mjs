import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://github.com/sanjayrohith/Dejavu',
  outDir: './dist',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
