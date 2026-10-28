/**
 * The door in front of the app.
 *
 * Before the Foldkit app boots it asks the Worker who is signed in. A signed-out
 * visitor gets the sign-in page, a pending or rejected account gets a waiting
 * page, and only an approved account boots the app. `/account` is a small
 * standalone page (sign out, delete the account, and for the admin the user
 * list); it is plain DOM so the app's model stays about studying.
 *
 * The signed-in user's id is remembered. A different id on the same browser
 * clears the previous user's cached queues, query cache, and Media first, so a
 * shared device never shows someone else's cards. Offline, a remembered user
 * boots the app from cache without asking.
 */

import { NOOK_DB_NAME } from './idb'

export const ACCOUNT_PATH = '/account'
const USER_KEY = 'nook:user'

type Account = {
  id: string
  name: string
  email: string
  role: 'user' | 'admin'
  status: 'pending' | 'approved' | 'rejected'
  createdAt?: string
}

const clearLocalData = async (): Promise<void> => {
  localStorage.removeItem(USER_KEY)
  await Promise.allSettled([
    new Promise<void>((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve()
      const request = indexedDB.deleteDatabase(NOOK_DB_NAME)
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    }),
    typeof caches === 'undefined' ? Promise.resolve(false) : caches.delete('nook-media'),
  ])
}

const el = (tag: string, className: string, children: ReadonlyArray<Node | string> = []) => {
  const node = document.createElement(tag)
  node.className = className
  node.append(...children)
  return node
}

const page = (title: string, ...body: ReadonlyArray<Node>): void => {
  const root = document.getElementById('root')
  if (root === null) return
  root.replaceChildren(
    el('main', 'mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6', [
      el('h1', 'text-2xl font-extrabold text-[var(--theme-ink)]', [title]),
      ...body,
    ]),
  )
}

const text = (value: string) => el('p', 'text-sm text-[var(--theme-sub)]', [value])

const action = (label: string, onClick: () => void | Promise<void>, primary = true) => {
  const button = el(
    'button',
    `h-10 rounded-[10px] px-4 text-sm font-semibold ${
      primary
        ? 'bg-[var(--theme-strong)] text-white'
        : 'border border-black/15 bg-[var(--theme-block)] text-[var(--theme-ink)]'
    }`,
    [label],
  ) as HTMLButtonElement
  button.type = 'button'
  button.addEventListener('click', () => {
    button.disabled = true
    void Promise.resolve(onClick()).finally(() => {
      button.disabled = false
    })
  })
  return button
}

const signOut = async (): Promise<void> => {
  await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {})
  await clearLocalData()
  location.assign('/')
}

const signInWithGoogle = async (): Promise<void> => {
  const response = await fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  })
  const body = (await response.json()) as { url?: string }
  if (body.url !== undefined) location.assign(body.url)
}

const send = (method: string, path: string) =>
  fetch(path, { method, headers: { origin: location.origin } })

const accountPage = async (me: Account): Promise<void> => {
  const rows: Array<Node> = []
  if (me.role === 'admin') {
    const response = await fetch('/api/admin/users')
    const { users } = (await response.json()) as { users: ReadonlyArray<Account> }
    const refresh = () => accountPage(me)
    rows.push(
      el('h2', 'mt-4 text-xs font-bold tracking-[2.2px] text-[var(--theme-sub)] uppercase', [
        'Users',
      ]),
      ...users
        .filter((user) => user.id !== me.id)
        .map((user) =>
          el('div', 'flex flex-col gap-2 rounded-[14px] bg-[var(--theme-block)] p-3', [
            el('div', 'text-sm font-semibold text-[var(--theme-ink)]', [
              `${user.name} · ${user.email}`,
            ]),
            el('div', 'text-xs text-[var(--theme-sub)]', [user.status]),
            el('div', 'flex gap-2', [
              ...(user.status === 'approved'
                ? []
                : [
                    action('Approve', () =>
                      send('POST', `/api/admin/users/${user.id}/approve`).then(refresh),
                    ),
                  ]),
              ...(user.status === 'rejected'
                ? []
                : [
                    action(
                      'Reject',
                      () => send('POST', `/api/admin/users/${user.id}/reject`).then(refresh),
                      false,
                    ),
                  ]),
              action(
                'Delete',
                async () => {
                  if (!confirm(`Delete ${user.email} and all their data?`)) return
                  await send('DELETE', `/api/admin/users/${user.id}`)
                  await refresh()
                },
                false,
              ),
            ]),
          ]),
        ),
    )
  }
  page(
    'Account',
    text(`${me.name} · ${me.email}`),
    el('div', 'flex flex-wrap gap-2', [
      el(
        'a',
        'inline-flex h-10 items-center rounded-[10px] border border-black/15 bg-[var(--theme-block)] px-4 text-sm font-semibold text-[var(--theme-ink)]',
        ['Back to nook'],
      ) as Node,
      action('Sign out', signOut, false),
      ...(me.role === 'admin'
        ? []
        : [
            action(
              'Delete my account',
              async () => {
                if (
                  !confirm(
                    'Delete your account and every deck, card, and review? This cannot be undone.',
                  )
                )
                  return
                await send('DELETE', '/api/me')
                await clearLocalData()
                location.assign('/')
              },
              false,
            ),
          ]),
    ]),
    ...rows,
  )
  document.querySelector<HTMLAnchorElement>('main a')?.setAttribute('href', '/')
}

/** Resolves when the app may boot. Otherwise it renders a page and never resolves. */
export const passGate = async (): Promise<void> => {
  let response: Response
  try {
    response = await fetch('/api/me')
  } catch {
    // Offline: a remembered user opens the app from cache.
    if (localStorage.getItem(USER_KEY) !== null) return
    page('Offline', text('Connect once to sign in.'))
    return new Promise<void>(() => {})
  }

  if (response.status === 401) {
    await clearLocalData()
    page(
      'nook',
      text('Spaced repetition for your own decks.'),
      action('Continue with Google', signInWithGoogle),
    )
    return new Promise<void>(() => {})
  }
  const me = (await response.json()) as Account

  if (localStorage.getItem(USER_KEY) !== me.id) {
    await clearLocalData()
    localStorage.setItem(USER_KEY, me.id)
  }
  if (me.status !== 'approved') {
    page(
      me.status === 'pending' ? 'Waiting for approval' : 'Access denied',
      text(
        me.status === 'pending'
          ? `${me.email} is signed in. The admin has to approve your account before you can study.`
          : `${me.email} was not approved.`,
      ),
      action('Sign out', signOut, false),
    )
    return new Promise<void>(() => {})
  }
  if (location.pathname === ACCOUNT_PATH) {
    await accountPage(me)
    return new Promise<void>(() => {})
  }
}
