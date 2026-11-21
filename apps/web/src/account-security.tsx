import { useEffect, useState, type FormEvent } from 'react';
import { api, json, message } from './api';

export function AccountSecurity({ token, close, signInAgain }: {
  token: string;
  close: () => void;
  signInAgain: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>();
  const [secret, setSecret] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ enabled: boolean }>('/auth/totp', token)
      .then((result) => { if (active) setEnabled(result.enabled); })
      .catch((error) => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = values.get('password');
    const factor = values.get('factor');
    setBusy(true);
    setError('');
    try {
      if (enabled) {
        await api('/auth/totp/disable', token, json('POST', { password, factor }));
        signInAgain();
      } else if (secret) {
        const result = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', token, json('POST', { password, factor }));
        setSecret('');
        setCodes(result.recoveryCodes);
      } else {
        const result = await api<{ secret: string }>('/auth/totp/enrollment', token, json('POST', { password }));
        setSecret(result.secret);
      }
      form.reset();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel stack">
    <h1>Account security</h1>
    {codes.length > 0 ? <>
      <h2>Recovery codes</h2>
      <p>Save these codes in a secure place. Each code works once and is shown here once.</p>
      <ul>{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
      <button onClick={signInAgain}>Sign in again</button>
    </> : <>
      <button onClick={close}>Back</button>
      {enabled !== undefined && <form className="stack" onSubmit={(event) => void submit(event)}>
        <p>Two-factor authentication is {enabled ? 'enabled' : 'disabled'}.</p>
        {secret && <>
          <p>Add a time-based account in your authenticator using this key. Confirm setup within ten minutes.</p>
          <code>{secret}</code>
          <button type="button" onClick={() => setSecret('')} disabled={busy}>Start over</button>
        </>}
        <label>Current password <input name="password" type="password" autoComplete="current-password" required /></label>
        {(secret || enabled) && <label>{enabled ? 'Authenticator or recovery code' : 'Authenticator code'}
          <input name="factor" autoComplete="one-time-code" required />
        </label>}
        <button disabled={busy}>{enabled ? 'Disable two-factor authentication' : secret ? 'Confirm enrollment' : 'Set up two-factor authentication'}</button>
      </form>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
