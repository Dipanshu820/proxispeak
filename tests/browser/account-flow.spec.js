import { test, expect } from '@playwright/test'

// Real HTTP + cookie flow through the actual forms (no fetch stubs).
test.describe('Account flow', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-desktop',
      'account flow is verified once on desktop Chromium',
    )
  })

  test('signs up, enters the office, updates settings, and signs out', async ({ page }) => {
    const email = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`

    await page.goto('/signup')
    await page.getByLabel('Name').fill('Grace Hopper')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill('compiler-1952')
    await page.getByLabel('Confirm password').fill('compiler-1952')
    await page.getByRole('button', { name: 'Create account' }).click()

    await page.waitForURL('**/office', { timeout: 20_000 })
    await expect(page.getByRole('heading', { name: 'Virtual Office' })).toBeVisible()
    await expect(page.getByText('Design Team Floor')).toBeVisible()

    // Settings via the office header.
    await page.getByRole('button', { name: 'Account settings' }).click()
    await page.waitForURL('**/settings')
    await expect(page.getByText(email)).toBeVisible()

    await page.getByLabel('Display name').fill('Grace B. Hopper')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Settings saved.')).toBeVisible()

    // Sign out and confirm the office is protected again.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL('**/login')
    await page.goto('/office')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Sign in to your office' })).toBeVisible()
  })

  test('rejects the wrong password with a generic message', async ({ page, browser }) => {
    const email = `wrong-${Date.now()}@example.com`
    const signup = await page.request.post('/api/auth/signup', {
      data: {
        name: 'Wrong Password',
        email,
        password: 'correct-horse-1',
        confirmPassword: 'correct-horse-1',
      },
    })
    expect(signup.ok()).toBe(true)

    // A fresh context to drop the signup cookie.
    const anonymous = await browser.newContext()
    const anonymousPage = await anonymous.newPage()
    try {
      await anonymousPage.goto('/login')
      await anonymousPage.getByLabel('Email').fill(email)
      await anonymousPage.getByLabel('Password').fill('not-the-password-1')
      await anonymousPage.getByRole('button', { name: 'Sign in' }).click()
      await expect(anonymousPage.getByRole('alert')).toContainText('Email or password is incorrect.')
      await expect(anonymousPage).toHaveURL(/\/login/)
    } finally {
      await anonymous.close()
    }
  })
})
