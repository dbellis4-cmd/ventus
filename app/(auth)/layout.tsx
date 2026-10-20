import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="auth-shell"><div className="auth-container">
    <Link className="brand auth-brand" href="/login" aria-label="Ventus login"><span className="brand-mark" aria-hidden="true">v</span>Ventus<span className="brand-period">.</span></Link>
    <section className="auth-card">{children}</section>
  </div></main>;
}
