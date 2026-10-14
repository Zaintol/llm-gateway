'use client';

import { signIn, signOut } from 'next-auth/react';

export function SignOutButton() {
  return (
    <button type="button" className="link" onClick={() => void signOut({ callbackUrl: '/login' })}>
      Sign out
    </button>
  );
}

export function SignInButtons({ github, demo }: { github: boolean; demo: boolean }) {
  return (
    <div className="signin">
      {github && (
        <button
          type="button"
          className="primary"
          onClick={() => void signIn('github', { callbackUrl: '/' })}
        >
          Sign in with GitHub
        </button>
      )}
      {demo && (
        <button
          type="button"
          className={github ? 'secondary' : 'primary'}
          onClick={() => void signIn('demo', { callbackUrl: '/' })}
        >
          Explore the read-only demo
        </button>
      )}
      {!github && !demo && (
        <p className="muted">
          No sign-in method is configured. Set GITHUB_ID/GITHUB_SECRET or DEMO_TENANT_ID.
        </p>
      )}
    </div>
  );
}
