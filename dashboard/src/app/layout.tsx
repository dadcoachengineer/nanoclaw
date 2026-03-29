import type { Metadata } from "next";
import "./globals.css";
import { AuthInterceptor } from "./auth-interceptor";

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
        <AuthInterceptor />
        {children}
      </body>
    </html>
  );
}
