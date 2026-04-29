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

  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  const links = [
    { label: "Início", to: "/" },
    { label: "Serviços", to: "/servicos" },
    { label: "Galeria", to: "/galeria" },
    { label: "Info & FAQ", to: "/info" },
    { label: "Contactos", to: "/contactos" },
  ];

  return (
    <>
      <nav className={`fixed top-0 left-0 right-0 z-[100] flex justify-between items-center text-cream transition-all duration-[350ms] max-[700px]:!px-[22px] ${scrolled ? "bg-ink/92 backdrop-blur-[14px] border-b border-cream/[.08] px-12 py-[14px]" : "bg-transparent px-12 py-[18px]"}`}>

        <Link to="/" className="flex items-center gap-[10px] no-underline text-cream">
          <span className="font-serif text-[26px] font-normal italic leading-none tracking-[0.01em]">
            jaqueline <em className="not-italic text-gold-light">takiuti</em>
          </span>
          <span className="font-mono text-[11px] tracking-[0.25em] uppercase not-italic text-gold-light border-l border-gold-light/70 pl-[10px] opacity-70 hidden sm:inline">
            JT · STUDIO
          </span>
        </Link>

        <ul className="hidden md:flex gap-[40px] items-center list-none m-0 p-0">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className={`text-[14px] font-medium tracking-[0.02em] no-underline pb-px border-b transition-[border-color] duration-200 ${pathname === link.to ? "border-gold-light text-cream" : "border-transparent text-cream/80 hover:text-cream"}`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <a
          href="https://www.sumupbookings.com/takiuti-studio"
          target="_blank" rel="noopener noreferrer"
          className="hidden md:flex items-center gap-2 font-sans font-semibold uppercase text-[13px] tracking-[0.1em] py-[13px] px-6 rounded-full bg-rose text-cream no-underline hover:bg-rose-deep transition-colors duration-[250ms]"
        >
          Marcar <span>→</span>
        </a>

        <button
          onClick={() => setDrawerOpen(!drawerOpen)}
          className="md:hidden flex items-center justify-center w-11 h-11 border border-current rounded-full bg-transparent text-cream cursor-pointer text-[18px]"
          aria-label={drawerOpen ? "Fechar menu" : "Abrir menu"}
        >
          {drawerOpen ? "✕" : "≡"}
        </button>
      </nav>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-ink text-cream pt-[90px] px-8 pb-10">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="font-serif text-[42px] font-light py-[18px] border-b border-cream/[.12] no-underline text-cream hover:text-gold-light tracking-[-0.015em] transition-colors duration-200"
            >
              {link.to === "/servicos" || link.to === "/contactos"
                ? <em className="italic text-gold-light">{link.label}</em>
                : link.label}
            </Link>
          ))}
          <a
            href="https://www.sumupbookings.com/takiuti-studio"
            target="_blank" rel="noopener noreferrer"
            className="font-sans font-semibold uppercase text-[13px] tracking-[0.1em] mt-8 self-start inline-flex items-center gap-2 py-[16px] px-7 rounded-full bg-rose text-cream no-underline hover:bg-rose-deep transition-colors duration-[250ms]"
          >
            Marcar →
          </a>
        </div>
      )}
    </>
  );
};

export default NavBar;
