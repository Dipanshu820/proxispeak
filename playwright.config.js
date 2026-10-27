import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalTimeout: 300_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'chromium-mobile',
      use: { viewport: { width: 390, height: 770 } },
    },
    {
      name: 'chromium-desktop-fake-media',
      use: {
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--disable-features=WebRtcAllowInputCapture',
          ],
        },
      },
    },
  ],
})
