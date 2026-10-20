import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
// Exercise application boundaries without creating provider accounts, sending
// emails, loading .env.local, or installing another test framework.
function load(file, mocks = {}, env = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(code, {
    module: testModule, exports: testModule.exports, FormData, Response, URL, process: { env },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/")) throw new Error(`Unmocked application import: ${name}`);
      return requireModule(name);
    },
  }, { filename: file });
  return testModule.exports;
}

const validation = load("lib/auth/validation.ts");
const form = (entries) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};
const credentials = { email: "person@example.test", password: "a test-only password", confirmPassword: "a test-only password" };
const redirect = (url) => { throw Object.assign(new Error("Redirect"), { destination: url }); };
const siteUrl = { getSiteUrl: () => "https://ventus.example.test" };

function actions(auth) {
  const revalidated = [];
  const testActions = load("app/auth/actions.ts", {
    "@/lib/supabase/server": { createClient: async () => ({ auth }) },
    "@/lib/auth/site-url": siteUrl,
    "@/lib/auth/validation": validation,
    "next/navigation": { redirect },
    "next/cache": { revalidatePath: (...args) => revalidated.push(args) },
  });
  return { ...testActions, revalidated };
}

test("server validation rejects malformed input before contacting Auth and never echoes passwords", async () => {
  const { authenticate } = actions(new Proxy({}, { get() { throw new Error("Auth must not be called"); } }));
  for (const [mode, entries, field] of [
    ["login", { ...credentials, email: "bad email" }, "email"],
    ["signup", { ...credentials, password: "short" }, "password"],
    ["reset", { ...credentials, confirmPassword: "different" }, "confirmPassword"],
    ["recovery", { email: "a".repeat(255) + "@example.test" }, "email"],
  ]) {
    const state = await authenticate(mode, {}, form(entries));
    assert.ok(state.fieldErrors[field]);
    assert.ok(!JSON.stringify(state).includes(credentials.password));
  }
  assert.ok((await authenticate("unknown", {}, form(credentials))).error);
  assert.ok((await authenticate("login", {}, {})).error);
  assert.equal(validation.validateAuthForm("login", form({ email: credentials.email, password: "old" })).valid, true);
});

test("login redirects only on a provider-issued session and invalidates router caches", async () => {
  const success = actions({ signInWithPassword: async () => ({ data: { session: {} }, error: null }) });
  await assert.rejects(success.authenticate("login", {}, form(credentials)), (error) => error.destination === "/");
  assert.equal(success.revalidated[0][0], "/");
  const rejected = actions({ signInWithPassword: async () => ({ data: { session: null }, error: { code: "invalid_credentials", message: "DO NOT EXPOSE" } }) });
  const state = await rejected.authenticate("login", {}, form(credentials));
  assert.match(state.error, /Unable to sign in/);
  assert.ok(!JSON.stringify(state).includes("DO NOT EXPOSE"));
  assert.equal(rejected.revalidated.length, 0);
});

test("signup supports both email-confirmation and immediate-session provider policies", async () => {
  let options;
  const pending = actions({ signUp: async (input) => { options = input.options; return { data: { session: null }, error: null }; } });
  assert.match((await pending.authenticate("signup", {}, form(credentials))).message, /check your inbox/);
  assert.equal(options.emailRedirectTo, "https://ventus.example.test/auth/callback");
  const immediate = actions({ signUp: async () => ({ data: { session: {} }, error: null }) });
  await assert.rejects(immediate.authenticate("signup", {}, form(credentials)), (error) => error.destination === "/");
  const duplicate = actions({ signUp: async () => ({ data: { session: null }, error: { code: "user_already_exists" } }) });
  assert.equal((await duplicate.authenticate("signup", {}, form(credentials))).message, (await pending.authenticate("signup", {}, form(credentials))).message);
});

test("recovery is enumeration-safe and only uses a configured local callback destination", async () => {
  let callback;
  const existing = actions({ resetPasswordForEmail: async (_email, options) => { callback = options.redirectTo; return { error: null }; } });
  const missing = actions({ resetPasswordForEmail: async () => ({ error: { code: "user_not_found" } }) });
  assert.equal((await existing.authenticate("recovery", {}, form(credentials))).message, (await missing.authenticate("recovery", {}, form(credentials))).message);
  assert.equal(callback, "https://ventus.example.test/auth/callback?next=/reset-password");
});

