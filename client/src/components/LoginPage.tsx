import { useState } from "react";
import type { FormEvent } from "react";
import type { SessionUser } from "../../../shared/types.ts";
import { ApiError, login } from "../api.ts";

type LoginPageProps = {
  onLoggedIn: (user: SessionUser) => void;
};

export function LoginPage({ onLoggedIn }: LoginPageProps) {
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
      // neither does this screen.
      setError(cause instanceof ApiError ? cause.message : "ログインできませんでした");
      setPending(false);
    }
  }

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

        {error !== null && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}

        <button className="button" type="submit" disabled={pending}>
          ログイン
        </button>
      </form>
    </section>
  );
}
