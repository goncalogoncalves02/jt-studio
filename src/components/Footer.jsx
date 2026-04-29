import { Link } from "react-router-dom";

const navLinks = [
  { label: "Início", to: "/" },
  { label: "Serviços", to: "/servicos" },
  { label: "Galeria", to: "/galeria" },
  { label: "Info & FAQ", to: "/info" },
  { label: "Contactos", to: "/contactos" },
];

const contactLinks = [
  { label: "WhatsApp", href: "https://wa.me/351962149209", value: "+351 962 149 209" },
  { label: "Instagram", href: "https://www.instagram.com/jtmicroblading/", value: "@jtmicroblading" },
  { label: "Localização", href: "https://maps.app.goo.gl/5hpuH5kQ1kCkbFqt8", value: "Setúbal, Portugal" },
];

const bookingLinks = [
  { label: "Agendar Online", href: "https://www.sumupbookings.com/takiuti-studio", value: "SumUp Bookings" },
  { label: "Horário", href: null, value: "Seg — Sáb · 09—20h" },
];

const linkStyle = { fontSize: "15px", color: "rgba(244,237,228,0.8)", textDecoration: "none", transition: "color .25s", display: "block" };

const FooterLink = ({ href, to, children }) => {
  if (to) return (
    <Link to={to} style={linkStyle}
      onMouseEnter={e => e.currentTarget.style.color = "var(--gold-light)"}
      onMouseLeave={e => e.currentTarget.style.color = "rgba(244,237,228,0.8)"}
    >{children}</Link>
  );
  if (href) return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}
      onMouseEnter={e => e.currentTarget.style.color = "var(--gold-light)"}
      onMouseLeave={e => e.currentTarget.style.color = "rgba(244,237,228,0.8)"}
    >{children}</a>
  );
  return <span style={{ ...linkStyle, cursor: "default" }}>{children}</span>;
};

const Footer = () => (
  <footer style={{ background: "var(--ink)", color: "var(--cream)" }}>
    <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "80px 48px 48px" }}
      className="max-[700px]:!px-[22px] max-[700px]:!pt-[60px] max-[700px]:!pb-[40px]">

      {/* 4-col grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: "60px", marginBottom: "64px" }}
        className="max-[900px]:!grid-cols-2 max-[900px]:!gap-[44px] max-[500px]:!grid-cols-1">

        {/* Brand */}
        <div>
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="font-serif" style={{ fontWeight: 300, fontSize: "28px", fontStyle: "italic", lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: "4px" }}>
              jaqueline <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>takiuti</em>
            </div>
            <div className="font-mono" style={{ fontSize: "10px", letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "22px" }}>
              JT · STUDIO
            </div>
          </Link>
          <p style={{ fontSize: "14px", lineHeight: 1.65, color: "rgba(244,237,228,0.6)", maxWidth: "280px" }}>
            Micropigmentação, nanoblading e tattoo em Setúbal. Beleza natural, traços que ficam.
          </p>
        </div>

        {/* Navegação */}
        <div>
          <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)", marginBottom: "24px" }}>
            — Navegação
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
            {navLinks.map(l => (
              <li key={l.to}><FooterLink to={l.to}>{l.label}</FooterLink></li>
            ))}
          </ul>
        </div>

        {/* Contactos */}
        <div>
          <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)", marginBottom: "24px" }}>
            — Contactos
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
            {contactLinks.map(l => (
              <li key={l.label}><FooterLink href={l.href}>{l.value}</FooterLink></li>
            ))}
          </ul>
        </div>

        {/* Marcação */}
        <div>
          <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)", marginBottom: "24px" }}>
            — Marcação
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
            {bookingLinks.map(l => (
              <li key={l.label}><FooterLink href={l.href}>{l.value}</FooterLink></li>
            ))}
          </ul>
          <a
            href="https://www.sumupbookings.com/takiuti-studio"
            target="_blank" rel="noopener noreferrer"
            className="font-sans font-semibold uppercase inline-flex items-center"
            style={{ fontSize: "12px", letterSpacing: "0.12em", padding: "14px 24px", borderRadius: "999px", background: "var(--rose)", color: "var(--cream)", textDecoration: "none", marginTop: "28px", transition: "background .3s" }}
            onMouseEnter={e => e.currentTarget.style.background = "var(--gold)"}
            onMouseLeave={e => e.currentTarget.style.background = "var(--rose)"}
          >
            Agendar →
          </a>
        </div>
      </div>

      {/* Base bar */}
      <div style={{ borderTop: "1px solid rgba(232,217,192,0.12)", paddingTop: "28px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}
        className="max-[600px]:!flex-col max-[600px]:!items-start max-[600px]:!gap-[8px]">
        <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "rgba(244,237,228,0.4)" }}>
          © 2025 JT Studio · Todos os direitos reservados
        </span>
        <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "rgba(244,237,228,0.4)" }}>
          Setúbal · Portugal
        </span>
      </div>
    </div>
  </footer>
);

export default Footer;