test("password updates reject revoked sessions; successful recovery signs out the current session", async () => {
  let updated = false;
  const expired = actions({ getUser: async () => ({ data: { user: null }, error: { code: "session_not_found" } }), updateUser: async () => { updated = true; } });
  assert.match((await expired.authenticate("reset", {}, form(credentials))).error, /expired/);
  assert.equal(updated, false);
  let scope;
  const success = actions({
    getUser: async () => ({ data: { user: { id: "person" } }, error: null }),
    updateUser: async () => { updated = true; return { error: null }; },
    signOut: async (options) => { scope = options.scope; return { error: null }; },
  });
  await assert.rejects(success.authenticate("reset", {}, form(credentials)), (error) => error.destination === "/login?notice=password-updated");
  assert.equal(updated, true);
  assert.equal(scope, "local");
});

test("logout does not report success on provider failure and clears router caches on success", async () => {
  const failure = actions({ signOut: async () => ({ error: { message: "PRIVATE PROVIDER DATA" } }) });
  assert.ok((await failure.logout()).error);
  assert.equal(failure.revalidated.length, 0);
  let scope;
  const success = actions({ signOut: async (options) => { scope = options.scope; return { error: null }; } });
  assert.equal((await success.logout()).success, true);
  assert.equal(scope, "local");
  assert.equal(success.revalidated.length, 1);
});

test("authorization fails closed for anonymous, forged, revoked, and unavailable sessions", async () => {
  for (const auth of [
    { getUser: async () => ({ data: { user: null }, error: null }) },
    { getUser: async () => ({ data: { user: { id: "forged" } }, error: { code: "bad_jwt" } }) },
    { getUser: async () => ({ data: { user: null }, error: { code: "session_not_found" } }) },
    { getUser: async () => { throw new Error("Provider unavailable"); } },
  ]) {
    const users = load("lib/auth/user.ts", { "@/lib/supabase/server": { createClient: async () => ({ auth }) } });
    assert.equal(await users.getVerifiedUser(), null);
    const page = load("app/page.tsx", {
      "@/lib/auth/user": users, "next/navigation": { redirect },
      "@/lib/server/workspace": { loadWorkspace() { throw new Error("Must not read tasks"); } },
      "@/components/dashboard/dashboard": { Dashboard() { throw new Error("Must not render"); } },
      "@/components/auth/session-guard": { SessionGuard() { throw new Error("Must not render"); } },
    });
    await assert.rejects(page.default({}), (error) => error.destination === "/login");
    const session = load("app/auth/session/route.ts", { "@/lib/auth/user": users });
    const response = await session.GET();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).userId, null);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
});

