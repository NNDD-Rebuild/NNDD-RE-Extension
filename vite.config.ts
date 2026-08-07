import { defineConfig } from 'vite';
import webExtension, { readJsonFile } from 'vite-plugin-web-extension';

function generateManifest(target: 'chrome' | 'firefox') {
  const pkg = readJsonFile('package.json');
  const base = readJsonFile('src/manifest.json');
  const manifest = {
    ...base,
    version: pkg.version
  };

  if (target === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: { id: 'nndd-re-extension@nndd-rebuild' }
    };
  }

  return manifest;
}

export default defineConfig(({ mode }) => {
  const target = mode === 'firefox' ? 'firefox' : 'chrome';
  return {
    build: {
      outDir: `dist/${target}`
    },
    plugins: [
      webExtension({
        manifest: () => generateManifest(target),
        browser: target,
        webExtConfig: {
          startUrl: ['https://www.nicovideo.jp/']
        }
      })
    ]
  };
});
