import type { FC } from "hono/jsx";
import type { Bindings } from "../env";
import { Layout, type Flash } from "./layout";

const GithubMark: FC = () => (
  <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

interface SignupProps {
  env: Bindings;
  mode: "signup" | "signin";
  next: string | null;
  flash?: Flash | null;
  devLogin: boolean;
}

export const SignupPage: FC<SignupProps> = ({ env, mode, next, flash, devLogin }) => {
  const signup = mode === "signup";
  const href = `/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <Layout
      env={env}
      title={signup ? "Create your account" : "Sign in"}
      user={null}
      flash={flash}
      wide
      canonical={`${env.APP_URL}${signup ? "/signup" : "/login"}`}
    >
      <section class="auth">
        <div class="auth-copy">
          <p class="lp-eyebrow">{signup ? "Free for 1 app · No card needed" : "Welcome back"}</p>
          <h1>{signup ? "Start winning back your 1-star reviewers" : "Sign in to your review loop"}</h1>
          <ul class="auth-points">
            <li>
              <strong>Two minutes to start.</strong> Try the whole loop on sample reviews before you connect anything.
            </li>
            <li>
              <strong>Both stores.</strong> App Store Connect and Google Play, step-by-step guides included.
            </li>
            <li>
              <strong>Stars you can count.</strong> Every fix shows how many reviewers raised their rating.
            </li>
          </ul>
        </div>

        <div class="auth-card">
          <h2>{signup ? "Create your account" : "Sign in"}</h2>
          <a class="button github xl" href={href}>
            <GithubMark />
            {devLogin ? "Continue as the local dev account" : "Continue with GitHub"}
          </a>
          <p class="auth-fine">
            {env.APP_NAME} only reads your public GitHub profile and email address. It never sees your password or your code, and
            there's no {env.APP_NAME} password to leak.
          </p>
          <p class="auth-fine">
            By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.
          </p>
          <p class="auth-switch">
            {signup ? (
              <>
                Already have an account? <a href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</a>
              </>
            ) : (
              <>
                New here? <a href="/signup">Create a free account</a>
              </>
            )}
          </p>
        </div>
      </section>
    </Layout>
  );
};