test("session responses contain only the verified user identifier and no tokens", async () => {
  const session = load("app/auth/session/route.ts", {
    "@/lib/auth/user": { getVerifiedUser: async () => ({ id: "person", email: "private@example.test", access_token: "private-token" }) },
  });
  const response = await session.GET();
  assert.deepEqual(await response.json(), { userId: "person" });
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("email callbacks reject invalid/expired links, constrain redirects, and do not reflect tokens", async () => {
  let exchanges = 0;
  const callback = (auth) => load("app/auth/callback/route.ts", {
    "@/lib/supabase/server": { createClient: async () => ({ auth }) }, "@/lib/auth/site-url": siteUrl,
  });
  const route = callback({
    exchangeCodeForSession: async () => { exchanges++; return { data: { session: {}, redirectType: null }, error: null }; },
    verifyOtp: async () => ({ data: { session: {} }, error: null }),
  });
  const request = (query) => ({ nextUrl: new URL(`https://ventus.example.test/auth/callback${query}`) });
  for (const [query, path] of [
    ["?code=fixture&next=https://attacker.test", "/"],
    ["?code=fixture&next=//attacker.test", "/"],
    ["?code=fixture&next=/reset-password", "/reset-password"],
    ["?token_hash=fixture&type=recovery", "/reset-password"],
    ["?token_hash=fixture&type=signup", "/"],
    ["?token_hash=fixture&type=invite", "/login?notice=link-error"],
    ["?error=private-error&code=fixture", "/login?notice=link-error"],
    ["?error=access_denied&error_code=otp_expired&error_description=private-provider-detail", "/login?notice=link-expired"],
    ["?code=fixture&token_hash=fixture&type=recovery", "/login?notice=link-error"],
    ["", "/login?notice=link-error"],
  ]) {
    const response = await route.GET(request(query));
    assert.equal(response.headers.get("location"), `https://ventus.example.test${path}`);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal(exchanges, 3);
  const expired = callback({ exchangeCodeForSession: async () => ({ error: { message: "PRIVATE TOKEN" } }) });
  assert.equal((await expired.GET(request("?code=expired"))).headers.get("location"), "https://ventus.example.test/login?notice=link-error");
});

test("canonical callback configuration rejects unsafe origins and has no production fallback", () => {
  for (const value of ["http://attacker.test", "https://user:password@example.test", "https://example.test/path", "https://example.test?next=evil", "javascript:alert(1)", ""]) {
    assert.throws(() => load("lib/auth/site-url.ts", {}, { SITE_URL: value, NODE_ENV: "production" }).getSiteUrl());
  }
  assert.equal(load("lib/auth/site-url.ts", {}, { NODE_ENV: "development" }).getSiteUrl(), "http://localhost:3000");
  assert.equal(load("lib/auth/site-url.ts", {}, { SITE_URL: "https://ventus.example.test/", NODE_ENV: "production" }).getSiteUrl(), "https://ventus.example.test");
});

test("Server Action origin accepts the matching local loopback host but rejects cross-origin requests", () => {
  const local = load("lib/auth/site-url.ts", {}, { NODE_ENV: "development" });
  assert.equal(local.getSiteUrl(), "http://localhost:3000");
  assert.equal(local.isValidActionOrigin("http://127.0.0.1:3000", "127.0.0.1:3000"), true);
  assert.equal(local.isValidActionOrigin("http://localhost:3000", "localhost:3000"), true);
  assert.equal(local.isValidActionOrigin("http://127.0.0.1:3000", "localhost:3000"), false);
  assert.equal(local.isValidActionOrigin("http://localhost:3000", "127.0.0.1:3000"), false);
  assert.equal(local.isValidActionOrigin("http://attacker.test", "attacker.test"), false);
  assert.equal(local.isValidActionOrigin(null, "127.0.0.1:3000"), false);

  const deployed = load("lib/auth/site-url.ts", {}, { NODE_ENV: "production", SITE_URL: "https://ventus.example.test" });
  assert.equal(deployed.isValidActionOrigin("https://ventus.example.test", "ventus.example.test"), true);
  assert.equal(deployed.isValidActionOrigin("http://127.0.0.1:3000", "127.0.0.1:3000"), false);
});

test("real SSR SDK writes login cookies, clears them on logout, and rejects replay of a revoked session (mock Auth HTTP)", async () => {
  const { createServerClient } = requireModule("@supabase/ssr");
  const cookies = new Map();
  const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: credentials.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, session_id: "22222222-2222-4222-8222-222222222222" })}.testsignature`;
  let active = false;
  const transport = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://example.supabase.co");
    if (url.pathname === "/auth/v1/token" && options.method === "POST") {
      active = true;
      return Response.json({ access_token: accessToken, refresh_token: "test-only-refresh-fixture", token_type: "bearer", expires_in: 3600, user });
    }
    if (url.pathname === "/auth/v1/user") {
      return active && new Headers(options.headers).get("authorization") === `Bearer ${accessToken}`
        ? Response.json(user)
        : Response.json({ code: "session_not_found", msg: "Session revoked" }, { status: 403 });
    }
    if (url.pathname === "/auth/v1/logout" && options.method === "POST") {
      assert.equal(url.searchParams.get("scope"), "local");
      active = false;
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected Auth HTTP operation");
  };
  const server = load("lib/supabase/server.ts", {
    "./config": {
      requireSupabaseConfig: () => ({ url: "https://example.supabase.co", publishableKey: "sb_publishable_auth_test_fixture" }),
      sessionCookieOptions: { path: "/", sameSite: "lax", secure: true, httpOnly: false },
    },
    "next/headers": { cookies: async () => ({ getAll: () => [...cookies].map(([name, value]) => ({ name, value })), set(name, value, options) { if (options.maxAge === 0) cookies.delete(name); else cookies.set(name, value); } }) },
    "@supabase/ssr": { createServerClient: (url, key, options) => createServerClient(url, key, { ...options, global: { fetch: transport } }) },
  });
  const realActions = load("app/auth/actions.ts", {
    "@/lib/supabase/server": server, "@/lib/auth/site-url": siteUrl,
    "@/lib/auth/validation": validation, "next/navigation": { redirect }, "next/cache": { revalidatePath() {} },
  });
  const users = load("lib/auth/user.ts", { "@/lib/supabase/server": server });
  assert.equal(await users.getVerifiedUser(), null);
  await assert.rejects(realActions.authenticate("login", {}, form(credentials)), (error) => error.destination === "/");
  assert.ok(cookies.size > 0);
  assert.equal((await users.getVerifiedUser()).id, user.id);
  const replay = new Map(cookies);
  assert.equal((await realActions.logout()).success, true);
  assert.equal(cookies.size, 0);
  assert.equal(await users.getVerifiedUser(), null);
  for (const [name, value] of replay) cookies.set(name, value);
  assert.equal(await users.getVerifiedUser(), null);
});

test("proxy preserves refreshed request/response cookies and first-write cache headers across multiple SDK writes", async () => {
  const { NextRequest, NextResponse } = requireModule("next/server");
  const route = load("lib/supabase/proxy.ts", {
    "./config": { getSupabaseConfig: () => ({ url: "https://example.supabase.co", publishableKey: "sb_publishable_auth_test_fixture" }), sessionCookieOptions: { path: "/", secure: true, sameSite: "lax" } },
    "next/server": { NextResponse },
    "@supabase/ssr": { createServerClient(_url, _key, options) {
      return { auth: { async getClaims() {
        options.cookies.setAll([{ name: "session.0", value: "access-fixture", options: { path: "/", secure: true } }], { "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" });
        options.cookies.setAll([{ name: "session.1", value: "refresh-fixture", options: { path: "/", secure: true } }], {});
        return { data: { claims: {} }, error: null };
      } } };
    } },
  });
  const request = new NextRequest("https://ventus.example.test/");
  const response = await route.updateSession(request);
  assert.equal(request.cookies.get("session.1").value, "refresh-fixture");
  assert.match(response.headers.get("x-middleware-request-cookie"), /session.0=access-fixture/);
  assert.equal(response.cookies.get("session.0").value, "access-fixture");
  assert.equal(response.cookies.get("session.1").value, "refresh-fixture");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

function recoveryFixture({ cookieWritesFail = false } = {}) {
  const { createServerClient } = requireModule("@supabase/ssr");
  const cookies = new Map();
  const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: credentials.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated" })}.testsignature`;
  const session = { access_token: accessToken, refresh_token: "test-only-recovery-fixture", token_type: "bearer", expires_in: 3600, user };
  let challenge;
  let recovered = false;
  let codeUsed = false;
  let hashUsed = false;
  let requestCount = 0;
  let redirectUrl;
  const transport = async (input, options) => {
    requestCount++;
    const url = new URL(input);
    assert.equal(url.origin, "https://example.supabase.co");
    if (url.pathname === "/auth/v1/recover") {
      const body = JSON.parse(options.body);
      assert.equal(body.code_challenge_method, "s256");
      challenge = body.code_challenge;
      redirectUrl = url.searchParams.get("redirect_to");
      return Response.json({});
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const body = JSON.parse(options.body);
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier))).toString("base64url");
      if (codeUsed || body.auth_code !== "valid-recovery-code" || hash !== challenge) return Response.json({ code: "flow_state_not_found", msg: "Expired fixture" }, { status: 400, headers: { "X-Supabase-Api-Version": "2024-01-01" } });
      codeUsed = true;
      recovered = true;
      return Response.json(session);
    }
    if (url.pathname === "/auth/v1/verify") {
      const body = JSON.parse(options.body);
      if (hashUsed || body.type !== "recovery" || body.token_hash !== "valid-recovery-hash") return Response.json({ code: "otp_expired", msg: "Expired fixture" }, { status: 403, headers: { "X-Supabase-Api-Version": "2024-01-01" } });
      hashUsed = true;
      recovered = true;
      return Response.json(session);
    }
    if (url.pathname === "/auth/v1/user") {
      return recovered && new Headers(options.headers).get("authorization") === `Bearer ${accessToken}`
        ? Response.json(user)
        : Response.json({ code: "session_not_found", msg: "No session" }, { status: 403 });
    }
    throw new Error("Unexpected recovery HTTP operation");
  };
  const server = load("lib/supabase/server.ts", {
    "./config": { requireSupabaseConfig: () => ({ url: "https://example.supabase.co", publishableKey: "sb_publishable_auth_test_fixture" }), sessionCookieOptions: { path: "/", secure: true, sameSite: "lax", httpOnly: false } },
    "next/headers": { cookies: async () => ({ getAll: () => [...cookies].map(([name, value]) => ({ name, value })), set(name, value, options) { if (cookieWritesFail) throw new Error("Cookie store is read-only"); if (options.maxAge === 0) cookies.delete(name); else cookies.set(name, value); } }) },
    "@supabase/ssr": { createServerClient: (url, key, options) => createServerClient(url, key, { ...options, global: { fetch: transport } }) },
  });
  const imports = {
    "@/lib/supabase/server": server, "@/lib/auth/site-url": siteUrl,
    "@/lib/auth/validation": validation, "next/navigation": { redirect }, "next/cache": { revalidatePath() {} },
  };
  return {
    cookies, requestCount: () => requestCount, redirectUrl: () => redirectUrl,
    actions: load("app/auth/actions.ts", imports),
    callback: load("app/auth/callback/route.ts", imports),
    users: load("lib/auth/user.ts", imports),
  };
}

