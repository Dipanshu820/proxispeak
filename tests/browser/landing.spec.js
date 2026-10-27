import { test, expect } from '@playwright/test'

test.describe('Public pages', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'public pages are checked on desktop')
  })

  test('landing page explains the product and its links work', async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByRole('heading', { name: /work together\. hear who's nearby\./i }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Get started' }).first()).toHaveAttribute(
      'href',
      '/signup',
    )
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute('href', '/login')

    // Every marketing section is present and linked from the navigation.
    for (const name of ['Product', 'How it works', 'Spatial audio', 'Security']) {
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name })).toBeVisible()
    }

    await expect(page.getByRole('heading', { name: 'What is actually in place' })).toBeVisible()
    await expect(page.getByText(/audio is full-mesh WebRTC/i)).toBeVisible()
    await expect(page.getByRole('contentinfo')).toContainText('No audio is recorded')

    // Anonymous "explore" lands on the login page rather than a dead button.
    await page.getByRole('link', { name: 'Explore the office' }).click()
    await expect(page).toHaveURL(/\/login/)
  })

  test('unknown routes render the not-found page', async ({ page }) => {
    await page.goto('/this-room-does-not-exist')
    await expect(page.getByRole('heading', { name: 'This room does not exist' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible()
  })
})
