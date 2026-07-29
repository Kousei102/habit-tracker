import { useState } from "react";
import type { FormEvent } from "react";
import type { SessionUser } from "../../../shared/types.ts";
import { login } from "../api.ts";
import { describeError } from "../errors.ts";

type LoginPageProps = {
  onLoggedIn: (user: SessionUser) => void;
  /**
   * Why the app is showing this screen, when it is not simply "you are signed
   * out" — the session check failed, say. Displayed in the same place as a login
   * failure, and superseded by one: two live regions on one form would make the
   * screen announce itself twice and leave a reader to work out which message is
   * about what they just did.
   */
  notice?: string | null;
};

export function LoginPage({ onLoggedIn, notice = null }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const { user } = await login({ username, password });
      onLoggedIn(user);
    } catch (cause) {
      // The server deliberately says nothing about which field was wrong, and
      // neither does this screen. A server that did not answer at all is a
      // different message, and it comes through the same path (AC-6.4).
      setError(describeError(cause, "ログインできませんでした"));
      setPending(false);
    }
  }

  // What this attempt produced wins over why the screen appeared in the first
  // place: the newer message is the one the user is waiting for.
  const message = error ?? notice;

  return (
    <section className="card" aria-labelledby="login-heading">
      <h2 className="card__title" id="login-heading">
        ログイン
      </h2>

      <form className="form" onSubmit={handleSubmit} noValidate={false}>
        <div className="form__field">
          <label htmlFor="login-username">ユーザー名</label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>

        <div className="form__field">
          <label htmlFor="login-password">パスワード</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {message !== null && (
          <p className="form__error" role="alert">
            {message}
          </p>
        )}

        <button className="button" type="submit" disabled={pending}>
          ログイン
        </button>
      </form>
    </section>
  );
}
