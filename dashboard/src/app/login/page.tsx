"use client";

import { useEffect, useState } from "react";

type Phase = "loading" | "setup-credentials" | "setup-totp" | "login";

export default function LoginPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpAuthURL, setTotpAuthURL] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          window.location.href = "/";
        } else if (data.needsSetup) {
          setPhase("setup-credentials");
        } else {
          setPhase("login");
        }
      })
      .catch(() => setPhase("login"));
  }, []);

  // ---------------------------------------------------------------------------
  // Setup: step 1 — create credentials
  // ---------------------------------------------------------------------------

  async function handleSetupCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!username.trim()) {
      setError("Username is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setTotpSecret(data.totpSecret);
        setTotpAuthURL(data.totpAuthURL);
        setPhase("setup-totp");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Setup: step 2 — verify TOTP
  // ---------------------------------------------------------------------------

  async function handleVerifyTOTP(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", code: totpCode }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          totpCode,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (phase === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <p className="text-[var(--text-dim)]">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-md">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8">
          <h1 className="text-2xl font-semibold text-[var(--text-bright)] mb-1 text-center">
            Mission Control
          </h1>
          <p className="text-[var(--text-dim)] text-sm text-center mb-8">
            {phase === "login"
              ? "Sign in to continue"
              : phase === "setup-credentials"
                ? "Create your account"
                : "Set up two-factor authentication"}
          </p>

          {error && (
            <div className="mb-4 px-4 py-2.5 rounded-lg bg-[var(--red)]/10 border border-[var(--red)]/30 text-[var(--red)] text-sm">
              {error}
            </div>
          )}

          {/* ---- Setup: credentials ---- */}
          {phase === "setup-credentials" && (
            <form onSubmit={handleSetupCredentials} className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                  placeholder="admin"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                  placeholder="At least 8 characters"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Confirm password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                  placeholder="Repeat password"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 bg-[var(--accent)] text-[var(--bg)] font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Continue"}
              </button>
            </form>
          )}

          {/* ---- Setup: TOTP scan & verify ---- */}
          {phase === "setup-totp" && (
            <form onSubmit={handleVerifyTOTP} className="space-y-5">
              <p className="text-sm text-[var(--text)]">
                Scan this QR code with your authenticator app (Google
                Authenticator, 1Password, Authy, etc.).
              </p>

              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/auth/qrcode?url=${encodeURIComponent(totpAuthURL)}`}
                  alt="TOTP QR Code"
                  width={200}
                  height={200}
                  className="rounded-lg border border-[var(--border)]"
                />
              </div>

              <div className="bg-[var(--bg)] rounded-lg px-4 py-3 border border-[var(--border)]">
                <p className="text-xs text-[var(--text-dim)] mb-1">
                  Manual entry key:
                </p>
                <p className="font-mono text-sm text-[var(--text-bright)] break-all select-all">
                  {totpSecret}
                </p>
              </div>

              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Verification code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, ""))
                  }
                  autoFocus
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] text-center text-xl font-mono tracking-[0.3em] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                  placeholder="000000"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || totpCode.length !== 6}
                className="w-full py-2.5 bg-[var(--accent)] text-[var(--bg)] font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? "Verifying..." : "Verify & Complete Setup"}
              </button>
            </form>
          )}

          {/* ---- Login ---- */}
          {phase === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--text-dim)] mb-1.5">
                  Authenticator code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, ""))
                  }
                  required
                  className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] text-center text-xl font-mono tracking-[0.3em] placeholder:text-[var(--text-dim)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
                  placeholder="000000"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || totpCode.length !== 6}
                className="w-full py-2.5 bg-[var(--accent)] text-[var(--bg)] font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? "Signing in..." : "Sign In"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
