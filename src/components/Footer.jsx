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

const linkCls = "text-[15px] text-cream/80 no-underline block hover:text-gold-light transition-colors duration-[250ms]";

const FooterLink = ({ href, to, children }) => {
  if (to) return <Link to={to} className={linkCls}>{children}</Link>;
  if (href) return <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>{children}</a>;
  return <span className={`${linkCls} cursor-default`}>{children}</span>;
};

const Footer = () => (
  <footer className="bg-ink text-cream">
    <div className="max-w-[1440px] mx-auto px-12 pt-[80px] pb-12 max-[700px]:!px-[22px] max-[700px]:!pt-[60px] max-[700px]:!pb-[40px]">

      {/* 4-col grid */}
      <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-[60px] mb-16 max-[900px]:grid-cols-2 max-[900px]:gap-[44px] max-[500px]:grid-cols-1">

        {/* Brand */}
        <div>
          <Link to="/" className="no-underline text-cream">
            <div className="font-serif font-light text-[28px] italic leading-[1.1] tracking-[-0.02em] mb-1">
              jaqueline <em className="italic text-gold-light">takiuti</em>
            </div>
            <div className="font-mono text-[10px] tracking-[0.28em] uppercase text-muted mb-[22px]">
              JT · STUDIO
            </div>
          </Link>
          <p className="text-[14px] leading-[1.65] text-cream/60 max-w-[280px]">
            Micropigmentação, nanoblading e tattoo em Setúbal. Beleza natural, traços que ficam.
          </p>
        </div>

        {/* Navegação */}
        <div>
          <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light mb-6">
            — Navegação
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-[14px]">
            {navLinks.map(l => (
              <li key={l.to}><FooterLink to={l.to}>{l.label}</FooterLink></li>
            ))}
          </ul>
        </div>

        {/* Contactos */}
        <div>
          <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light mb-6">
            — Contactos
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-[14px]">
            {contactLinks.map(l => (
              <li key={l.label}><FooterLink href={l.href}>{l.value}</FooterLink></li>
            ))}
          </ul>
        </div>

        {/* Marcação */}
        <div>
          <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light mb-6">
            — Marcação
          </div>
          <ul className="list-none m-0 p-0 flex flex-col gap-[14px]">
            {bookingLinks.map(l => (
              <li key={l.label}><FooterLink href={l.href}>{l.value}</FooterLink></li>
            ))}
          </ul>
          <a
            href="https://www.sumupbookings.com/takiuti-studio"
            target="_blank" rel="noopener noreferrer"
            className="font-sans font-semibold uppercase text-[12px] tracking-[0.12em] mt-7 inline-flex items-center py-[14px] px-6 rounded-full bg-rose text-cream no-underline hover:bg-gold transition-colors duration-300"
          >
            Agendar →
          </a>
        </div>
      </div>

      {/* Base bar */}
      <div className="border-t border-cream/[.12] pt-7 flex justify-between items-center flex-wrap gap-3 max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-2">
        <span className="font-mono text-[11px] tracking-[0.15em] text-cream/40">
          © 2025 JT Studio · Todos os direitos reservados
        </span>
        <span className="font-mono text-[11px] tracking-[0.15em] text-cream/40">
          Setúbal · Portugal
        </span>
      </div>
    </div>
  </footer>
);

export default Footer;
