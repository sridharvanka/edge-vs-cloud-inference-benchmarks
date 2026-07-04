import "../../tokens.css";
import "./globals.css";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {/* Background grid texture from tokens.css */}
        <div className="grid-bg" />
        <div className="site-wrap">{children}</div>
      </body>
    </html>
  );
}
