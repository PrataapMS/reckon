import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { Alert, Button, Heading, inputClass, Muted } from '../components/ui';

/** Single-user sign-in (spec §2.5): a passphrase checked against a scrypt hash. */
export function Login() {
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const login = useMutation({ mutationFn: () => api.login(passphrase), onSuccess: () => qc.invalidateQueries() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <section aria-labelledby="login-heading" className="max-w-sm">
      <Heading id="login-heading">Welcome back.</Heading>
      <Muted className="mt-2">Reckon is yours alone. Enter your passphrase to see your brief.</Muted>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm text-[var(--color-muted)]">
          Passphrase
          <input
            type="password"
            autoComplete="current-password"
            className={`${inputClass} mt-1`}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        </label>
        <Button type="submit" disabled={login.isPending || !passphrase}>
          Sign in
        </Button>
      </form>
      {login.isError && <Alert>{login.error.message}</Alert>}
    </section>
  );
}
