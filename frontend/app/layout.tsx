import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NixSearch — Find what matters",
  description: "Fast, focused search powered by NixSearch.",
  applicationName: "NixSearch",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
