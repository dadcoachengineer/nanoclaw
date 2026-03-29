import type { Metadata } from "next";
import "./globals.css";
// Auth is handled by middleware (HMAC session validation in Edge runtime).
// No client-side interceptor needed.

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Personal command center",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
