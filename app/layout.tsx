import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chromograph — visual text encoder",
  description:
    "Encode text into a continuous colour-graded spline over a 5x6 character grid, then decode it back out of the image.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
