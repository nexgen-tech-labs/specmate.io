import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in — SpecMate',
  description: 'Sign in to your SpecMate workspace.',
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-ink">Sign in to SpecMate</h1>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
