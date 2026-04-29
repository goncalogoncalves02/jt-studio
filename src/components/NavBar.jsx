import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

const NavBar = () => {
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const links = [
    { label: "Início", to: "/" },
    { label: "Serviços", to: "/servicos" },
    { label: "Galeria", to: "/galeria" },
    { label: "Info & FAQ", to: "/info" },
    { label: "Contactos", to: "/contactos" },
  ];

  return (
    <>
      <nav
        style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
          padding: scrolled ? "14px 48px" : "18px 48px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: scrolled ? "rgba(20,17,16,0.92)" : "transparent",
          backdropFilter: scrolled ? "blur(14px)" : "none",
          borderBottom: scrolled ? "1px solid rgba(232,217,192,0.08)" : "none",
          color: "var(--cream)",
          transition: "all 0.35s ease",
        }}
      >
        <Link
          to="/"
          style={{ display: "flex", alignItems: "center", gap: "10px", textDecoration: "none", color: "inherit" }}
        >
          <span className="font-serif" style={{ fontSize: "26px", fontWeight: 400, fontStyle: "italic", letterSpacing: "0.01em", lineHeight: 1 }}>
            jaqueline{" "}
            <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>takiuti</em>
          </span>
          <span className="font-mono" style={{
            fontSize: "11px", letterSpacing: "0.25em", textTransform: "uppercase",
            fontStyle: "normal", color: "var(--gold-light)",
            borderLeft: "1px solid var(--gold-light)", paddingLeft: "10px", opacity: 0.7,
          }}>
            JT · STUDIO
          </span>
        </Link>

        <ul style={{ display: "flex", gap: "40px", alignItems: "center", listStyle: "none", margin: 0, padding: 0 }}
          className="hidden md:flex">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                style={{
                  fontSize: "14px", fontWeight: 500, letterSpacing: "0.02em",
                  textDecoration: "none", color: "inherit",
                  borderBottom: pathname === link.to ? "1px solid var(--gold-light)" : "1px solid transparent",
                  paddingBottom: "2px",
                  transition: "border-color 0.2s",
                }}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <a
          href="https://www.sumupbookings.com/takiuti-studio"
          target="_blank" rel="noopener noreferrer"
          className="hidden md:flex items-center gap-2 font-sans font-semibold uppercase"
          style={{
            fontSize: "13px", letterSpacing: "0.1em",
            padding: "13px 24px", borderRadius: "999px",
            background: "var(--rose)", color: "var(--cream)",
            transition: "background 0.25s",
            textDecoration: "none",
          }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--ink)"}
          onMouseLeave={e => e.currentTarget.style.background = "var(--rose)"}
        >
          Marcar <span>→</span>
        </a>

        <button
          onClick={() => setDrawerOpen(!drawerOpen)}
          className="md:hidden flex items-center justify-center"
          style={{
            width: "40px", height: "40px",
            border: "1px solid currentColor", borderRadius: "50%",
            background: "none", color: "inherit", cursor: "pointer",
            fontSize: "18px",
          }}
          aria-label="menu"
        >
          {drawerOpen ? "✕" : "≡"}
        </button>
      </nav>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 flex flex-col"
          style={{ background: "var(--ink)", color: "var(--cream)", padding: "90px 32px 40px" }}
        >
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="font-serif"
              style={{
                fontSize: "42px", fontWeight: 300, fontStyle: "normal",
                padding: "18px 0",
                borderBottom: "1px solid rgba(232,217,192,0.12)",
                textDecoration: "none", color: "var(--cream)",
                letterSpacing: "-0.015em",
              }}
            >
              {link.to === "/servicos" || link.to === "/contactos"
                ? <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>{link.label}</em>
                : link.label}
            </Link>
          ))}
          <a
            href="https://www.sumupbookings.com/takiuti-studio"
            target="_blank" rel="noopener noreferrer"
            className="font-sans font-semibold uppercase"
            style={{
              marginTop: "32px", display: "inline-flex", alignItems: "center", gap: "8px",
              fontSize: "13px", letterSpacing: "0.1em",
              padding: "16px 28px", borderRadius: "999px",
              background: "var(--rose)", color: "var(--cream)",
              textDecoration: "none", alignSelf: "flex-start",
            }}
          >
            Marcar →
          </a>
        </div>
      )}
    </>
  );
};

export default NavBar;
