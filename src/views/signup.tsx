import type { FC } from "hono/jsx";
import type { Bindings } from "../env";
import { Icon } from "./icon";
import { Layout, type Flash } from "./layout";

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
          <p class="eyebrow">{signup ? "Free for 1 app, no card needed" : "Welcome back"}</p>
          <h1>{signup ? "Start winning back your 1-star reviewers" : "Sign in to your review loop"}</h1>
          <ul class="auth-points">
            <li>
              <Icon name="check-circle" size={20} />
              <span>
                <strong>Two minutes to start.</strong> Try the whole loop on sample reviews before you connect anything.
              </span>
            </li>
            <li>
              <Icon name="check-circle" size={20} />
              <span>
                <strong>Both stores.</strong> App Store Connect and Google Play, with step-by-step setup guides.
              </span>
            </li>
            <li>
              <Icon name="check-circle" size={20} />
              <span>
                <strong>Stars you can count.</strong> Every fix shows how many reviewers raised their rating.
              </span>
            </li>
          </ul>
        </div>

        <div class="auth-card">
          <h2>{signup ? "Create your account" : "Sign in"}</h2>
          <a class="button github lg" href={href}>
            <Icon name="github" size={20} />
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
