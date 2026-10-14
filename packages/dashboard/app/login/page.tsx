import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { SignInButtons } from '@/components/SessionButtons';
import { authOptions } from '@/lib/auth';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (await getServerSession(authOptions())) redirect('/');
  const { error } = await searchParams;
  return (
    <main className="login">
      <h1>LLM gateway</h1>
      <p className="muted">Spend, routing and usage across every provider.</p>
      {error && (
        <p className="error">
          {error === 'AccessDenied'
            ? 'That account is not on the allow-list.'
            : 'Sign-in failed. Try again.'}
        </p>
      )}
      <SignInButtons github={Boolean(config.github())} demo={Boolean(config.demoTenantId())} />
    </main>
  );
}