test("recovery request persists PKCE verifier; callback uses SDK recovery intent even without next", async () => {
  const fixture = recoveryFixture();
  const state = await fixture.actions.authenticate("recovery", {}, form(credentials));
  assert.ok(state.message);
  assert.ok([...fixture.cookies.keys()].some((name) => name.endsWith("-code-verifier")));
  assert.equal(fixture.redirectUrl(), "https://ventus.example.test/auth/callback?next=/reset-password");
  const response = await fixture.callback.GET({ nextUrl: new URL("https://ventus.example.test/auth/callback?code=valid-recovery-code") });
  assert.equal(response.headers.get("location"), "https://ventus.example.test/reset-password");
  assert.equal((await fixture.users.getVerifiedUser()).id, "11111111-1111-4111-8111-111111111111");
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("recovery does not report success or send email if the verifier cookie cannot be written", async () => {
  const fixture = recoveryFixture({ cookieWritesFail: true });
  const state = await fixture.actions.authenticate("recovery", {}, form(credentials));
  assert.ok(state.error);
  assert.equal(state.message, undefined);
  assert.equal(fixture.requestCount(), 0);
});

test("PKCE recovery without its browser verifier fails closed with a specific safe notice", async () => {
  const fixture = recoveryFixture();
  const response = await fixture.callback.GET({ nextUrl: new URL("https://ventus.example.test/auth/callback?code=valid-recovery-code&next=/reset-password") });
  assert.equal(response.headers.get("location"), "https://ventus.example.test/login?notice=link-verifier-missing");
  assert.equal(fixture.requestCount(), 0);
  assert.equal(await fixture.users.getVerifiedUser(), null);
});

test("token-hash recovery establishes a verified SSR session without PKCE and rejects replay", async () => {
  const fixture = recoveryFixture();
  const request = { nextUrl: new URL("https://ventus.example.test/auth/callback?token_hash=valid-recovery-hash&type=recovery") };
  assert.equal((await fixture.callback.GET(request)).headers.get("location"), "https://ventus.example.test/reset-password");
  assert.equal((await fixture.users.getVerifiedUser()).id, "11111111-1111-4111-8111-111111111111");
  fixture.cookies.clear();
  assert.equal((await fixture.callback.GET(request)).headers.get("location"), "https://ventus.example.test/login?notice=link-expired");
  assert.equal(await fixture.users.getVerifiedUser(), null);
});
